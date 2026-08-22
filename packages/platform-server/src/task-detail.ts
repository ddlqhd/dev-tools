import {
  buildTaskDetail,
  kernelStatusFromPlatform,
  parseStoredKernelEvents,
  type TaskDetail,
} from "@devtools/shared";
import type { RepoRow, TaskEventRow, TaskRow } from "./db/store.js";

/** Rebuild a task trace from the platform event log when the kernel is gone. */
export function buildPlatformTaskDetail(
  task: TaskRow,
  repo: RepoRow | null,
  events: TaskEventRow[],
): TaskDetail {
  return buildTaskDetail(
    {
      taskId: task.kernel_task_id ?? task.id,
      requirement: task.requirement,
      status: kernelStatusFromPlatform(task.status),
      currentNode: task.current_node,
      error: task.error,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      pipeline: { name: task.pipeline_name ?? "", hash: "" },
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
