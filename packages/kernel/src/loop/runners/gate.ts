import { randomUUID } from "node:crypto";
import { parseDurationMs, type NodeSpec } from "@devtools/shared";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

const DEFAULT_ARTIFACT_KEY = "planDoc";

export class GateNodeRunner implements NodeRunner {
  readonly type = "gate" as const;

  async run(spec: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    if (ctx.config.autoApproveGates) {
      if (ctx.loopExhaustion) {
        await ctx.emit({
          type: "log",
          payload: {
            level: "warn",
            message: `Gate auto-approved despite loop exhaustion (${ctx.loopExhaustion.loopId} ${ctx.loopExhaustion.iteration}/${ctx.loopExhaustion.maxIterations}) (--no-gate / autoApproveGates)`,
          },
        });
      } else {
        await ctx.emit({
          type: "log",
          payload: { level: "info", message: "Gate auto-approved (--no-gate / autoApproveGates)" },
        });
      }
      return { outputs: {}, outcome: { approved: true, auto: true } };
    }

    const requestId = randomUUID();
    const timeoutMs = spec.timeout ? parseTimeout(spec.timeout) : undefined;
    const summary = ctx.loopExhaustion
      ? `${ctx.loopExhaustion.loopId} reached maxIterations=${ctx.loopExhaustion.maxIterations}; review did not pass`
      : "Approval required before continuing";

    const decision = await ctx.requestIntervention({
      requestId,
      nodeId: nodeId(ctx),
      kind: "gate",
      summary,
      artifactKey: spec.artifactKey ?? DEFAULT_ARTIFACT_KEY,
      ...(ctx.loopExhaustion ? { loopExhaustion: ctx.loopExhaustion } : {}),
      ...(timeoutMs ? { timeoutMs, timeoutPolicy: spec.timeoutPolicy ?? "reject" } : {}),
    });

    if (decision.action === "edit") {
      const key = spec.artifactKey ?? DEFAULT_ARTIFACT_KEY;
      const saved = await ctx.artifacts.writeText(key, decision.content);
      await ctx.emit({
        type: "artifact.created",
        payload: { artifactId: key, key, kind: "md", path: saved },
      });
      await ctx.emit({
        type: "log",
        payload: { level: "info", message: `Gate approved with edited ${key}` },
      });
    }

    const auto = "auto" in decision ? decision.auto : undefined;
    if (auto) {
      await ctx.emit({
        type: "log",
        payload: { level: "warn", message: "Gate resolved automatically" },
      });
    }

    if (decision.action === "approve" || decision.action === "edit") {
      return { outputs: {}, outcome: { approved: true, ...(auto ? { auto } : {}) } };
    }

    // reject → signal outcome for potential loop re-entry (interpreter may handle later)
    return {
      outputs: {},
      outcome: { approved: false, rejected: true, comments: decision.comments },
    };
  }
}

function parseTimeout(raw: string): number | undefined {
  try {
    const ms = parseDurationMs(raw);
    return ms > 0 ? ms : undefined;
  } catch {
    return undefined;
  }
}

function nodeId(ctx: NodeContext): string {
  return (ctx as NodeContext & { _nodeId?: string })._nodeId ?? "unknown";
}
