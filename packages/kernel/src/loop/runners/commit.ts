import type { NodeSpec } from "@devtools/shared";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

export class CommitNodeRunner implements NodeRunner {
  readonly type = "commit" as const;

  async run(spec: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    const planDoc = await ctx.artifacts.readText("planDoc");
    const style = spec.messageStyle ?? "conventional";
    const message = buildMessage(ctx.task.requirement, planDoc, style);

    const status = await ctx.worktree.statusPorcelain();
    let sha: string;
    if (!status.trim()) {
      sha = await ctx.worktree.head();
      await ctx.emit({
        type: "log",
        payload: { level: "info", message: "No uncommitted changes; using current HEAD" },
      });
    } else {
      sha = await ctx.worktree.addAllAndCommit(message, "engine");
    }

    await ctx.emit({
      type: "git.commit",
      payload: { sha, message, author: "engine" },
    });

    return {
      outputs: {},
      outcome: { sha, message, branch: ctx.worktree.branch },
    };
  }
}

function buildMessage(requirement: string, planDoc: string | null, style: string): string {
  const firstLine = requirement.split("\n").map((l) => l.trim()).find(Boolean) ?? "codeloop change";
  const summary = firstLine.slice(0, 72);
  if (style === "conventional") {
    const body = planDoc ? `\n\n${planDoc.slice(0, 1500)}` : "";
    return `feat: ${summary}${body}`;
  }
  return summary;
}
