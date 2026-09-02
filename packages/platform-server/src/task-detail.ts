import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPipeline, parsePipelineYaml } from "@devtools/kernel";
import {
  buildTaskDetail,
  kernelStatusFromPlatform,
  parseStoredKernelEvents,
  type FlowStep,
  type NodeSpec,
  type TaskDetail,
} from "@devtools/shared";
import type { RepoRow, TaskEventRow, TaskRow } from "./db/store.js";

const PIPELINE_CACHE_TTL_MS = 5_000;

type PipelineGraph = { hash: string; flow: FlowStep[]; nodes: Record<string, NodeSpec> };

const pipelineCache = new Map<string, PipelineGraph & { expires: number }>();

/** Rebuild a task trace from the platform event log when the kernel is gone. */
export async function buildPlatformTaskDetail(
  task: TaskRow,
  repo: RepoRow | null,
  events: TaskEventRow[],
): Promise<TaskDetail> {
  const graph = await loadPipelineGraph(task.pipeline_name, repo?.clone_path, task.kernel_task_id);
  return buildTaskDetail(
    {
      taskId: task.kernel_task_id ?? task.id,
      requirement: task.requirement,
      status: kernelStatusFromPlatform(task.status),
      currentNode: task.current_node,
      error: task.error,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      pipeline: {
        name: task.pipeline_name ?? "",
        hash: graph?.hash ?? "",
        flow: graph?.flow,
        nodes: graph?.nodes,
      },
      git: {
        repoPath: repo?.clone_path ?? "",
        worktreePath: "",
        branch: task.branch ?? "",
        baseCommit: "",
      },
      artifacts: [],
      pendingIntervention: null,
    },
    parseStoredKernelEvents(events),
  );
}

async function loadPipelineGraph(
  name: string | null,
  repoPath: string | undefined,
  kernelTaskId: string | null,
): Promise<PipelineGraph | undefined> {
  if (repoPath && kernelTaskId) {
    try {
      const raw = await readFile(
        join(repoPath, ".codeloop", "tasks", kernelTaskId, "pipeline.snapshot.yaml"),
        "utf8",
      );
      const loaded = parsePipelineYaml(raw);
      return { hash: loaded.hash, flow: loaded.flow, nodes: loaded.nodes };
    } catch {
      // snapshot missing — fall through to the live definition
    }
  }
  if (!name || !repoPath) return undefined;
  const key = `${repoPath}\0${name}`;
  const now = Date.now();
  const hit = pipelineCache.get(key);
  if (hit && hit.expires > now) return hit;
  try {
    const loaded = await loadPipeline(name, repoPath);
    const entry = {
      expires: now + PIPELINE_CACHE_TTL_MS,
      hash: loaded.hash,
      flow: loaded.flow,
      nodes: loaded.nodes,
    };
    pipelineCache.set(key, entry);
    return entry;
  } catch {
    return undefined;
  }
}
