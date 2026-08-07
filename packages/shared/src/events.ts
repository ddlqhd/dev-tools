import type { EngineChunk, EngineTurnUsage } from "./types.js";
import type { ReviewComment } from "./review.js";
import type { InterventionDecision } from "./types.js";

export interface KernelEvent<T = unknown> {
  seq: number;
  taskId: string;
  ts: string;
  type: KernelEventType;
  payload: T;
}

export type KernelEventType =
  | "task.created"
  | "task.started"
  | "task.suspended"
  | "task.resumed"
  | "task.aborted"
  | "task.completed"
  | "task.failed"
  | "node.started"
  | "node.completed"
  | "node.retrying"
  | "loop.iteration"
  | "engine.chunk"
  | "engine.turn.completed"
  | "artifact.created"
  | "git.commit"
  | "review.completed"
  | "intervention.required"
  | "intervention.resolved"
  | "instruction.injected"
  | "budget.warning"
  | "budget.exceeded"
  | "log";

export type LoopStackEntry = { loopId: string; iteration: number };

export interface TaskCreatedPayload {
  requirement: string;
  pipeline: { name: string; hash: string };
  repoPath: string;
  branch: string;
}

export interface NodeStartedPayload {
  nodeId: string;
  primitive: string;
  loopStack: LoopStackEntry[];
}

export interface NodeCompletedPayload {
  nodeId: string;
  outcome: Record<string, unknown>;
  artifactIds: string[];
}

export interface EngineChunkPayload {
  nodeId: string;
  chunk: EngineChunk;
}

export interface EngineTurnCompletedPayload {
  nodeId: string;
  usage?: EngineTurnUsage;
  filesChanged: string[];
}

export interface ReviewCompletedPayload {
  nodeId: string;
  comments: ReviewComment[];
  passed: boolean;
}

export interface InterventionRequiredPayload {
  requestId: string;
  nodeId: string;
  kind: "gate" | "limit" | "error";
  summary: string;
}

export interface InterventionResolvedPayload {
  requestId: string;
  decision: InterventionDecision;
}

export interface LogPayload {
  level: "info" | "warn" | "error" | "debug";
  message: string;
}
