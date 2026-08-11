import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { join, resolve as resolvePath, relative, isAbsolute } from "node:path";
import type { InterventionDecision, KernelEvent } from "@devtools/shared";
import { KernelRuntime } from "../runtime/kernel-runtime.js";
import { ensureCodeloopDir } from "../config.js";
import { renderConsoleHtml } from "./console-html.js";

const MAX_JSON_BODY_BYTES = 1_000_000;

export interface ServeOptions {
  repoPath: string;
  host?: string;
  port?: number;
  token?: string;
}

export interface ServeHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

interface LockFile {
  pid: number;
  host: string;
  port: number;
  token?: string;
  startedAt: string;
}

export async function startKernelServer(opts: ServeOptions): Promise<ServeHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4700;
  const token = opts.token;
  const runtime = await KernelRuntime.open(opts.repoPath);
  runtime.parkInterventionsByDefault = true;
  const codeloopRoot = await ensureCodeloopDir(opts.repoPath);

  const server = createServer((req, res) => {
    void handleHttp(req, res, runtime, token);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (token && !authorize(req, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    void handleWs(ws, req, runtime);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  const lock: LockFile = {
    pid: process.pid,
    host,
    port,
    token,
    startedAt: new Date().toISOString(),
  };
  await writeFile(join(codeloopRoot, "kernel.lock"), JSON.stringify(lock, null, 2), "utf8");

  console.log(`codeloop console UI: http://${host}:${port}/`);

  return {
    url: `http://${host}:${port}`,
    port,
    async close() {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      try {
        await unlink(join(codeloopRoot, "kernel.lock"));
      } catch {
        // ignore
      }
      runtime.close();
    },
  };
}

export async function readKernelLock(repoPath: string): Promise<LockFile | null> {
  const lockPath = join(repoPath, ".codeloop", "kernel.lock");
  let lock: LockFile;
  try {
    const raw = await readFile(lockPath, "utf8");
    lock = JSON.parse(raw) as LockFile;
  } catch {
    return null;
  }

  if (!isPidAlive(lock.pid)) {
    await unlink(lockPath).catch(() => undefined);
    return null;
  }

  try {
    const headers: Record<string, string> = {};
    if (lock.token) headers.authorization = `Bearer ${lock.token}`;
    const res = await fetch(`http://${lock.host}:${lock.port}/health`, {
      headers,
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) throw new Error(`health ${res.status}`);
  } catch {
    await unlink(lockPath).catch(() => undefined);
    return null;
  }

  return lock;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function authorize(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token") === token;
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: KernelRuntime,
  token?: string,
): Promise<void> {
  try {
    if (token && !authorize(req, token)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && (path === "/" || path === "/console")) {
      const html = renderConsoleHtml({ token, repoPath: runtime.repoPath });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
      return;
    }

    if (method === "GET" && path === "/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && path === "/tasks") {
      const body = await readJsonBody<{
        requirement: string;
        repoPath?: string;
        pipeline?: string;
        configOverrides?: {
          autoApproveGates?: boolean;
          inplace?: boolean;
          sandbox?: boolean;
        };
      }>(req);
      if (!body.requirement) {
        json(res, 400, { error: "requirement required" });
        return;
      }
      const handle = await runtime.createTask({
        requirement: body.requirement,
        repoPath: body.repoPath ?? runtime.repoPath,
        pipeline: body.pipeline,
        autoApproveGates: body.configOverrides?.autoApproveGates,
        inplace: body.configOverrides?.inplace,
        sandbox: body.configOverrides?.sandbox,
        parkInterventions: true,
      });
      // Fire and forget — control via API
      void handle.start();
      json(res, 201, { taskId: handle.taskId, branch: handle.getBranch() });
      return;
    }

    if (method === "GET" && path === "/tasks") {
      json(res, 200, { tasks: runtime.listTasks() });
      return;
    }

    const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);
    if (taskMatch && method === "GET") {
      const snap = await runtime.getSnapshot(taskMatch[1]!);
      json(res, 200, snap);
      return;
    }

    const actionMatch = /^\/tasks\/([^/]+)\/(pause|resume|abort)$/.exec(path);
    if (actionMatch && method === "POST") {
      const taskId = actionMatch[1]!;
      const action = actionMatch[2]!;
      const handle = await runtime.attachTask(taskId);
      if (action === "pause") {
        await handle.pause();
        json(res, 200, { ok: true, status: "suspended" });
        return;
      }
      if (action === "abort") {
        await handle.abort();
        json(res, 200, { ok: true, status: "aborted" });
        return;
      }
      const body = await readJsonBody<{ instruction?: string }>(req);
      // Validate + kickoff only; do not await full run
      await handle.kickoffResume(body.instruction);
      json(res, 200, { ok: true, status: "running" });
      return;
    }

    const instrMatch = /^\/tasks\/([^/]+)\/instructions$/.exec(path);
    if (instrMatch && method === "POST") {
      const body = await readJsonBody<{ text: string }>(req);
      const handle = await runtime.attachTask(instrMatch[1]!);
      await handle.inject(body.text ?? "");
      json(res, 200, { ok: true });
      return;
    }

    const intervMatch = /^\/tasks\/([^/]+)\/interventions\/([^/]+)$/.exec(path);
    if (intervMatch && method === "POST") {
      const taskId = intervMatch[1]!;
      const requestId = intervMatch[2]!;
      const body = await readJsonBody<InterventionDecision>(req);
      const handle = await runtime.attachTask(taskId);
      const result = await handle.applyIntervention(requestId, body, {
        resume: true,
        wait: false,
      });
      json(res, 200, result);
      return;
    }

    const eventsMatch = /^\/tasks\/([^/]+)\/events$/.exec(path);
    if (eventsMatch && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const handle = await runtime.attachTask(eventsMatch[1]!);
      const events = await handle.events.readAfter(after);
      json(res, 200, { events });
      return;
    }

    const artMatch = /^\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(path);
    if (artMatch && method === "GET") {
      const taskId = artMatch[1]!;
      const artifactId = artMatch[2]!;
      if (!isSafeArtifactId(artifactId)) {
        json(res, 400, { error: "invalid artifact id" });
        return;
      }
      const task = runtime.store.getTask(taskId);
      if (!task) {
        json(res, 404, { error: "task not found" });
        return;
      }
      const base = resolvePath(runtime.store.taskDir(taskId), "artifacts");
      for (const ext of ["md", "json", "txt"]) {
        const candidate = resolvePath(base, `${artifactId}.${ext}`);
        if (!isPathInside(base, candidate)) {
          json(res, 400, { error: "invalid artifact path" });
          return;
        }
        try {
          const content = await readFile(candidate, "utf8");
          res.writeHead(200, {
            "content-type": ext === "json" ? "application/json" : "text/plain; charset=utf-8",
          });
          res.end(content);
          return;
        } catch {
          // try next
        }
      }
      json(res, 404, { error: "artifact not found" });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleWs(
  ws: WebSocket,
  req: IncomingMessage,
  runtime: KernelRuntime,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const verbose = url.searchParams.get("verbose") !== "false";
  const taskStream = /^\/tasks\/([^/]+)\/stream$/.exec(url.pathname);

  const send = (event: KernelEvent) => {
    if (!verbose && event.type === "engine.chunk") return;
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };

  if (url.pathname === "/stream") {
    const off = runtime.onEvent(send);
    ws.on("close", () => off());
    return;
  }

  if (taskStream) {
    const taskId = taskStream[1]!;
    const handle = await runtime.attachTask(taskId);
    const after = Number(url.searchParams.get("after") ?? "0");
    const history = await handle.events.readAfter(after);
    for (const e of history) send(e);
    const off = handle.onEvent(send);
    ws.on("close", () => off());
    return;
  }

  ws.close(1008, "unknown stream path");
}

function isSafeArtifactId(id: string): boolean {
  return /^[\w.-]+$/.test(id);
}

function isPathInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
