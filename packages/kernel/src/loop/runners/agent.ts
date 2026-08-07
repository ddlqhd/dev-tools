import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { EngineChunk, NodeSpec } from "@devtools/shared";
import { renderPrompt } from "../../prompts/index.js";
import { assertOnlyAllowedWrites } from "../artifact-guard.js";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

const PLAN_FILE = ".codeloop-plan.md";

export class AgentNodeRunner implements NodeRunner {
  readonly type = "agent" as const;

  async run(spec: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    if (!ctx.engine) throw new Error("agent node requires an engine session");
    const template = spec.promptTemplate ?? "code";
    const planDoc = await ctx.artifacts.readText("planDoc");
    const reviewComments = await ctx.artifacts.readText("reviewComments", "json");
    const wantsPlanDoc =
      template === "plan" || (spec.outputs ?? []).includes("planDoc");

    const prompt = renderPrompt(template, {
      requirement: ctx.task.requirement,
      planDoc: planDoc ?? undefined,
      reviewComments: reviewComments ?? undefined,
      instructions: ctx.instructions,
    });

    if (wantsPlanDoc) {
      try {
        await unlink(join(ctx.worktree.worktreePath, PLAN_FILE));
      } catch {
        // ok
      }
    }

    const preHead = wantsPlanDoc ? await ctx.worktree.head() : null;

    let result = await ctx.engine.send(prompt, (chunk: EngineChunk) => {
      void ctx.emit({ type: "engine.chunk", payload: { nodeId: currentNodeId(ctx), chunk } });
    });

    await ctx.emit({
      type: "engine.turn.completed",
      payload: {
        nodeId: currentNodeId(ctx),
        usage: result.usage,
        filesChanged: result.filesChanged,
      },
    });

    const outputs: NodeResult["outputs"] = {};

    if (wantsPlanDoc) {
      let planContent = await resolvePlanContent(ctx, result);

      // One correction turn if the agent skipped writing a proper plan file.
      if (!planContent) {
        await ctx.emit({
          type: "log",
          payload: {
            level: "warn",
            message: "Plan file missing or invalid; requesting rewrite of .codeloop-plan.md",
          },
        });
        const fixPrompt = [
          `You must write a complete implementation plan using the Write tool to exactly this path: \`${PLAN_FILE}\`.`,
          "Do NOT use CreatePlan / createPlanToolCall.",
          "Do NOT modify any other files.",
          "The Markdown file must include sections: Goal, Approach, Files likely to change, Risks, Test plan.",
          "",
          `Requirement:\n${ctx.task.requirement}`,
        ].join("\n");
        result = await ctx.engine.send(fixPrompt, (chunk: EngineChunk) => {
          void ctx.emit({
            type: "engine.chunk",
            payload: { nodeId: currentNodeId(ctx), chunk },
          });
        });
        planContent = await resolvePlanContent(ctx, result);
      }

      if (!planContent) {
        throw new Error(
          `Plan artifact missing: agent did not write a valid ${PLAN_FILE}`,
        );
      }

      await assertOnlyAllowedWrites(
        ctx.worktree,
        [PLAN_FILE],
        result.filesChanged,
        preHead!,
      );

      const saved = await ctx.artifacts.writeText("planDoc", planContent);
      outputs.planDoc = { key: "planDoc", path: saved, kind: "markdown" };
      await ctx.emit({
        type: "artifact.created",
        payload: { artifactId: "planDoc", key: "planDoc", path: saved, kind: "markdown" },
      });

      // Keep worktree clean of orchestrator temp files for subsequent nodes.
      try {
        await unlink(join(ctx.worktree.worktreePath, PLAN_FILE));
      } catch {
        // ok
      }
    }

    // Intermediate WIP commits keep checkpoints clean; final commit node will squash.
    if (!spec.readonly && !wantsPlanDoc) {
      await cleanOrchestratorTempFiles(ctx.worktree.worktreePath);
      const status = await ctx.worktree.statusPorcelain();
      if (status.trim()) {
        const sha = await ctx.worktree.addAllAndCommit(
          `codeloop: wip ${template}`,
          "engine",
        );
        await ctx.emit({
          type: "git.commit",
          payload: { sha, message: `codeloop: wip ${template}`, author: "engine" },
        });
      }
    }

    return {
      outputs,
      outcome: {
        filesChanged: result.filesChanged,
        textLength: result.text.length,
      },
    };
  }
}

async function resolvePlanContent(
  ctx: NodeContext,
  result: { text: string; capturedPlanMarkdown?: string },
): Promise<string | null> {
  const planPath = join(ctx.worktree.worktreePath, PLAN_FILE);
  try {
    const fromFile = await readFile(planPath, "utf8");
    if (looksLikePlan(fromFile)) return fromFile.trim();
  } catch {
    // missing
  }

  if (result.capturedPlanMarkdown && looksLikePlan(result.capturedPlanMarkdown)) {
    return result.capturedPlanMarkdown.trim();
  }

  // Accept final assistant text only if it already looks like a structured plan,
  // not progress chatter ("正在生成…").
  if (looksLikePlan(result.text)) return result.text.trim();

  return null;
}

export function looksLikePlan(text: string): boolean {
  const t = text.trim();
  if (t.length < 80) return false;
  // Reject pure progress narration
  if (/^(先|正在|我将|I'll |I will |Let me )/i.test(t) && !/^#\s/m.test(t)) {
    return false;
  }
  const hasGoal = /(^#{1,3}\s*Goal\b|^#{1,3}\s*目标\b|\bGoal\b|目标)/im.test(t);
  const hasApproach =
    /(^#{1,3}\s*Approach\b|^#{1,3}\s*(步骤|方案|实现)\b|\bApproach\b|步骤|方案)/im.test(t);
  // Require both structural signals — heading-only or keyword-only is too loose.
  return hasGoal && hasApproach;
}

async function cleanOrchestratorTempFiles(worktreePath: string): Promise<void> {
  for (const name of [PLAN_FILE, ".codeloop-review.json"]) {
    try {
      await unlink(join(worktreePath, name));
    } catch {
      // ok
    }
  }
}

function currentNodeId(ctx: NodeContext): string {
  return (ctx as NodeContext & { _nodeId?: string })._nodeId ?? "unknown";
}
