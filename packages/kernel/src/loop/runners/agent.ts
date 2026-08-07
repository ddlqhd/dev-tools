import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { NodeSpec } from "@devtools/shared";
import type { EngineChunk } from "@devtools/shared";
import { renderPrompt } from "../../prompts/index.js";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

export class AgentNodeRunner implements NodeRunner {
  readonly type = "agent" as const;

  async run(spec: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    if (!ctx.engine) throw new Error("agent node requires an engine session");
    const template = spec.promptTemplate ?? "code";
    const planDoc = await ctx.artifacts.readText("planDoc");
    const reviewComments = await ctx.artifacts.readText("reviewComments", "json");

    const prompt = renderPrompt(template, {
      requirement: ctx.task.requirement,
      planDoc: planDoc ?? undefined,
      reviewComments: reviewComments ?? undefined,
      instructions: ctx.instructions,
    });

    // Clean leftover plan marker from previous runs in worktree if any
    if (template === "plan") {
      try {
        await unlink(join(ctx.worktree.worktreePath, ".codeloop-plan.md"));
      } catch {
        // ok
      }
    }

    const result = await ctx.engine.send(prompt, (chunk: EngineChunk) => {
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

    if (template === "plan" || (spec.outputs ?? []).includes("planDoc")) {
      const planPath = join(ctx.worktree.worktreePath, ".codeloop-plan.md");
      let planContent: string | null = null;
      try {
        planContent = await readFile(planPath, "utf8");
      } catch {
        planContent = result.text;
      }
      const saved = await ctx.artifacts.writeText("planDoc", planContent);
      outputs.planDoc = { key: "planDoc", path: saved, kind: "markdown" };
      await ctx.emit({
        type: "artifact.created",
        payload: { artifactId: "planDoc", key: "planDoc", kind: "markdown", path: saved },
      });
    }

    // Commit intermediate code changes so checkpoint is clean
    if (!spec.readonly) {
      const status = await ctx.worktree.statusPorcelain();
      if (status.trim()) {
        const sha = await ctx.worktree.addAllAndCommit(
          `codeloop: ${template} node`,
          "engine",
        );
        await ctx.emit({
          type: "git.commit",
          payload: { sha, message: `codeloop: ${template} node`, author: "engine" },
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

function currentNodeId(ctx: NodeContext): string {
  // Interpreter sets this on task snapshot via a side channel; fall back.
  return (ctx as NodeContext & { _nodeId?: string })._nodeId ?? "unknown";
}
