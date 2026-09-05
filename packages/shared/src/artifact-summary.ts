import { ReviewResultSchema, type ReviewResult } from "./review.js";
import { VerifyResultSchema, type VerifyResult } from "./verify.js";

export type ArtifactJsonSummary =
  | { kind: "review"; result: ReviewResult }
  | { kind: "verify"; result: VerifyResult }
  | { kind: "generic"; entries: Array<{ key: string; display: string }> }
  | { kind: "invalid"; message: string };

function formatDisplay(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    return value.length <= 120 ? value : `${value.slice(0, 120)}…`;
  }
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return `${value.length} 项`;
  if (typeof value === "object") return "{…}";
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeArtifactJson(text: string): ArtifactJsonSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      kind: "invalid",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      kind: "generic",
      entries: [{ key: "(root)", display: formatDisplay(parsed) }],
    };
  }

  if (Array.isArray(parsed.comments)) {
    const review = ReviewResultSchema.safeParse(parsed);
    if (review.success) {
      return { kind: "review", result: review.data };
    }
  } else {
    const verify = VerifyResultSchema.safeParse(parsed);
    if (verify.success) {
      return { kind: "verify", result: verify.data };
    }
  }

  return {
    kind: "generic",
    entries: Object.entries(parsed).map(([key, value]) => ({
      key,
      display: formatDisplay(value),
    })),
  };
}
