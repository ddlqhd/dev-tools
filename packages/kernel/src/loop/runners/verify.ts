import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  VerifyResultSchema,
  type EngineTurnResult,
  type NodeSpec,
  type VerifyResult,
} from "@devtools/shared";
import { renderPrompt } from "../../prompts/index.js";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

const VERIFY_FILE = ".codeloop-verify.json";
const MAX_ATTEMPTS = 3;

/**
 * Verification is delegated to an agent: it works out how this project is
 * checked and runs those checks itself, instead of the pipeline hardcoding
 * commands. The structured report drives the `onFail` loop-back.
 */
export class VerifyNodeRunner implements NodeRunner {
  readonly type = "verify" as const;

  async run(spec: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    if (!ctx.engine) throw new Error("verify node requires an engine session");

    const planDoc = await ctx.artifacts.readText("planDoc");
    const prompt = renderPrompt(spec.promptTemplate ?? "verify", {
      requirement: ctx.task.requirement,
      planDoc: planDoc ?? undefined,
      instructions: ctx.instructions,
    });

    const verifyPath = join(ctx.worktree.worktreePath, VERIFY_FILE);
    await remove(verifyPath);

    const preHead = await ctx.worktree.head();
    let lastError: string | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const turnPrompt =
        attempt === 0
          ? prompt
          : [
              `Rewrite the verification result using the Write tool to exactly \`${VERIFY_FILE}\`.`,
              "Valid JSON only. Do not modify any other files.",
              `Previous error: ${lastError}`,
              "",
              prompt,
            ].join("\n");

      const result = await ctx.engine.send(turnPrompt, (chunk) => {
        void ctx.emit({
          type: "engine.chunk",
          payload: { nodeId: nodeId(ctx), chunk },
        });
      });
      await ctx.emit({
        type: "engine.turn.completed",
        payload: {
          nodeId: nodeId(ctx),
          engineType: ctx.engineType,
          usage: result.usage,
          filesChanged: result.filesChanged,
        },
      });

      let parsed: VerifyResult;
      try {
        const raw = await resolveVerifyJson(verifyPath, result);
        parsed = VerifyResultSchema.parse(JSON.parse(raw));
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      } finally {
        // The verify agent runs real tooling, which may leave build output or
        // stray edits behind. Its report is the only thing we keep.
        await restore(ctx, preHead);
      }

      // A failure with nothing to act on would loop back to review empty-handed.
      const failures =
        parsed.passed || parsed.failures.length > 0
          ? parsed.failures
          : [{ check: "verification", detail: parsed.summary }];

      const outKey = (spec.outputs ?? ["verifyReport"])[0] ?? "verifyReport";
      const saved = await ctx.artifacts.writeJson(outKey, { ...parsed, failures });
      await ctx.emit({
        type: "artifact.created",
        payload: { artifactId: outKey, key: outKey, kind: "json", path: saved },
      });
      await ctx.emit({
        type: "log",
        payload: {
          level: parsed.passed ? "info" : "warn",
          message: `verify ${parsed.passed ? "passed" : "failed"} (${
            parsed.checksRun.join(", ") || "no checks"
          }): ${parsed.summary}`,
        },
      });

      return {
        outputs: {
          [outKey]: { key: outKey, path: saved, kind: "json" },
        },
        // `failures` as an array is what the interpreter's onFail handling keys on.
        outcome: {
          passed: parsed.passed,
          summary: parsed.summary,
          checksRun: parsed.checksRun,
          failures,
        },
      };
    }

    throw new Error(`Verify structured output failed after retries: ${lastError}`);
  }
}

async function resolveVerifyJson(
  verifyPath: string,
  result: EngineTurnResult,
): Promise<string> {
  try {
    const fromFile = await readFile(verifyPath, "utf8");
    if (looksLikeVerifyJson(fromFile)) return fromFile;
  } catch {
    // fall through
  }
  if (result.capturedVerifyJson?.trim() && looksLikeVerifyJson(result.capturedVerifyJson)) {
    return result.capturedVerifyJson;
  }
  const extracted = extractJsonObject(result.text);
  if (extracted) return extracted;
  throw new Error(`ENOENT: missing ${VERIFY_FILE}`);
}

function looksLikeVerifyJson(text: string): boolean {
  try {
    VerifyResultSchema.parse(JSON.parse(text));
    return true;
  } catch {
    return false;
  }
}

function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const slice = candidate.slice(start, end + 1);
  return looksLikeVerifyJson(slice) ? slice : null;
}

async function restore(ctx: NodeContext, preHead: string): Promise<void> {
  try {
    await ctx.worktree.resetHard(preHead);
  } catch {
    // best effort — the commit stage re-checks worktree state
  }
  await remove(join(ctx.worktree.worktreePath, VERIFY_FILE));
}

async function remove(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ok
  }
}

function nodeId(ctx: NodeContext): string {
  return (ctx as NodeContext & { _nodeId?: string })._nodeId ?? "unknown";
}
