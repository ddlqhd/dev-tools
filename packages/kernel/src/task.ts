import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { InterventionDecision, InterventionRequest, KernelEvent } from "@devtools/shared";
import { loadConfig, ensureCodeloopDir, type CodeloopConfig } from "./config.js";
import { loadPipeline, snapshotPipeline } from "./pipeline/load.js";
import { createTaskWorktree } from "./git/worktree.js";
import { ArtifactStore, EventLog, KernelStore } from "./store/index.js";
import { PipelineInterpreter } from "./loop/interpreter.js";
import { getEngineAdapter, resolveEngineType } from "./engines/registry.js";
import type { RuntimeConfigView } from "./loop/node.js";

export interface CreateAndRunOptions {
  requirement: string;
  repoPath: string;
  pipeline?: string;
  autoApproveGates?: boolean;
  /** Called when a gate / intervention is needed. Default rejects with error unless autoApprove. */
  onIntervention?: (req: InterventionRequest) => Promise<InterventionDecision>;
  onEvent?: (event: KernelEvent) => void;
  signal?: AbortSignal;
}

export interface TaskRunResult {
  taskId: string;
  status: "completed" | "failed" | "aborted";
  branch: string;
  worktreePath: string;
  error?: string;
}

export async function createAndRunTask(opts: CreateAndRunOptions): Promise<TaskRunResult> {
  const repoPath = opts.repoPath;
  const codeloopRoot = await ensureCodeloopDir(repoPath);
  const config = await loadConfig(repoPath);
  if (opts.autoApproveGates !== undefined) {
    config.autoApproveGates = opts.autoApproveGates;
  }

  const pipelineName = opts.pipeline ?? config.pipeline;
  const pipeline = await loadPipeline(pipelineName, repoPath);

  const taskId = randomUUID().slice(0, 8);
  const store = new KernelStore(codeloopRoot);
  const dirs = await store.ensureTaskDirs(taskId);
  await snapshotPipeline(pipeline, dirs.taskDir);

  const worktreeRoot = join(repoPath, config.git.worktreeRoot);
  const worktree = await createTaskWorktree({
    repoPath,
    worktreeRoot,
    branchPrefix: config.git.branchPrefix,
    taskId,
  });

  const now = new Date().toISOString();
  store.insertTask({
    id: taskId,
    requirement: opts.requirement,
    repo_path: repoPath,
    worktree_path: worktree.worktreePath,
    branch: worktree.branch,
    pipeline_name: pipeline.name,
    pipeline_hash: pipeline.hash,
    status: "created",
    current_node: null,
    loop_state: null,
    error: null,
    created_at: now,
    updated_at: now,
  });

  const events = await EventLog.open(taskId, dirs.taskDir);
  if (opts.onEvent) events.on(opts.onEvent);

  await events.emit("task.created", {
    requirement: opts.requirement,
    pipeline: { name: pipeline.name, hash: pipeline.hash },
    repoPath,
    branch: worktree.branch,
  });

  const artifacts = new ArtifactStore(dirs.artifactsDir);
  const runtimeConfig: RuntimeConfigView = toRuntimeConfig(config);
  const ac = opts.signal ? undefined : new AbortController();
  const signal = opts.signal ?? ac!.signal;

  const interpreter = new PipelineInterpreter({
    taskId,
    requirement: opts.requirement,
    pipeline,
    worktree,
    store,
    events,
    artifacts,
    config: runtimeConfig,
    signal,
    onEvent: opts.onEvent,
    requestIntervention:
      opts.onIntervention ??
      (async (req) => {
        if (runtimeConfig.autoApproveGates && req.kind === "gate") {
          return { action: "approve" };
        }
        throw new Error(
          `Intervention required (${req.kind}) but no handler provided: ${req.summary}`,
        );
      }),
  });

  try {
    const result = await interpreter.run();
    return {
      taskId,
      status: result.status,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      error: result.error,
    };
  } finally {
    store.close();
  }
}

export async function doctor(repoPath?: string): Promise<{
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

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

function toRuntimeConfig(config: CodeloopConfig): RuntimeConfigView {
  return {
    autoApproveGates: config.autoApproveGates,
    skipVerifyIfMissing: config.skipVerifyIfMissing,
    budget: config.budget,
    engines: config.engines,
  };
}

export type { CodeloopConfig, InterventionRequest, InterventionDecision, KernelEvent };
