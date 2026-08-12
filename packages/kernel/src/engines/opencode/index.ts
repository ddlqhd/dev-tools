import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import which from "../which.js";
import type { EngineChunk, EngineTurnResult, EngineType } from "@devtools/shared";
import {
  EngineError,
  type EngineAdapter,
  type EngineInfo,
  type EngineSession,
  type SessionOptions,
} from "../adapter.js";
import { createOpenCodeStreamState, parseOpenCodeStreamLine } from "./stream.js";

/** OpenCode CLI binary. Configurable via CODELOOP_OPENCODE_BIN. */
export const OPENCODE_BIN = process.env.CODELOOP_OPENCODE_BIN ?? "opencode";

const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json");

export class OpenCodeAdapter implements EngineAdapter {
  readonly type: EngineType = "opencode";

  async probe(): Promise<EngineInfo> {
    const binary = await which(OPENCODE_BIN);
    if (!binary) {
      return {
        type: "opencode",
        binary: OPENCODE_BIN,
        loggedIn: false,
        details: `Command '${OPENCODE_BIN}' not found in PATH`,
      };
    }

    const version = await runCapture(binary, ["--version"]);
    const auth = await readAuth();
    const loggedIn = auth.loggedIn;

    return {
      type: "opencode",
      binary,
      version: version.stdout.trim() || version.stderr.trim() || undefined,
      loggedIn,
      details: loggedIn ? `credentials: ${auth.providers}` : auth.details,
    };
  }

  async createSession(opts: SessionOptions): Promise<EngineSession> {
    return new OpenCodeSession(undefined, opts);
  }

  async resumeSession(sessionId: string, opts: SessionOptions): Promise<EngineSession> {
    return new OpenCodeSession(sessionId, opts);
  }
}

class OpenCodeSession implements EngineSession {
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
      throw new EngineError("opencode aborted before start");
    }

    const binary = (await which(OPENCODE_BIN)) ?? OPENCODE_BIN;
    await assertDir(this.opts.cwd);

    const args = buildArgs({
      prompt,
      cwd: this.opts.cwd,
      model: this.opts.model,
      planMode: this.opts.planMode ?? false,
      readonly: this.opts.readonly ?? false,
      artifactWriteOnly: this.opts.artifactWriteOnly ?? false,
      resume: this.sessionId || undefined,
    });

    const state = createOpenCodeStreamState();
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
          fail(new EngineError("opencode aborted"));
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          void this.interrupt().finally(() => {
            fail(new EngineError(`opencode idle timeout (${idleTimeout}ms)`));
          });
        }, idleTimeout);
      };

      nodeTimer = setTimeout(() => {
        void this.interrupt().finally(() => {
          fail(new EngineError(`opencode node timeout (${nodeTimeout}ms)`));
        });
      }, nodeTimeout);

      bumpIdle();

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        bumpIdle();
        const chunks = parseOpenCodeStreamLine(line, state);
        for (const chunk of chunks) onChunk?.(chunk);
        if (state.sessionId) this.sessionId = state.sessionId;
      });

      child.stderr.on("data", (buf: Buffer) => {
        bumpIdle();
        stderrChunks.push(buf.toString("utf8"));
      });

      child.on("error", (err) => {
        fail(new EngineError(`Failed to spawn ${OPENCODE_BIN}: ${err.message}`, err));
      });

      child.on("close", (code) => {
        if (settled) return;
        if (this.interrupted) {
          fail(new EngineError("opencode interrupted", undefined, code));
          return;
        }
        if (state.isError) {
          fail(
            new EngineError(
              state.errorMessage ?? "opencode error",
              stderrChunks.join(""),
              code,
            ),
          );
          return;
        }
        const text = state.finalText ?? state.textParts.join("") ?? "";
        if (code !== 0 && !text) {
          fail(
            new EngineError(
              `opencode exited with code ${code}: ${stderrChunks.join("").trim() || "no stderr"}`,
              undefined,
              code,
            ),
          );
          return;
        }
        if (!text) {
          fail(
            new EngineError(
              `opencode turn ended without a final answer: ${
                stderrChunks.join("").trim() || "no stderr"
              }`,
              undefined,
              code,
            ),
          );
          return;
        }
        if (state.sessionId) this.sessionId = state.sessionId;

        succeed({
          text,
          usage: state.usage,
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
  planMode: boolean;
  readonly: boolean;
  artifactWriteOnly: boolean;
  resume?: string;
}): string[] {
  // Prompt as positional arg; avoid stdin complexity.
  const args: string[] = [
    "run",
    "--format",
    "json",
    "--thinking",
    "--dir",
    opts.cwd,
  ];

  if (opts.planMode) {
    // Native read-only planning agent: edits are denied by its own permissions.
    args.push("--agent", "plan");
  } else if (opts.readonly && !opts.artifactWriteOnly) {
    // True read-only review / Q&A: write/exec tools are denied by permissions.
  } else {
    // Needs Write for orchestrator artifacts (review) or full write mode.
    args.push("--auto");
  }

  if (opts.model) {
    args.push("-m", opts.model);
  }

  if (opts.resume) {
    args.push("--session", opts.resume);
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

async function readAuth(): Promise<{ loggedIn: boolean; providers: string; details?: string }> {
  try {
    const raw = await readFile(AUTH_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const providers = Object.keys(parsed).filter((k) => k !== "version");
    if (providers.length > 0) {
      return { loggedIn: true, providers: providers.join(", ") };
    }
    return { loggedIn: false, providers: "", details: `${AUTH_FILE} has no credentials` };
  } catch (err) {
    const missing = err && typeof err === "object" && "code" in err && err.code === "ENOENT";
    return {
      loggedIn: false,
      providers: "",
      details: missing
        ? `no auth file at ${AUTH_FILE} — run: opencode providers login`
        : err instanceof Error
          ? `cannot read ${AUTH_FILE}: ${err.message}`
          : `cannot read ${AUTH_FILE}`,
    };
  }
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
