import { buildTaskDetail as foldTaskDetail, type KernelEvent, type TaskDetail } from "@devtools/shared";
import { parsePipelineYaml } from "../pipeline/load.js";
import type { TaskSnapshotView } from "../runtime/kernel-runtime.js";

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
