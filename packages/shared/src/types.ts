export type EngineType = "cursor" | "claude-code" | "codex" | "opencode";

export type EngineChunk =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolUse"; tool: string; summary: string }
  | { kind: "fileChange"; path: string; op: "create" | "edit" | "delete" }
  | { kind: "raw"; type: string; data: unknown };

export interface EngineTurnUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface EngineTurnResult {
  text: string;
  usage?: EngineTurnUsage;
  filesChanged: string[];
  sessionId?: string;
  /** Captured from Cursor createPlanToolCall when the agent did not Write a file. */
  capturedPlanMarkdown?: string;
  /** Captured Write contents for `.codeloop-review.json`. */
  capturedReviewJson?: string;
  /** Captured Write contents for `.codeloop-verify.json`. */
  capturedVerifyJson?: string;
}

export type NodePrimitive =
  | "agent"
  | "review"
  | "gate"
  | "command"
  | "verify"
  | "commit";

export type InterventionDecision =
  | { action: "approve"; auto?: boolean }
  | { action: "reject"; comments: import("./review.js").ReviewComment[]; auto?: boolean }
  /** Approve after replacing the gate's target artifact (e.g. an edited planDoc). */
  | { action: "edit"; content: string; comments?: import("./review.js").ReviewComment[] };

export type InterventionKind = "gate" | "limit" | "error";

export interface InterventionRequest {
  requestId: string;
  nodeId: string;
  kind: InterventionKind;
  summary: string;
  /** Artifact the decision may edit in place (gate with outputs, e.g. planDoc). */
  artifactKey?: string;
  /** Auto-resolve the intervention after this long (parsed from node spec.timeout). */
  timeoutMs?: number;
  /** What to do on timeout; defaults to "reject". */
  timeoutPolicy?: "approve" | "reject";
}
