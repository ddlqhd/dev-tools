import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveNodeEngineKey, type EngineChunk, type NodeSpec } from "@devtools/shared";
import { renderPrompt } from "../../prompts/index.js";
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
    const engineKey = resolveNodeEngineKey(spec);
    if (!engineKey) throw new Error("agent node requires an engine alias");

    const prompt = renderPrompt(engineKey, {
      requirement: ctx.task.requirement,
      planDoc: planDoc ?? undefined,
      reviewComments: reviewComments ?? undefined,
      instructions: ctx.instructions,
    }, ctx.config.engines[engineKey]?.prompt);

    let result = await ctx.engine.send(prompt, (chunk: EngineChunk) => {
      void ctx.emit({ type: "engine.chunk", payload: { nodeId: currentNodeId(ctx), chunk } });
    });

    await ctx.emit({
      type: "engine.turn.completed",
      payload: {
        nodeId: currentNodeId(ctx),
        engineType: ctx.engineType,
        usage: result.usage,
        filesChanged: result.filesChanged,
      },
    });

    const outputs: NodeResult["outputs"] = {};

    if (wantsPlanDoc) {
      let planContent = resolvePlanContent(result);

      // One correction turn if the agent never delivered a usable plan.
      if (!planContent) {
        await ctx.emit({
          type: "log",
          payload: {
            level: "warn",
            message: "No plan captured from this turn; asking for the plan again",
          },
        });
        const fixPrompt = [
          "Produce the complete implementation plan now: call the plan tool (CreatePlan),",
          "or, if it is unavailable, put the full plan Markdown in your final message.",
          "It must include sections: Goal, Approach, Files likely to change, Risks, Test plan.",
          "Do NOT implement the change and do NOT modify any file.",
          "",
          `Requirement:\n${ctx.task.requirement}`,
        ].join("\n");
        result = await ctx.engine.send(fixPrompt, (chunk: EngineChunk) => {
          void ctx.emit({
            type: "engine.chunk",
            payload: { nodeId: currentNodeId(ctx), chunk },
          });
        });
        await ctx.emit({
          type: "engine.turn.completed",
          payload: {
            nodeId: currentNodeId(ctx),
            engineType: ctx.engineType,
            usage: result.usage,
            filesChanged: result.filesChanged,
          },
        });
        planContent = resolvePlanContent(result);
      }

      if (!planContent) {
        throw new Error("Plan artifact missing: agent did not deliver a usable plan");
      }

      const saved = await ctx.artifacts.writeText("planDoc", planContent);
      outputs.planDoc = { key: "planDoc", path: saved, kind: "markdown" };
      await ctx.emit({
        type: "artifact.created",
        payload: { artifactId: "planDoc", key: "planDoc", path: saved, kind: "markdown" },
      });
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

function resolvePlanContent(result: {
  text: string;
  capturedPlanMarkdown?: string;
}): string | null {
  // The plan tool only fires when the agent deliberately submits a plan, so its
  // content needs no structural sniffing — just enough substance to be a plan.
  const captured = result.capturedPlanMarkdown?.trim();
  if (captured && captured.length >= 80) return captured;

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
