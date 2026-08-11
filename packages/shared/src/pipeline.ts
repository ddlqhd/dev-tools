import { z } from "zod";

export const NodeSpecSchema = z.object({
  type: z.enum(["agent", "review", "gate", "command", "verify", "commit"]),
  engine: z.string().optional(),
  /** Per-node model override; wins over engines[alias].model when set. */
  model: z.string().optional(),
  readonly: z.boolean().optional(),
  promptTemplate: z.string().optional(),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  timeout: z.string().optional(),
  severityGate: z.enum(["blocker", "major", "minor", "nit"]).optional(),
  run: z.array(z.string()).optional(),
  messageStyle: z.string().optional(),
  onFail: z
    .object({
      goto: z.string(),
      asComment: z.enum(["blocker", "major", "minor", "nit"]).optional(),
    })
    .optional(),
});

export type NodeSpec = z.infer<typeof NodeSpecSchema>;

/** Node types that run purely on orchestrator logic, with no engine session. */
const NON_ENGINE_TYPES = new Set<string>(["command", "gate"]);

const DEFAULT_ENGINE_ALIAS: Record<string, string> = {
  verify: "verifier",
  commit: "committer",
};

/** Engine alias a node runs on, or undefined when it needs no engine. */
export function resolveNodeEngineKey(spec: NodeSpec): string | undefined {
  if (NON_ENGINE_TYPES.has(spec.type)) return undefined;
  return spec.engine ?? DEFAULT_ENGINE_ALIAS[spec.type] ?? "coder";
}

export const LoopBlockSchema = z.object({
  loop: z.object({
    id: z.string(),
    maxIterations: z.number().int().positive(),
    body: z.array(z.string()).min(1),
    until: z.string(),
  }),
});

export const FlowStepSchema = z.union([
  z.string(),
  LoopBlockSchema,
  z.record(z.string(), NodeSpecSchema.partial().extend({ onFail: NodeSpecSchema.shape.onFail })),
]);

export const PipelineDefinitionSchema = z.object({
  version: z.literal(1),
  pipeline: z.string(),
  nodes: z.record(z.string(), NodeSpecSchema),
  flow: z.array(z.unknown()),
});

export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;

export type FlowStep =
  | { kind: "node"; nodeId: string; onFail?: { goto: string; asComment?: string } }
  | {
      kind: "loop";
      id: string;
      maxIterations: number;
      body: string[];
      until: string;
    };

/**
 * Normalize raw YAML flow. When `nodes` is provided, a bare string step
 * inherits `nodes[id].onFail` so authors can declare onFail on the node.
 * Flow-step-level onFail always wins when present.
 */
export function normalizeFlow(
  rawFlow: unknown[],
  nodes?: Record<string, NodeSpec>,
): FlowStep[] {
  return rawFlow.map((step, index) => {
    if (typeof step === "string") {
      return { kind: "node", nodeId: step, onFail: nodes?.[step]?.onFail };
    }
    if (step && typeof step === "object" && "loop" in step) {
      const loop = (step as { loop: { id: string; maxIterations: number; body: string[]; until: string } }).loop;
      return {
        kind: "loop",
        id: loop.id,
        maxIterations: loop.maxIterations,
        body: loop.body,
        until: loop.until,
      };
    }
    if (step && typeof step === "object") {
      const entries = Object.entries(step as Record<string, unknown>);
      if (entries.length === 1) {
        const [nodeId, opts] = entries[0]!;
        const flowOnFail =
          opts && typeof opts === "object" && opts !== null && "onFail" in opts
            ? (opts as { onFail: { goto: string; asComment?: string } }).onFail
            : undefined;
        return {
          kind: "node",
          nodeId,
          onFail: flowOnFail ?? nodes?.[nodeId]?.onFail,
        };
      }
    }
    throw new Error(`Invalid flow step at index ${index}: ${JSON.stringify(step)}`);
  });
}
