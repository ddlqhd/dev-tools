import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import which from "../which.js";
import type { EngineChunk, EngineTurnResult, EngineType } from "@devtools/shared";
import {
  EngineError,
  type EngineAdapter,
  type EngineInfo,
  type EngineSession,
  type SessionOptions,
} from "../adapter.js";
import { createCursorStreamState, parseCursorStreamLine } from "./stream.js";

/** Cursor Agent CLI binary. Configurable via CODELOOP_CURSOR_BIN. */
export const CURSOR_BIN = process.env.CODELOOP_CURSOR_BIN ?? "agent";

export class CursorAdapter implements EngineAdapter {
  readonly type: EngineType = "cursor";

  async probe(): Promise<EngineInfo> {
    const binary = await which(CURSOR_BIN);
    if (!binary) {
      return {
        type: "cursor",
        binary: CURSOR_BIN,
        loggedIn: false,
        details: `Command '${CURSOR_BIN}' not found in PATH`,
      };
    }

    const version = await runCapture(binary, ["--version"]);
    const status = await runCapture(binary, ["status"]);
    const loggedIn = /login successful|logged in/i.test(status.stdout + status.stderr);

    return {
      type: "cursor",
      binary,
      version: version.stdout.trim() || version.stderr.trim() || undefined,
      loggedIn,
      details: status.stdout.trim() || status.stderr.trim() || undefined,
    };
  }

  async createSession(opts: SessionOptions): Promise<EngineSession> {
    return new CursorSession(undefined, opts);
  }

  async resumeSession(sessionId: string, opts: SessionOptions): Promise<EngineSession> {
    return new CursorSession(sessionId, opts);
  }
}

class CursorSession implements EngineSession {
  sessionId: string;
  private child: ChildProcess | null = null;
  private interrupted = false;

  constructor(
    sessionId: string | undefined,
    private readonly opts: SessionOptions,
  ) {
    this.sessionId = sessionId ?? "";
  }

  async send(prompt: string, onChunk?: (c: EngineChunk) => void): Promise<EngineTurnResult> {
    this.interrupted = false;
    const signal = this.opts.signal;
    if (signal?.aborted) {
      throw new EngineError("Cursor agent aborted before start");
    }

    const binary = (await which(CURSOR_BIN)) ?? CURSOR_BIN;
    await assertDir(this.opts.cwd);

    const args = buildArgs({
      prompt,
      cwd: this.opts.cwd,
      model: this.opts.model,
      readonly: this.opts.readonly ?? false,
      planMode: this.opts.planMode ?? false,
      artifactWriteOnly: this.opts.artifactWriteOnly ?? false,
      sandbox: this.opts.sandbox ?? "enabled",
      resume: this.sessionId || undefined,
    });

    const state = createCursorStreamState();
    if (this.sessionId) state.sessionId = this.sessionId;

    const idleTimeout = this.opts.idleTimeoutMs ?? 5 * 60_000;
    const nodeTimeout = this.opts.nodeTimeoutMs ?? 30 * 60_000;

    return new Promise<EngineTurnResult>((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...this.opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;

      let settled = false;
      let idleTimer: NodeJS.Timeout | undefined;
      let nodeTimer: NodeJS.Timeout | undefined;
      const stderrChunks: string[] = [];
      let onAbort: (() => void) | undefined;

      const cleanup = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (nodeTimer) clearTimeout(nodeTimer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        this.child = null;
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const succeed = (result: EngineTurnResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      onAbort = () => {
        void this.interrupt().finally(() => {
          fail(new EngineError("Cursor agent aborted"));
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          void this.interrupt().finally(() => {
            fail(new EngineError(`Cursor agent idle timeout (${idleTimeout}ms)`));
          });
        }, idleTimeout);
      };

      nodeTimer = setTimeout(() => {
        void this.interrupt().finally(() => {
          fail(new EngineError(`Cursor agent node timeout (${nodeTimeout}ms)`));
        });
      }, nodeTimeout);

      bumpIdle();

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        bumpIdle();
        const chunks = parseCursorStreamLine(line, state);
        for (const chunk of chunks) onChunk?.(chunk);
        if (state.sessionId) this.sessionId = state.sessionId;
      });

      child.stderr.on("data", (buf: Buffer) => {
        bumpIdle();
        stderrChunks.push(buf.toString("utf8"));
      });

      child.on("error", (err) => {
        fail(new EngineError(`Failed to spawn ${CURSOR_BIN}: ${err.message}`, err));
      });

      child.on("close", (code) => {
        if (settled) return;
        if (this.interrupted) {
          fail(new EngineError("Cursor agent interrupted", undefined, code));
          return;
        }
        if (state.isError) {
          fail(
            new EngineError(
              state.errorMessage ?? "Cursor agent error",
              stderrChunks.join(""),
              code,
            ),
          );
          return;
        }
        if (code !== 0 && !state.finalText) {
          fail(
            new EngineError(
              `Cursor agent exited with code ${code}: ${stderrChunks.join("").trim() || "no stderr"}`,
              undefined,
              code,
            ),
          );
          return;
        }

        const text = state.finalText ?? state.textParts.join("") ?? "";
        if (state.sessionId) this.sessionId = state.sessionId;

        succeed({
          text,
          filesChanged: [...state.filesChanged],
          sessionId: this.sessionId || undefined,
          capturedPlanMarkdown: state.capturedPlanMarkdown,
          capturedReviewJson: state.capturedReviewJson,
          capturedVerifyJson: state.capturedVerifyJson,
        });
      });
    });
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    const child = this.child;
    if (!child || child.killed) return;
    child.kill("SIGINT");
    await sleep(2000);
    if (!child.killed) child.kill("SIGKILL");
  }

  async dispose(): Promise<void> {
    await this.interrupt();
  }
}

function buildArgs(opts: {
  prompt: string;
  cwd: string;
  model?: string;
  readonly: boolean;
  planMode: boolean;
  artifactWriteOnly: boolean;
  sandbox: "enabled" | "disabled";
  resume?: string;
}): string[] {
  // Prompt as positional arg; avoid stdin complexity for M1.
  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--workspace",
    opts.cwd,
  ];

  if (opts.planMode) {
    // Native planning mode: read-only, plan delivered via createPlanToolCall.
    args.push("--mode", "plan");
  } else if (opts.artifactWriteOnly) {
    // Needs Write for `.codeloop-review.json`; the artifact guard reverts the rest.
    args.push("--force");
    args.push("--sandbox", opts.sandbox);
  } else if (opts.readonly) {
    // True read-only review / Q&A.
    args.push("--mode", "ask");
  } else {
    args.push("--force");
    args.push("--sandbox", opts.sandbox);
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.resume) {
    args.push("--resume", opts.resume);
  }

  args.push(opts.prompt);
  return args;
}

async function assertDir(path: string): Promise<void> {
  await access(path, fsConstants.R_OK | fsConstants.X_OK);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runCapture(
  binary: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
      });
    });
    child.on("error", (e) => {
      resolve({ stdout: "", stderr: String(e), code: 1 });
    });
  });
}
