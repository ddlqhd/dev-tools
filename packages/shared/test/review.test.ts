import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewResultSchema } from "../src/review.js";

test("ReviewResultSchema: accepts a valid result", () => {
  const parsed = ReviewResultSchema.parse({
    passed: false,
    summary: "two issues",
    comments: [
      {
        id: "c1",
        file: "src/a.ts",
        line: 3,
        severity: "blocker",
        comment: "must fix",
        suggestion: "fix it",
        status: "open",
      },
      { id: "c2", severity: "nit", comment: "style" },
    ],
  });
  assert.equal(parsed.passed, false);
  assert.equal(parsed.comments.length, 2);
  // status defaults to "open"
  assert.equal(parsed.comments[1]!.status, "open");
});

test("ReviewResultSchema: rejects unknown severity", () => {
  assert.throws(
    () =>
      ReviewResultSchema.parse({
        passed: true,
        comments: [{ id: "c", severity: "fatal", comment: "x" }],
      }),
    /Invalid enum value/,
  );
});

test("ReviewResultSchema: rejects unknown status", () => {
  assert.throws(
    () =>
      ReviewResultSchema.parse({
        passed: true,
        comments: [{ id: "c", severity: "minor", comment: "x", status: "wip" }],
      }),
    /Invalid enum value/,
  );
});

test("ReviewResultSchema: comments array is required", () => {
  assert.throws(() => ReviewResultSchema.parse({ passed: true }), /comments/);
});

test("ReviewResultSchema: passed must be boolean", () => {
  assert.throws(
    () => ReviewResultSchema.parse({ passed: "yes", comments: [] }),
    /Expected boolean/,
  );
});
