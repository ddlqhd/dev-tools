import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { KernelClient } from "../kernel-client.js";
import { resolveCodeloopArgv } from "../config.js";

export interface InstanceSpec {
  repoPath: string;
  token?: string;
}

export interface InstanceHandle {
  id: string;
  endpoint: string;
  token?: string;
  pid: number | null;
  process: ChildProcess;
}

export interface InstanceLauncher {
  launch(spec: InstanceSpec): Promise<InstanceHandle>;
  terminate(handle: InstanceHandle): Promise<void>;
  probe(handle: InstanceHandle): Promise<"alive" | "dead">;
}

export class LocalProcessLauncher implements InstanceLauncher {
  constructor(private readonly codeloopBin: string | string[]) {}

  async launch(spec: InstanceSpec): Promise<InstanceHandle> {
    const port = await freePort();
    const token = spec.token;
    const argv = resolveCodeloopArgv(this.codeloopBin);
    const args = [
      ...argv.slice(1),
      "serve",
      "--repo",
      spec.repoPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ];
    if (token) args.push("--token", token);

    const child = spawn(argv[0]!, args, {
      cwd: spec.repoPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      detached: false,
    });

    const id = `inst_${port}_${Date.now().toString(36)}`;
    const endpoint = `http://127.0.0.1:${port}`;
    const handle: InstanceHandle = {
      id,
      endpoint,
      token,
      pid: child.pid ?? null,
      process: child,
    };

    // Wait until health ok (up to 30s)
    const client = new KernelClient(endpoint, token);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`codeloop serve exited early with code ${child.exitCode}`);
      }
      if (await client.health()) return handle;
      await sleep(300);
    }
    child.kill("SIGTERM");
    throw new Error(`codeloop serve failed to become healthy at ${endpoint}`);
  }

  async terminate(handle: InstanceHandle): Promise<void> {
    if (!handle.process.killed) {
      handle.process.kill("SIGTERM");
      await sleep(1500);
      if (!handle.process.killed && handle.process.exitCode === null) {
        handle.process.kill("SIGKILL");
      }
    }
  }

  async probe(handle: InstanceHandle): Promise<"alive" | "dead"> {
    if (handle.process.exitCode !== null) return "dead";
    const client = new KernelClient(handle.endpoint, handle.token);
    return (await client.health()) ? "alive" : "dead";
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
