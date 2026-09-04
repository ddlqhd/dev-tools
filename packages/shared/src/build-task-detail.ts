import type {
  ArtifactCreatedPayload,
  EngineChunkPayload,
  EngineTurnCompletedPayload,
  GitCommitPayload,
  KernelEvent,
  KernelEventType,
  NodeCompletedPayload,
  NodeRetryingPayload,
  NodeStartedPayload,
} from "./events.js";
import type { InterventionRequiredPayload, InterventionResolvedPayload } from "./events.js";
import { buildWorkflowView } from "./build-workflow.js";
import type {
  ArtifactFile,
  InterventionRecord,
  StageExecution,
  StageStatus,
  TaskCommitRecord,
  TaskDetail,
  TaskDetailSource,
  UsageTotals,
  WorkflowView,
} from "./task-detail.js";

/**
 * Fold the append-only event log into per-node stages so a run can be traced
 * without a live kernel. Pure function — callers supply the snapshot + events.
 */
export function buildTaskDetail(source: TaskDetailSource, events: KernelEvent[]): TaskDetail {
  const stages: StageExecution[] = [];
  const commits: TaskCommitRecord[] = [];
  const interventions: InterventionRecord[] = [];
  const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, turns: 0 };
  const artifactProducers = new Map<string, { nodeId: string; at: string }>();
  const nodeRuns = new Map<string, number>();
  const openInterventions = new Map<string, InterventionRecord>();

  let current: StageExecution | null = null;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let lastSeq = 0;

  const closeStage = (status: StageStatus, at: string, error?: string): void => {
    if (!current) return;
    current.status = status;
    current.endedAt = at;
    current.durationMs = Math.max(0, Date.parse(at) - Date.parse(current.startedAt));
    if (error) current.error = error;
    current = null;
  };

  for (const event of events) {
    lastSeq = Math.max(lastSeq, event.seq);
    if (current) current.eventRange.to = event.seq;

    switch (event.type) {
      case "task.started":
      case "task.resumed": {
        startedAt ??= event.ts;
        break;
      }

      case "node.started": {
        const p = event.payload as NodeStartedPayload;
        // A stage left open here means the previous run died mid-node.
        closeStage("aborted", event.ts);
        const nodeRun = (nodeRuns.get(p.nodeId) ?? 0) + 1;
        nodeRuns.set(p.nodeId, nodeRun);
        const loopStack = p.loopStack ?? [];
        current = {
          index: stages.length + 1,
          nodeId: p.nodeId,
          primitive: p.primitive,
          engine: p.engine,
          model: p.model,
          loopStack,
          loopLabel: loopStack.length
            ? loopStack.map((l) => `${l.loopId}#${l.iteration}`).join(" / ")
            : undefined,
          nodeRun,
          startedAt: event.ts,
          status: "running",
          artifacts: [],
          commits: [],
          interventions: [],
          toolUseCount: 0,
          filesChanged: [],
          retries: [],
          eventRange: { from: event.seq, to: event.seq },
        };
        stages.push(current);
        break;
      }

      case "node.completed": {
        const p = event.payload as NodeCompletedPayload;
        if (current && current.nodeId === p.nodeId) {
          current.outcome = p.outcome;
          for (const key of p.artifactIds ?? []) addArtifactRef(current, key);
          closeStage("completed", event.ts);
        }
        break;
      }

      case "node.retrying": {
        const p = event.payload as NodeRetryingPayload;
        current?.retries.push({ attempt: p.attempt, error: p.error });
        break;
      }

      case "artifact.created": {
        const p = event.payload as ArtifactCreatedPayload;
        const key = p.key ?? p.artifactId;
        if (!key) break;
        if (current) {
          addArtifactRef(current, key);
          artifactProducers.set(key, { nodeId: current.nodeId, at: event.ts });
        } else {
          artifactProducers.set(key, { nodeId: "-", at: event.ts });
        }
        break;
      }

      case "git.commit": {
        const p = event.payload as GitCommitPayload;
        const record = {
          sha: p.sha,
          message: p.message ?? "",
          author: p.author,
          at: event.ts,
        };
        current?.commits.push(record);
        commits.push({
          ...record,
          nodeId: current?.nodeId,
          stageIndex: current?.index,
        });
        break;
      }

      case "engine.turn.completed": {
        const p = event.payload as EngineTurnCompletedPayload;
        usage.turns += 1;
        if (p.usage) {
          usage.inputTokens += p.usage.inputTokens ?? 0;
          usage.outputTokens += p.usage.outputTokens ?? 0;
          if (p.usage.costUsd != null) usage.costUsd = (usage.costUsd ?? 0) + p.usage.costUsd;
        }
        if (current) {
          const stageUsage = (current.usage ??= { inputTokens: 0, outputTokens: 0, turns: 0 });
          stageUsage.turns += 1;
          stageUsage.inputTokens += p.usage?.inputTokens ?? 0;
          stageUsage.outputTokens += p.usage?.outputTokens ?? 0;
          if (p.usage?.costUsd != null) {
            stageUsage.costUsd = (stageUsage.costUsd ?? 0) + p.usage.costUsd;
          }
          for (const file of p.filesChanged ?? []) addFile(current, file);
        }
        break;
      }

      case "engine.chunk": {
        if (!current) break;
        const chunk = (event.payload as EngineChunkPayload).chunk;
        if (chunk.kind === "toolUse") current.toolUseCount += 1;
        if (chunk.kind === "fileChange") addFile(current, chunk.path);
        break;
      }

      case "intervention.required": {
        const p = event.payload as InterventionRequiredPayload;
        const record: InterventionRecord = {
          requestId: p.requestId,
          nodeId: p.nodeId,
          kind: p.kind,
          summary: p.summary,
          requestedAt: event.ts,
          stageIndex: current?.nodeId === p.nodeId ? current.index : undefined,
        };
        openInterventions.set(p.requestId, record);
        interventions.push(record);
        if (record.stageIndex != null) current?.interventions.push(record);
        break;
      }

      case "intervention.resolved": {
        const p = event.payload as InterventionResolvedPayload;
        const record = openInterventions.get(p.requestId);
        if (record) {
          record.resolvedAt = event.ts;
          record.waitedMs = Math.max(0, Date.parse(event.ts) - Date.parse(record.requestedAt));
          record.decision = p.decision;
          openInterventions.delete(p.requestId);
        }
        break;
      }

      case "task.completed": {
        closeStage("completed", event.ts);
        endedAt = event.ts;
        break;
      }

      case "task.failed": {
        const error = (event.payload as { error?: string }).error;
        closeStage("failed", event.ts, error);
        endedAt = event.ts;
        break;
      }

      case "task.aborted": {
        closeStage("aborted", event.ts);
        endedAt = event.ts;
        break;
      }

      case "task.suspended": {
        closeStage("waiting", event.ts, (event.payload as { reason?: string }).reason);
        break;
      }

      default:
        break;
    }
  }

  // Still-open stage: the run is live, parked at a gate, or the daemon died.
  if (current) {
    current.status = openStageStatus(source.status);
    if (current.status === "failed") current.error ??= source.error ?? undefined;
    current.eventRange.to = lastSeq;
  }

  const diskArtifacts = source.artifacts ?? [];
  const artifacts: ArtifactFile[] = diskArtifacts.map((file) => {
    const producer = artifactProducers.get(file.key);
    return producer
      ? { ...file, producedByNodeId: producer.nodeId, producedAt: producer.at }
      : { ...file };
  });

  const knownExt = new Map(artifacts.map((a) => [a.key, a.ext]));
  for (const stage of stages) {
    for (const ref of stage.artifacts) ref.ext = knownExt.get(ref.key);
  }

  return {
    taskId: source.taskId,
    requirement: source.requirement,
    status: source.status,
    currentNode: source.currentNode,
    error: source.error,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    startedAt,
    endedAt,
    durationMs: startedAt
      ? Math.max(0, Date.parse(endedAt ?? source.updatedAt) - Date.parse(startedAt))
      : undefined,
    pipeline: { name: source.pipeline.name, hash: source.pipeline.hash },
    workflow: buildWorkflowView(
      source.pipeline.name,
      stages,
      source.pipeline.flow,
      source.pipeline.nodes,
    ),
    git: source.git,
    stages,
    artifacts,
    commits,
    interventions,
    usage,
    pendingIntervention: source.pendingIntervention ?? null,
    eventCount: events.length,
    lastSeq,
  };
}

