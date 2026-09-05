import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import WebSocket from "ws";
import type { InterventionDecision } from "@devtools/shared";
import { isSafeArtifactId, readTaskArtifact } from "./task-artifacts.js";
import { buildPlatformTaskDetail } from "./task-detail.js";
import { listTaskEvents } from "./task-events.js";
import type { PlatformConfig } from "./config.js";
import { PlatformStore } from "./db/store.js";
import { purgePlatformTask } from "./delete-task.js";
import { KernelClient } from "./kernel-client.js";
import { LocalProcessLauncher } from "./launcher/local.js";
import { publicLiveInstance, publicRepo } from "./public.js";
import { formatConfigError, getConfigMeta, loadRepoConfig, parseRepoConfig, saveRepoConfig } from "./repo-config.js";
import { RepoManager } from "./repo-manager.js";
import { Scheduler } from "./scheduler.js";
import { EventSync } from "./sync.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface PlatformApp {
  config: PlatformConfig;
  store: PlatformStore;
  scheduler: Scheduler;
  sync: EventSync;
  close(): Promise<void>;
}

export async function startPlatformServer(config: PlatformConfig): Promise<PlatformApp> {
  const store = new PlatformStore(config.dataDir);
  const repos = new RepoManager(config.reposCache, config.github.token);
  const launcher = new LocalProcessLauncher(config.codeloopBin);

  const hubListeners = new Set<(msg: { type: string; payload: unknown }) => void>();
  const hub = (event: { type: string; payload: unknown }) => {
    for (const l of hubListeners) l(event);
  };

  const sync = new EventSync(store, config, repos, hub, (repoId) => {
    const repo = store.getRepo(repoId);
    return repo?.github_token ?? config.github.token;
  });

  const scheduler = new Scheduler(store, config, repos, launcher, sync, hub);

  const app = Fastify({ logger: true });
  await app.register(websocket);

  // Preserve raw bytes for GitHub webhook HMAC (re-stringified JSON won't match).
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      const buf = body as Buffer;
      req.rawBody = buf;
      if (buf.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(buf.toString("utf8")) as unknown);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.addHook("onRequest", async (req, reply) => {
    if (!config.platformToken) return;
    const path = req.url.split("?")[0] ?? req.url;
    if (path.startsWith("/webhooks/") || path === "/health") return;
    if (!path.startsWith("/api/")) return;
    const auth = req.headers.authorization;
    const qToken = new URL(req.url, "http://localhost").searchParams.get("token");
    if (auth === `Bearer ${config.platformToken}` || qToken === config.platformToken) {
      return;
    }
    return reply.code(401).send({ error: "unauthorized" });
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/repos", async () => ({
    repos: store.listRepos().map(publicRepo),
  }));

  app.post<{
    Body: {
      fullName: string;
      platform?: string;
      triggerLabel?: string;
      maxConcurrency?: number;
      clonePath?: string;
      githubToken?: string;
      defaultBranch?: string;
    };
  }>("/api/repos", async (req, reply) => {
    const fullName = req.body.fullName?.trim();
    if (!fullName || !fullName.includes("/")) {
      return reply.code(400).send({ error: "fullName required as owner/name" });
    }
    const platform = req.body.platform ?? "github";
    if (store.getRepoByFullName(platform, fullName)) {
      return reply.code(409).send({ error: "repo already exists" });
    }
    const clonePath = req.body.clonePath ?? repos.clonePathFor(fullName);
    const now = new Date().toISOString();
    const row = {
      id: randomUUID().slice(0, 8),
      platform,
      full_name: fullName,
      clone_path: clonePath,
      trigger_label: req.body.triggerLabel ?? "ai-dev",
      max_concurrency: req.body.maxConcurrency ?? 1,
      github_token: req.body.githubToken ?? null,
      default_branch: req.body.defaultBranch ?? config.defaultBaseBranch,
      created_at: now,
      updated_at: now,
    };
    store.insertRepo(row);
    try {
      await repos.ensureRepo(fullName, clonePath, row.github_token ?? config.github.token);
    } catch (err) {
      app.log.warn({ err }, "clone deferred");
    }
    const created = store.getRepo(row.id)!;
    return { repo: publicRepo(created) };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/repos/:id",
    async (req, reply) => {
      if (!store.getRepo(req.params.id)) return reply.code(404).send({ error: "not found" });
      const b = req.body;
      store.updateRepo(req.params.id, {
        trigger_label: typeof b.triggerLabel === "string" ? b.triggerLabel : undefined,
        max_concurrency: typeof b.maxConcurrency === "number" ? b.maxConcurrency : undefined,
        clone_path: typeof b.clonePath === "string" ? b.clonePath : undefined,
        github_token: typeof b.githubToken === "string" ? b.githubToken : undefined,
        default_branch: typeof b.defaultBranch === "string" ? b.defaultBranch : undefined,
      });
      return { repo: publicRepo(store.getRepo(req.params.id)!) };
    },
  );

  app.get("/api/config/meta", async () => getConfigMeta());

  app.get<{ Params: { id: string } }>("/api/repos/:id/config", async (req, reply) => {
    const repo = store.getRepo(req.params.id);
    if (!repo) return reply.code(404).send({ error: "not found" });
    try {
      return await loadRepoConfig(repo.clone_path);
    } catch (err) {
      return reply.code(400).send({ error: formatConfigError(err) });
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/repos/:id/config", async (req, reply) => {
    const repo = store.getRepo(req.params.id);
    if (!repo) return reply.code(404).send({ error: "not found" });
    try {
      const parsed = parseRepoConfig(req.body);
      const config = await saveRepoConfig(repo.clone_path, parsed);
      return { config };
    } catch (err) {
      return reply.code(400).send({ error: formatConfigError(err) });
    }
  });

  app.get<{ Querystring: { status?: string; repo?: string } }>("/api/tasks", async (req) => {
    const repoId = req.query.repo
      ? store.getRepoByFullName("github", req.query.repo)?.id
      : undefined;
    return { tasks: store.listTasks({ status: req.query.status, repoId }) };
  });

  app.post<{
    Body: {
      repoId: string;
      title: string;
      requirement: string;
      priority?: number;
      pipeline?: string;
    };
  }>("/api/tasks", async (req, reply) => {
    if (!req.body.repoId || !req.body.requirement) {
      return reply.code(400).send({ error: "repoId and requirement required" });
    }
    const task = await scheduler.enqueueManual({
      repoId: req.body.repoId,
      title: req.body.title || req.body.requirement.slice(0, 72),
      requirement: req.body.requirement,
      priority: req.body.priority,
      pipeline: req.body.pipeline,
    });
    return { task };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const task = store.getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: "not found" });
    let kernel: unknown = null;
    if (task.instance_id && task.kernel_task_id) {
      const inst = store.getInstance(task.instance_id);
      if (inst) {
        try {
          kernel = await new KernelClient(inst.endpoint, inst.token).getTask(task.kernel_task_id);
        } catch {
          kernel = null;
        }
      }
    }
    const repo = store.getRepo(task.repo_id);
    return { task, repo: repo ? publicRepo(repo) : null, kernel };
  });

  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    try {
      await purgePlatformTask(
        { store, sync, hub, log: app.log },
        req.params.id,
      );
      return { ok: true };
    } catch (err) {
      if (err instanceof Error && (err as Error & { statusCode?: number }).statusCode === 404) {
        return reply.code(404).send({ error: "not found" });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/tasks/:id/events",
    async (req, reply) => {
      const task = store.getTask(req.params.id);
      if (!task) return reply.code(404).send({ error: "not found" });
      const repo = store.getRepo(task.repo_id) ?? null;
      return { events: await listTaskEvents(store, task, repo, Number(req.query.after ?? "0")) };
    },
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/detail", async (req, reply) => {
    const task = store.getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: "not found" });
    const fromStore = async () => {
      const repo = store.getRepo(task.repo_id) ?? null;
      return {
        detail: await buildPlatformTaskDetail(task, repo, await listTaskEvents(store, task, repo)),
      };
    };
    if (!task.instance_id || !task.kernel_task_id) return fromStore();
    const inst = store.getInstance(task.instance_id);
    if (!inst) return fromStore();
    try {
      return { detail: await new KernelClient(inst.endpoint, inst.token).detail(task.kernel_task_id) };
    } catch {
      // Instance idle/dead after a successful run — rebuild stages from stored events.
      return fromStore();
    }
  });

  app.get<{ Params: { id: string; artifactId: string } }>(
    "/api/tasks/:id/artifacts/:artifactId",
    async (req, reply) => {
      const task = store.getTask(req.params.id);
      if (!task) return reply.code(404).send({ error: "not found" });
      if (!isSafeArtifactId(req.params.artifactId)) {
        return reply.code(400).send({ error: "invalid artifact id" });
      }
      const repo = store.getRepo(task.repo_id) ?? null;
      if (task.instance_id && task.kernel_task_id) {
        const inst = store.getInstance(task.instance_id);
        if (inst && inst.status !== "dead") {
          try {
            const art = await new KernelClient(inst.endpoint, inst.token).artifact(
              task.kernel_task_id,
              req.params.artifactId,
            );
            if (art) return reply.type(art.contentType).send(art.body);
          } catch {
            // instance idle/dead — try the on-disk artifacts
          }
        }
      }
      if (repo?.clone_path && task.kernel_task_id) {
        const art = await readTaskArtifact(
          repo.clone_path,
          task.kernel_task_id,
          req.params.artifactId,
        );
        if (art) return reply.type(art.contentType).send(art.body);
      }
      return reply.code(404).send({ error: "artifact not found" });
    },
  );

  for (const action of ["pause", "resume", "abort"] as const) {
    app.post<{ Params: { id: string }; Body: { instruction?: string } }>(
      `/api/tasks/:id/${action}`,
      async (req, reply) => {
        const task = store.getTask(req.params.id);
        if (!task?.instance_id || !task.kernel_task_id) {
          return reply.code(400).send({ error: "task not bound to kernel" });
        }
        const inst = store.getInstance(task.instance_id);
        if (!inst) return reply.code(400).send({ error: "instance missing" });
        const client = new KernelClient(inst.endpoint, inst.token);
        if (action === "pause") await client.pause(task.kernel_task_id);
        else if (action === "abort") {
          await client.abort(task.kernel_task_id);
          store.updateTask(task.id, { status: "cancelled" });
          // Event stream may also release; do it here in case WS is down.
          sync.releaseInstance(task.instance_id);
        } else await client.resume(task.kernel_task_id, req.body?.instruction);
        return { ok: true };
      },
    );
  }

  app.post<{ Params: { id: string }; Body: { text: string } }>(
    "/api/tasks/:id/instructions",
    async (req, reply) => {
      const task = store.getTask(req.params.id);
      if (!task?.instance_id || !task.kernel_task_id) {
        return reply.code(400).send({ error: "task not bound to kernel" });
      }
      const inst = store.getInstance(task.instance_id)!;
      await new KernelClient(inst.endpoint, inst.token).inject(
        task.kernel_task_id,
        req.body.text ?? "",
      );
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; reqId: string }; Body: InterventionDecision }>(
    "/api/tasks/:id/interventions/:reqId",
    async (req, reply) => {
      const task = store.getTask(req.params.id);
      if (!task?.instance_id || !task.kernel_task_id) {
        return reply.code(400).send({ error: "task not bound to kernel" });
      }
      const inst = store.getInstance(task.instance_id)!;
      await new KernelClient(inst.endpoint, inst.token).resolveIntervention(
        task.kernel_task_id,
        req.params.reqId,
        req.body,
      );
      store.insertIntervention({
        id: randomUUID(),
        task_id: task.id,
        request_id: req.params.reqId,
        kind: "gate",
        decision: JSON.stringify(req.body),
        decided_by: "web",
        channel: "web",
        created_at: new Date().toISOString(),
        decided_at: new Date().toISOString(),
      });
      if (req.body.action === "approve" || req.body.action === "edit") {
        store.updateTask(task.id, { status: "running", error: null });
        hub({ type: "task.updated", payload: store.getTask(task.id) });
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (req, reply) => {
    const task = store.getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: "not found" });
    if (task.status !== "failed" && task.status !== "cancelled") {
      return reply.code(400).send({ error: "only failed/cancelled can retry" });
    }
    store.updateTask(task.id, {
      status: "queued",
      error: null,
      instance_id: null,
      kernel_task_id: null,
      branch: task.source === "ci-fix" ? task.branch : null,
      retry_count: 0,
      next_retry_at: null,
    });
    void scheduler.tick();
    return { task: store.getTask(task.id) };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req, reply) => {
    const task = store.getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: "not found" });
    if (task.instance_id && task.kernel_task_id) {
      const inst = store.getInstance(task.instance_id);
      if (inst) {
        await new KernelClient(inst.endpoint, inst.token)
          .abort(task.kernel_task_id)
          .catch(() => undefined);
      }
    }
    store.updateTask(task.id, { status: "cancelled" });
    sync.releaseInstance(task.instance_id);
    return { task: store.getTask(task.id) };
  });

  app.get("/api/instances", async () => ({
    instances: store.listLiveInstances().map((row) =>
      publicLiveInstance(
        row,
        row.repo_id ? store.getRepo(row.repo_id) : undefined,
        store.listTasksOnInstance(row.id),
      ),
    ),
  }));

  app.post<{ Params: { id: string } }>("/api/instances/:id/terminate", async (req) => {
    await scheduler.terminateInstance(req.params.id);
    return { ok: true };
  });

  app.post("/webhooks/github", async (req, reply) => {
    if (!config.github.webhookSecret) {
      app.log.warn("github webhook accepted without webhookSecret — set GITHUB_WEBHOOK_SECRET in production");
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
    try {
      await scheduler.handleWebhook(headers, req.body, req.rawBody);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("invalid webhook signature")) {
        return reply.code(401).send({ error: "invalid webhook signature" });
      }
      throw err;
    }
    return { ok: true };
  });

  app.get("/api/stream", { websocket: true }, (socket) => {
    const listener = (msg: { type: string; payload: unknown }) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    hubListeners.add(listener);
    socket.on("close", () => hubListeners.delete(listener));
  });

  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/stream",
    { websocket: true },
    (socket, req) => {
      const task = store.getTask(req.params.id);
      if (!task?.instance_id || !task.kernel_task_id) {
        socket.close(1011, "no kernel");
        return;
      }
      const inst = store.getInstance(task.instance_id);
      if (!inst) {
        socket.close(1011, "no instance");
        return;
      }
      const url = new URL(inst.endpoint);
      const tokenQ = inst.token
        ? `?token=${encodeURIComponent(inst.token)}&verbose=true`
        : "?verbose=true";
      const upstream = new WebSocket(
        `ws://${url.host}/tasks/${task.kernel_task_id}/stream${tokenQ}`,
      );
      upstream.on("message", (data) => {
        if (socket.readyState === socket.OPEN) socket.send(String(data));
      });
      upstream.on("close", () => socket.close());
      upstream.on("error", () => socket.close());
      socket.on("close", () => upstream.close());
    },
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const embeddedWeb = join(here, "web");
  const monorepoWeb = join(here, "../../platform-web/dist");
  const cwdWeb = join(process.cwd(), "packages/platform-web/dist");
  const webPath =
    config.webDist ??
    (existsSync(embeddedWeb)
      ? embeddedWeb
      : existsSync(monorepoWeb)
        ? monorepoWeb
        : cwdWeb);

  if (existsSync(webPath)) {
    await app.register(fastifyStatic, { root: webPath, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/webhooks/")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({
      ok: true,
      message: "platform-server running; build platform-web for UI",
    }));
  }

  // Kill orphaned kernel processes from a previous platform run, then mark dead.
  for (const inst of store.listInstances()) {
    if (inst.status === "busy" || inst.status === "idle" || inst.status === "starting") {
      if (inst.pid != null) {
        try {
          process.kill(inst.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      store.updateInstance(inst.id, { status: "dead" });
    }
  }
  for (const task of store.listTasks()) {
    if (["preparing", "running", "waiting_human", "paused", "delivering"].includes(task.status)) {
      store.updateTask(task.id, {
        status: "failed",
        error: task.error ?? "platform restarted while task was active",
      });
    }
  }

  await app.listen({ host: config.listen.host, port: config.listen.port });
  scheduler.start();

  return {
    config,
    store,
    scheduler,
    sync,
    async close() {
      scheduler.stop();
      sync.stopAll();
      await app.close();
      store.close();
    },
  };
}
