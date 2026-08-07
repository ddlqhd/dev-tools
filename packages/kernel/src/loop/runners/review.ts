import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ReviewResultSchema, type NodeSpec, type ReviewResult } from "@devtools/shared";
import { renderPrompt } from "../../prompts/index.js";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

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

    const reviewPath = join(ctx.worktree.worktreePath, ".codeloop-review.json");
    try {
      await unlink(reviewPath);
    } catch {
      // ok
    }

    let lastError: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const turnPrompt =
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous output was invalid JSON (${lastError}). Rewrite \`.codeloop-review.json\` with valid JSON only.`;

      await ctx.engine.send(turnPrompt, (chunk) => {
        void ctx.emit({
          type: "engine.chunk",
          payload: { nodeId: nodeId(ctx), chunk },
        });
      });

      try {
        const raw = await readFile(reviewPath, "utf8");
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

        return {
          outputs: {
            [outKey]: { key: outKey, path: saved, kind: "json" },
          },
          outcome: { passed: gated.passed, commentCount: gated.comments.length },
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    throw new Error(`Review structured output failed after retries: ${lastError}`);
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
