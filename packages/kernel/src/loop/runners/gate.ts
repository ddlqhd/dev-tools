import { randomUUID } from "node:crypto";
import { parseDurationMs, type NodeSpec } from "@devtools/shared";
import type { NodeContext, NodeResult, NodeRunner } from "../node.js";

const DEFAULT_ARTIFACT_KEY = "planDoc";

export class GateNodeRunner implements NodeRunner {
  readonly type = "gate" as const;

  async run(spec: NodeSpec, ctx: NodeContext): Promise<NodeResult> {
    if (ctx.config.autoApproveGates) {
      await ctx.emit({
        type: "log",
        payload: { level: "info", message: "Gate auto-approved (--no-gate / autoApproveGates)" },
      });
      return { outputs: {}, outcome: { approved: true, auto: true } };
    }

    const requestId = randomUUID();
    const timeoutMs = spec.timeout ? parseTimeout(spec.timeout) : undefined;
    const decision = await ctx.requestIntervention({
      requestId,
      nodeId: nodeId(ctx),
      kind: "gate",
      summary: "Approval required before continuing",
      artifactKey: spec.artifactKey ?? DEFAULT_ARTIFACT_KEY,
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
