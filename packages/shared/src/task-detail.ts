import type { LoopStackEntry } from "./events.js";
import type { InterventionDecision, InterventionKind, InterventionRequest } from "./types.js";

/** An artifact file on disk under `.codeloop/tasks/<id>/artifacts/`. */
export interface ArtifactFile {
  key: string;
  ext: string;
  size: number;
  mtime: string;
  /** Last stage that wrote this key, when the event log says so. */
  producedByNodeId?: string;
  producedAt?: string;
}

export interface StageArtifactRef {
  key: string;
  /** Absent when the node reported the output but no file survived on disk. */
  ext?: string;
}

export interface CommitRecord {
  sha: string;
  message: string;
  author?: string;
  at: string;
}

export interface TaskCommitRecord extends CommitRecord {
  nodeId?: string;
  stageIndex?: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  turns: number;
}

export interface InterventionRecord {
  requestId: string;
  nodeId: string;
  kind: InterventionKind;
  summary: string;
  requestedAt: string;
  resolvedAt?: string;
  waitedMs?: number;
  decision?: InterventionDecision;
  /** Stage the request belongs to; absent for loop-limit requests. */
  stageIndex?: number;
}

export type StageStatus = "running" | "waiting" | "completed" | "failed" | "aborted";

/** One node execution. A node re-entered by a loop yields one stage per pass. */
export interface StageExecution {
  /** 1-based position in execution order. */
  index: number;
  nodeId: string;
  primitive: string;
  engine?: string;
  model?: string;
  loopStack: LoopStackEntry[];
  /** `reviewLoop#2` when the stage ran inside loops. */
  loopLabel?: string;
  /** 1-based count of how many times this node has run so far. */
  nodeRun: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: StageStatus;
  error?: string;
  outcome?: Record<string, unknown>;
  artifacts: StageArtifactRef[];
  commits: CommitRecord[];
  interventions: InterventionRecord[];
  usage?: UsageTotals;
  toolUseCount: number;
  filesChanged: string[];
  retries: Array<{ attempt: number; error: string }>;
  /** Inclusive seq range in events.jsonl — replay with `GET /tasks/:id/events`. */
  eventRange: { from: number; to: number };
}

export interface TaskDetail {
  taskId: string;
  requirement: string;
  status: string;
  currentNode: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  pipeline: { name: string; hash: string };
  git: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseCommit: string;
    head?: string;
    dirty?: boolean;
    status?: string;
  };
  stages: StageExecution[];
  artifacts: ArtifactFile[];
  commits: TaskCommitRecord[];
  interventions: InterventionRecord[];
  usage: UsageTotals;
  pendingIntervention?: InterventionRequest | null;
  eventCount: number;
  lastSeq: number;
}
