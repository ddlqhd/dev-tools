import type {
  EngineChunk,
  EngineTurnResult,
  EngineType,
} from "@devtools/shared";

export type { EngineType };

export interface EngineInfo {
  type: EngineType;
  binary: string;
  version?: string;
  loggedIn: boolean;
  details?: string;
}

export interface SessionOptions {
  cwd: string;
  model?: string;
  /**
   * True for review/ask turns that must not edit the project.
   * Combined with `artifactWriteOnly` for plan turns that may only write `.codeloop-*` files.
   */
  readonly?: boolean;
  /**
   * Plan turns: allow writing orchestrator artifact files (e.g. `.codeloop-plan.md`)
   * without using Cursor `--mode plan` (which forces createPlanToolCall and blocks Write).
   */
  artifactWriteOnly?: boolean;
  allowedTools?: string[];
  env?: Record<string, string>;
  idleTimeoutMs?: number;
  nodeTimeoutMs?: number;
  /** When aborted, in-flight `send` should interrupt the engine subprocess. */
  signal?: AbortSignal;
}

export interface EngineSession {
  readonly sessionId: string;
  send(prompt: string, onChunk?: (c: EngineChunk) => void): Promise<EngineTurnResult>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

/** Thrown when a loop/budget limit suspends the task for human intervention. */
export class SuspendedError extends Error {
  readonly status = "suspended" as const;
  constructor(message: string) {
    super(message);
    this.name = "SuspendedError";
  }
}

export interface EngineAdapter {
  readonly type: EngineType;
  probe(): Promise<EngineInfo>;
  createSession(opts: SessionOptions): Promise<EngineSession>;
  resumeSession(sessionId: string, opts: SessionOptions): Promise<EngineSession>;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly causeError?: unknown,
    readonly exitCode?: number | null,
  ) {
    super(message);
    this.name = "EngineError";
  }
}
