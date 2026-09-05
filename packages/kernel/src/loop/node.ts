import type {
  InterventionDecision,
  InterventionRequest,
  KernelEvent,
  LoopStackEntry,
  NodePrimitive,
  NodeSpec,
} from "@devtools/shared";
import type { EngineSession } from "../engines/adapter.js";
import type { ArtifactStore } from "../store/index.js";
import type { GitWorktree } from "../git/worktree.js";

export interface ArtifactRef {
  key: string;
  path: string;
  kind: "markdown" | "json" | "text" | "diff";
}

export interface NodeResult {
  outputs: Record<string, ArtifactRef>;
  outcome: Record<string, unknown>;
}

export interface TaskSnapshot {
  id: string;
  requirement: string;
  pipelineName: string;
  pipelineHash: string;
  loopStack: LoopStackEntry[];
  nodeOutcomes: Record<string, Record<string, unknown>>;
}

export interface NodeContext {
  task: TaskSnapshot;
  worktree: GitWorktree;
  artifacts: ArtifactStore;
  engine?: EngineSession;
  engineType?: string;
  instructions: string[];
  emit(event: Omit<KernelEvent, "seq" | "taskId" | "ts"> | { type: KernelEvent["type"]; payload: unknown }): Promise<void>;
  requestIntervention(req: InterventionRequest): Promise<InterventionDecision>;
  signal: AbortSignal;
  config: RuntimeConfigView;
}

export interface RuntimeConfigView {
  autoApproveGates: boolean;
  skipVerifyIfMissing: boolean;
  /** Sandbox write-mode engine turns; verify/commit always run unsandboxed. */
  sandbox: boolean;
  budget: {
    maxEngineCalls: number;
    nodeTimeoutMinutes: number;
  };
  engines: Record<string, { type: string; model?: string; prompt?: string }>;
}

export interface NodeRunner {
  readonly type: NodePrimitive;
  run(spec: NodeSpec, ctx: NodeContext): Promise<NodeResult>;
}

export type { NodeSpec };
