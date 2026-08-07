import { z } from "zod";

export const ReviewCommentSchema = z.object({
  id: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  severity: z.enum(["blocker", "major", "minor", "nit"]),
  comment: z.string(),
  suggestion: z.string().optional(),
  status: z.enum(["open", "fixed", "rejected"]).default("open"),
  rejectReason: z.string().optional(),
});

export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

export const ReviewResultSchema = z.object({
  passed: z.boolean(),
  comments: z.array(ReviewCommentSchema),
  summary: z.string().optional(),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;
