import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { InterventionDecision, InterventionRequest, KernelEvent } from "@devtools/shared";
import { loadConfig, ensureCodeloopDir } from "./config.js";
import { KernelStore } from "./store/index.js";
import { getEngineAdapter, resolveEngineType } from "./engines/registry.js";
import { KernelRuntime } from "./runtime/kernel-runtime.js";

const execFileAsync = promisify(execFile);

const MIN_NODE = { major: 22, minor: 13 };

function parseNodeVersion(v: string): { major: number; minor: number; patch: number } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function nodeVersionOk(v: string): boolean {
  const parsed = parseNodeVersion(v);
  if (!parsed) return false;
  if (parsed.major > MIN_NODE.major) return true;
  if (parsed.major < MIN_NODE.major) return false;
  return parsed.minor >= MIN_NODE.minor;
}

export interface CreateAndRunOptions {
  requirement: string;
  repoPath: string;
  pipeline?: string;
  autoApproveGates?: boolean;
  onIntervention?: (req: InterventionRequest) => Promise<InterventionDecision>;
  onEvent?: (event: KernelEvent) => void;
  signal?: AbortSignal;
}

export interface TaskRunResult {
  taskId: string;
  status: "completed" | "failed" | "aborted" | "suspended";
  branch: string;
  worktreePath: string;
  error?: string;
}

export async function createAndRunTask(opts: CreateAndRunOptions): Promise<TaskRunResult> {
  const runtime = await KernelRuntime.open(opts.repoPath);
  try {
    const handle = await runtime.createTask({
      requirement: opts.requirement,
      repoPath: opts.repoPath,
      pipeline: opts.pipeline,
      autoApproveGates: opts.autoApproveGates,
      onEvent: opts.onEvent,
    });

    if (opts.onIntervention) {
      handle.setInterventionHandler(opts.onIntervention);
    }

    const onAbort = () => {
      void handle.abort();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const result = await handle.start();
    opts.signal?.removeEventListener("abort", onAbort);

    return {
      taskId: handle.taskId,
      status: result.status as TaskRunResult["status"],
      branch: handle.getBranch(),
      worktreePath: handle.getWorktreePath(),
      error: result.error,
    };
  } finally {
    runtime.close();
  }
}

export async function doctor(repoPath?: string): Promise<{
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const nodeVer = process.versions.node;
  checks.push({
    name: "node",
    ok: nodeVersionOk(nodeVer),
    detail: nodeVersionOk(nodeVer)
      ? `v${nodeVer}`
      : `v${nodeVer} (need >= ${MIN_NODE.major}.${MIN_NODE.minor} for node:sqlite)`,
  });

  try {
    const sqlite = await import("node:sqlite");
    checks.push({
      name: "node-sqlite",
      ok: typeof sqlite.DatabaseSync === "function",
      detail:
        typeof sqlite.DatabaseSync === "function"
          ? "node:sqlite available"
          : "DatabaseSync missing",
    });
  } catch (err) {
    checks.push({
      name: "node-sqlite",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    checks.push({
      name: "git",
      ok: true,
      detail: stdout.trim(),
    });
  } catch {
    checks.push({
      name: "git",
      ok: false,
      detail: "git not found in PATH",
    });
  }

  const adapter = getEngineAdapter("cursor");
  const info = await adapter.probe();
  checks.push({
    name: "cursor-cli",
    ok: Boolean(info.version),
    detail: info.version
      ? `${info.binary} ${info.version}`
      : info.details ?? "agent not found",
  });
  checks.push({
    name: "cursor-login",
    ok: info.loggedIn,
    detail: info.details ?? (info.loggedIn ? "logged in" : "not logged in — run: agent login"),
  });

  if (repoPath) {
    try {
      const config = await loadConfig(repoPath);
      checks.push({
        name: "config",
        ok: true,
        detail: `pipeline=${config.pipeline}, engine=${config.engines.default?.type}`,
      });
      const engineType = resolveEngineType(config.engines.default?.type ?? "cursor");
      checks.push({
        name: "default-engine",
        ok: engineType === "cursor",
        detail: engineType,
      });
      await ensureCodeloopDir(repoPath);
    } catch (err) {
      checks.push({
        name: "config",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export function listTasks(repoPath: string) {
  const store = new KernelStore(join(repoPath, ".codeloop"));
  try {
    return store.listTasks();
  } finally {
    store.close();
  }
}

export function getTask(repoPath: string, taskId: string) {
  const store = new KernelStore(join(repoPath, ".codeloop"));
  try {
    return store.getTask(taskId);
  } finally {
    store.close();
  }
}

export type { InterventionRequest, InterventionDecision, KernelEvent };
