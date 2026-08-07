import { spawn } from "node:child_process";
import type { NodeSpec } from "@devtools/shared";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

export class CommandNodeRunner implements NodeRunner {
  readonly type = "command" as const;

  async run(spec: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    const commands = spec.run ?? [];
    if (commands.length === 0) {
      return { outputs: {}, outcome: { passed: true, skipped: true } };
    }

    const failures: Array<{ command: string; code: number | null; stderr: string }> = [];

    for (const command of commands) {
      const result = await runShell(command, ctx.worktree.worktreePath, ctx.signal);
      await ctx.emit({
        type: "log",
        payload: {
          level: result.code === 0 ? "info" : "warn",
          message: `$ ${command} → exit ${result.code}`,
        },
      });
      if (result.code !== 0) {
        failures.push({ command, code: result.code, stderr: result.stderr });
        if (ctx.config.skipVerifyIfMissing && /not found|ENOENT|no such file/i.test(result.stderr)) {
          continue;
        }
      }
    }

    const passed = failures.length === 0;
    return {
      outputs: {},
      outcome: {
        passed,
        failures,
      },
    };
  }
}

function runShell(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ code: 130, stdout: "", stderr: "aborted" });
      return;
    }
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    const onAbort = () => {
      child.kill("SIGTERM");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.on("error", (e) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code: 127, stdout: "", stderr: String(e) });
    });
  });
}
