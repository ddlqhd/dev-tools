import { z } from "zod";

export const NodeSpecSchema = z.object({
  type: z.enum(["agent", "review", "gate", "command", "commit"]),
  engine: z.string().optional(),
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

export function normalizeFlow(rawFlow: unknown[]): FlowStep[] {
  return rawFlow.map((step, index) => {
    if (typeof step === "string") {
      return { kind: "node", nodeId: step };
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
        const onFail =
          opts && typeof opts === "object" && opts !== null && "onFail" in opts
            ? (opts as { onFail: { goto: string; asComment?: string } }).onFail
            : undefined;
        return { kind: "node", nodeId, onFail };
      }
    }
    throw new Error(`Invalid flow step at index ${index}: ${JSON.stringify(step)}`);
  });
}
