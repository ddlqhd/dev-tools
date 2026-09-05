import type { PlatformTaskStatus } from "./platform.js";

export type TaskControlAction =
  | "pause"
  | "resume"
  | "abort"
  | "cancel"
  | "retry"
  | "inject"
  | "approve"
  | "reject"
  | "edit"
  | "delete";

export interface TaskActionContext {
  status: PlatformTaskStatus;
  bound: boolean;
  kernelStatus: string | null;
  hasPendingIntervention: boolean;
}

const CANCELABLE: ReadonlySet<PlatformTaskStatus> = new Set([
  "queued",
  "preparing",
  "running",
  "paused",
  "waiting_human",
  "delivering",
]);

const ABORTABLE: ReadonlySet<PlatformTaskStatus> = new Set([
  "preparing",
  "running",
  "paused",
  "waiting_human",
  "delivering",
]);

const RETRYABLE: ReadonlySet<PlatformTaskStatus> = new Set(["failed", "cancelled"]);

const ACTIVE_PLATFORM: ReadonlySet<PlatformTaskStatus> = new Set(["running", "waiting_human"]);

/** Operator pause reasons from kernel `task.suspended` (e.g. `"paused"`, `"paused by …"`). */
export function isOperatorPauseReason(reason: string): boolean {
  return reason === "paused" || reason.startsWith("paused ");
}

export function platformStatusAfterSuspended(reason: string): "paused" | "waiting_human" {
  return isOperatorPauseReason(reason) ? "paused" : "waiting_human";
}

/** Infer action context for board cards without a live kernel snapshot. */
export function boardActionContext(task: {
  status: PlatformTaskStatus;
  instance_id: string | null;
  kernel_task_id: string | null;
}): TaskActionContext {
  const bound = !!(task.instance_id && task.kernel_task_id);
  let kernelStatus: string | null = null;
  if (task.status === "paused") kernelStatus = "suspended";
  else if (task.status === "running" || task.status === "preparing") kernelStatus = "running";
  return {
    status: task.status,
    bound,
    kernelStatus,
    hasPendingIntervention: task.status === "waiting_human",
  };
}

export function taskActionsEnabled(
  ctx: TaskActionContext,
): Record<TaskControlAction, boolean> {
  const { status, bound, kernelStatus, hasPendingIntervention } = ctx;
  const enabled: Record<TaskControlAction, boolean> = {
    pause: false,
    resume: false,
    abort: false,
    cancel: false,
    retry: false,
    inject: false,
    approve: false,
    reject: false,
    edit: false,
    delete: true,
  };

  if (CANCELABLE.has(status)) enabled.cancel = true;
  if (RETRYABLE.has(status)) enabled.retry = true;

  if (bound && ABORTABLE.has(status)) enabled.abort = true;

  if (
    bound &&
    (kernelStatus === "running" ||
      (kernelStatus === "suspended" && hasPendingIntervention) ||
      (kernelStatus === null && ACTIVE_PLATFORM.has(status)))
  ) {
    enabled.pause = true;
  }

  if (
    (bound &&
      !hasPendingIntervention &&
      (kernelStatus === "suspended" || kernelStatus === "failed")) ||
    (status === "paused" && bound)
  ) {
    enabled.resume = true;
  }

  if (
    bound &&
    !hasPendingIntervention &&
    ACTIVE_PLATFORM.has(status) &&
    (kernelStatus === "running" || kernelStatus === null)
  ) {
    enabled.inject = true;
  }

  if (bound && hasPendingIntervention) {
    enabled.approve = true;
    enabled.reject = true;
    enabled.edit = true;
  }

  return enabled;
}
