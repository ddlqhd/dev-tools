import { randomUUID } from "node:crypto";
import type { NodeSpec } from "@devtools/shared";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

export class GateNodeRunner implements NodeRunner {
  readonly type = "gate" as const;

  async run(_spec: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    if (ctx.config.autoApproveGates) {
      await ctx.emit({
        type: "log",
        payload: { level: "info", message: "Gate auto-approved (--no-gate / autoApproveGates)" },
      });
      return { outputs: {}, outcome: { approved: true, auto: true } };
    }

    const requestId = randomUUID();
    const decision = await ctx.requestIntervention({
      requestId,
      nodeId: nodeId(ctx),
      kind: "gate",
      summary: "Approval required before continuing",
    });

    await ctx.emit({
      type: "intervention.resolved",
      payload: { requestId, decision },
    });

    if (decision.action === "approve") {
      return { outputs: {}, outcome: { approved: true } };
    }
    if (decision.action === "edit") {
      const status = await ctx.worktree.statusPorcelain();
      if (status.trim()) {
        const sha = await ctx.worktree.addAllAndCommit(
          `codeloop: human edit — ${decision.note}`,
          "human",
        );
        await ctx.emit({
          type: "git.commit",
          payload: { sha, message: decision.note, author: "human" },
        });
      }
      return { outputs: {}, outcome: { approved: true, edited: true } };
    }

    // reject → signal outcome for potential loop re-entry (interpreter may handle later)
    return {
      outputs: {},
      outcome: { approved: false, rejected: true, comments: decision.comments },
    };
  }
}

function nodeId(ctx: NodeContext): string {
  return (ctx as NodeContext & { _nodeId?: string })._nodeId ?? "unknown";
}
