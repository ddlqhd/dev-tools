import type { NodeSpec } from "@devtools/shared";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

export class CommitNodeRunner implements NodeRunner {
  readonly type = "commit" as const;

  async run(spec: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    const planDoc = await ctx.artifacts.readText("planDoc");
    const style = spec.messageStyle ?? "conventional";
    const message = buildMessage(ctx.task.requirement, planDoc, style);

    const sha = await ctx.worktree.squashToBase(message, "engine");

    await ctx.emit({
      type: "git.commit",
      payload: { sha, message: firstLine(message), author: "engine" },
    });
    await ctx.emit({
      type: "log",
      payload: {
        level: "info",
        message: `Squashed onto ${ctx.worktree.baseCommit.slice(0, 8)} → ${sha.slice(0, 8)}`,
      },
    });

    return {
      outputs: {},
      outcome: { sha, message: firstLine(message), branch: ctx.worktree.branch },
    };
  }
}

function firstLine(message: string): string {
  return message.split("\n").find((l) => l.trim()) ?? message;
}

function buildMessage(requirement: string, planDoc: string | null, style: string): string {
  const first =
    requirement.split("\n").map((l) => l.trim()).find(Boolean) ?? "codeloop change";
  const summary = first.slice(0, 72);
  if (style !== "conventional") return summary;

  // Short body from plan Goal section only — avoid dumping the whole plan / chatter.
  const body = extractGoal(planDoc);
  return body ? `feat: ${summary}\n\n${body}` : `feat: ${summary}`;
}

function extractGoal(planDoc: string | null): string | undefined {
  if (!planDoc) return undefined;
  const match = /^##?\s*Goal\s*\n+([\s\S]*?)(?=\n##?\s|\n*$)/im.exec(planDoc);
  const goal = (match?.[1] ?? "").trim();
  if (!goal || goal.length < 8) return undefined;
  return goal.slice(0, 400);
}
