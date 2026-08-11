import { z } from "zod";

export const VerifyFailureSchema = z.object({
  /** What was being verified, e.g. "lint", "unit tests", "typecheck". */
  check: z.string(),
  /** The command the agent actually ran, when applicable. */
  command: z.string().optional(),
  detail: z.string(),
});

export type VerifyFailure = z.infer<typeof VerifyFailureSchema>;

export const VerifyResultSchema = z.object({
  passed: z.boolean(),
  summary: z.string(),
  failures: z.array(VerifyFailureSchema).default([]),
  /** Checks the agent ran and that succeeded — for the report artifact. */
  checksRun: z.array(z.string()).default([]),
});

export type VerifyResult = z.infer<typeof VerifyResultSchema>;
