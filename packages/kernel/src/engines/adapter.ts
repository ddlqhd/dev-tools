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
  readonly?: boolean;
  allowedTools?: string[];
  env?: Record<string, string>;
  idleTimeoutMs?: number;
  nodeTimeoutMs?: number;
}

export interface EngineSession {
  readonly sessionId: string;
  send(prompt: string, onChunk?: (c: EngineChunk) => void): Promise<EngineTurnResult>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
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