/**
 * Keep a remote fold when it already has a graph or stages.
 * Rebuild only when the payload omitted both (old kernel / empty run).
 */
export function mergeRemoteTaskDetail<T extends { workflow?: WorkflowView; stages: unknown[] }>(
  remote: T,
  fallback: T,
): T {
  if (remote.workflow && remote.workflow.steps.length > 0) return remote;
  if (remote.stages.length > 0) return { ...remote, workflow: fallback.workflow };
  return fallback;
}

/** Parse platform-stored event rows (`payload` is JSON text) into kernel events. */
export function parseStoredKernelEvents(
  rows: Array<{ seq: number; ts: string; type: string; payload: string; task_id?: string; taskId?: string }>,
): KernelEvent[] {
  return rows.map((row) => {
    let payload: unknown = {};
    if (row.payload) {
      try {
        payload = JSON.parse(row.payload);
      } catch {
        payload = {};
      }
    }
    return {
      seq: row.seq,
      taskId: row.taskId ?? row.task_id ?? "",
      ts: row.ts,
      type: row.type as KernelEventType,
      payload,
    };
  });
}

/** Map platform task status onto the kernel statuses `openStageStatus` understands. */
export function kernelStatusFromPlatform(status: string): string {
  switch (status) {
    case "done":
    case "merged":
    case "delivering":
      return "completed";
    case "cancelled":
      return "aborted";
    case "waiting_human":
    case "paused":
      return "suspended";
    case "queued":
    case "preparing":
      return "running";
    default:
      return status;
  }
}

function openStageStatus(taskStatus: string): StageStatus {
  switch (taskStatus) {
    case "suspended":
      return "waiting";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    case "completed":
      return "completed";
    default:
      return "running";
  }
}

function addArtifactRef(stage: StageExecution, key: string): void {
  if (stage.artifacts.some((a) => a.key === key)) return;
  stage.artifacts.push({ key });
}

function addFile(stage: StageExecution, path: string): void {
  if (!path || stage.filesChanged.includes(path)) return;
  stage.filesChanged.push(path);
}
