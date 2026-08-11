import type {
  ArtifactCreatedPayload,
  ArtifactFile,
  EngineChunkPayload,
  EngineTurnCompletedPayload,
  GitCommitPayload,
  InterventionRecord,
  InterventionRequiredPayload,
  InterventionResolvedPayload,
  KernelEvent,
  NodeCompletedPayload,
  NodeRetryingPayload,
  NodeStartedPayload,
  StageExecution,
  StageStatus,
  TaskCommitRecord,
  TaskDetail,
  UsageTotals,
} from "@devtools/shared";
import type { TaskSnapshotView } from "../runtime/kernel-runtime.js";

/**
 * Fold the append-only event log into per-node stages so a run can be traced
 * without reading raw JSONL. Pure function — the HTTP layer supplies the data.
 */
export function buildTaskDetail(snapshot: TaskSnapshotView, events: KernelEvent[]): TaskDetail {
  const { task } = snapshot;
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
    current.status = openStageStatus(task.status);
    if (current.status === "failed") current.error ??= task.error ?? undefined;
    current.eventRange.to = lastSeq;
  }

  const artifacts: ArtifactFile[] = snapshot.artifacts.map((file) => {
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
    taskId: task.id,
    requirement: task.requirement,
    status: task.status,
    currentNode: task.current_node,
    error: task.error,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    startedAt,
    endedAt,
    // Still running: measure up to the last write so the page can show elapsed time.
    durationMs: startedAt
      ? Math.max(0, Date.parse(endedAt ?? task.updated_at) - Date.parse(startedAt))
      : undefined,
    pipeline: {
      name: snapshot.pipeline?.name ?? task.pipeline_name,
      hash: snapshot.pipeline?.hash ?? task.pipeline_hash,
    },
    git: {
      repoPath: task.repo_path,
      worktreePath: task.worktree_path,
      branch: task.branch,
      baseCommit: task.base_commit,
      head: snapshot.git?.head,
      dirty: snapshot.git ? snapshot.git.status.trim().length > 0 : undefined,
      status: snapshot.git?.status,
    },
    stages,
    artifacts,
    commits,
    interventions,
    usage,
    pendingIntervention: snapshot.pendingIntervention ?? null,
    eventCount: events.length,
    lastSeq,
  };
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
