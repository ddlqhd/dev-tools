import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ReviewResultSchema,
  type EngineTurnResult,
  type NodeSpec,
  type ReviewResult,
} from "@devtools/shared";
import { renderPrompt } from "../../prompts/index.js";
import { assertOnlyAllowedWrites } from "../artifact-guard.js";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

const REVIEW_FILE = ".codeloop-review.json";

export class ReviewNodeRunner implements NodeRunner {
  readonly type = "review" as const;

  async run(spec: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    if (!ctx.engine) throw new Error("review node requires an engine session");

    const planDoc = await ctx.artifacts.readText("planDoc");
    const usePlanReview = (spec.outputs ?? []).includes("planComments");

    const prompt = renderPrompt(usePlanReview ? "review-plan" : "review-code", {
      requirement: ctx.task.requirement,
      planDoc: planDoc ?? undefined,
      instructions: ctx.instructions,
    });

    const reviewPath = join(ctx.worktree.worktreePath, REVIEW_FILE);
    try {
      await unlink(reviewPath);
    } catch {
      // ok
    }

    const preHead = await ctx.worktree.head();
    let lastError: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const turnPrompt =
        attempt === 0
          ? prompt
          : [
              `Rewrite the review result using the Write tool to exactly \`${REVIEW_FILE}\`.`,
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

      try {
        await assertOnlyAllowedWrites(
          ctx.worktree,
          [REVIEW_FILE],
          result.filesChanged,
          preHead,
        );

        const raw = await resolveReviewJson(reviewPath, result);
        const parsed = ReviewResultSchema.parse(JSON.parse(raw));
        const gated = applySeverityGate(parsed, spec.severityGate ?? "major");

        const outKey = (spec.outputs ?? ["reviewComments"])[0] ?? "reviewComments";
        const saved = await ctx.artifacts.writeJson(outKey, gated);
        await ctx.emit({
          type: "artifact.created",
          payload: { artifactId: outKey, key: outKey, kind: "json", path: saved },
        });
        await ctx.emit({
          type: "review.completed",
          payload: {
            nodeId: nodeId(ctx),
            comments: gated.comments,
            passed: gated.passed,
          },
        });

        try {
          await unlink(reviewPath);
        } catch {
          // ok
        }

        return {
          outputs: {
            [outKey]: { key: outKey, path: saved, kind: "json" },
          },
          outcome: { passed: gated.passed, commentCount: gated.comments.length },
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // Restore clean worktree before retry when the guard already reset, or on parse errors.
        try {
          await ctx.worktree.resetHard(preHead);
        } catch {
          // ok
        }
      }
    }

    throw new Error(`Review structured output failed after retries: ${lastError}`);
  }
}

async function resolveReviewJson(
  reviewPath: string,
  result: EngineTurnResult,
): Promise<string> {
  try {
    const fromFile = await readFile(reviewPath, "utf8");
    if (looksLikeReviewJson(fromFile)) return fromFile;
  } catch {
    // fall through
  }
  if (result.capturedReviewJson?.trim() && looksLikeReviewJson(result.capturedReviewJson)) {
    await writeFile(reviewPath, result.capturedReviewJson, "utf8");
    return result.capturedReviewJson;
  }
  const extracted = extractJsonObject(result.text);
  if (extracted) {
    await writeFile(reviewPath, extracted, "utf8");
    return extracted;
  }
  throw new Error(`ENOENT: missing ${REVIEW_FILE}`);
}

function looksLikeReviewJson(text: string): boolean {
  try {
    ReviewResultSchema.parse(JSON.parse(text));
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
  // Only accept JSON that already matches the review schema — avoid chatter braces.
  try {
    ReviewResultSchema.parse(JSON.parse(slice));
    return slice;
  } catch {
    return null;
  }
}

function applySeverityGate(
  result: ReviewResult,
  gate: "blocker" | "major" | "minor" | "nit",
): ReviewResult {
  const order = { blocker: 0, major: 1, minor: 2, nit: 3 } as const;
  const threshold = order[gate];
  const blocking = result.comments.filter(
    (c) => c.status === "open" && order[c.severity] <= threshold,
  );
  return {
    ...result,
    passed: blocking.length === 0,
  };
}

function nodeId(ctx: NodeContext): string {
  return (ctx as NodeContext & { _nodeId?: string })._nodeId ?? "unknown";
}
