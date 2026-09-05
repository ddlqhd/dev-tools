import { buildTaskDetail as foldTaskDetail, type KernelEvent, type TaskDetail } from "@devtools/shared";
import { parsePipelineYaml } from "../pipeline/load.js";
import { KernelRuntime } from "../runtime/kernel-runtime.js";
import type { TaskSnapshotView } from "../runtime/kernel-runtime.js";
import { EventLog } from "../store/index.js";

/**
 * Fold the append-only event log into per-node stages so a run can be traced
 * without reading raw JSONL. Thin adapter over the shared folder.
 */
export function buildTaskDetail(snapshot: TaskSnapshotView, events: KernelEvent[]): TaskDetail {
  const { task } = snapshot;
  return foldTaskDetail(
    {
      taskId: task.id,
      requirement: task.requirement,
      status: task.status,
      currentNode: task.current_node,
      error: task.error,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      pipeline: pipelineSource(snapshot),
      git: {
        repoPath: task.repo_path,
        worktreePath: task.worktree_path,
        branch: task.branch,
        baseCommit: task.base_commit,
        head: snapshot.git?.head,
        dirty: snapshot.git ? snapshot.git.status.trim().length > 0 : undefined,
        status: snapshot.git?.status,
      },
      artifacts: snapshot.artifacts,
      pendingIntervention: snapshot.pendingIntervention ?? null,
      paths: snapshot.paths,
    },
    events,
  );
}

function pipelineSource(snapshot: TaskSnapshotView): {
  name: string;
  hash: string;
  flow?: ReturnType<typeof parsePipelineYaml>["flow"];
  nodes?: ReturnType<typeof parsePipelineYaml>["nodes"];
} {
  const name = snapshot.pipeline?.name ?? snapshot.task.pipeline_name;
  const hash = snapshot.pipeline?.hash ?? snapshot.task.pipeline_hash;
  if (!snapshot.pipeline?.rawYaml) return { name, hash };
  try {
    const loaded = parsePipelineYaml(snapshot.pipeline.rawYaml);
    return { name, hash, flow: loaded.flow, nodes: loaded.nodes };
  } catch {
    return { name, hash };
  }
}

/** Fold snapshot + events.jsonl. Does not attach a live runner or require a worktree. */
export async function readTaskDetail(
  runtime: KernelRuntime,
  taskId: string,
): Promise<{ detail: TaskDetail; events: KernelEvent[] }> {
  const snap = await runtime.getSnapshot(taskId);
  const log = await EventLog.open(taskId, runtime.store.taskDir(taskId));
  const events = await log.readAfter(0);
  return { detail: buildTaskDetail(snap, events), events };
}

/** Open a repo's kernel store, fold the task, then close. */
export async function loadTaskDetail(
  repoPath: string,
  taskId: string,
): Promise<{ detail: TaskDetail; events: KernelEvent[] }> {
  const runtime = await KernelRuntime.open(repoPath);
  try {
    return await readTaskDetail(runtime, taskId);
  } finally {
    runtime.close();
  }
}
