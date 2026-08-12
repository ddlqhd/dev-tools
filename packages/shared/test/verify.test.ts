import { test } from "node:test";
import assert from "node:assert/strict";
import { VerifyResultSchema } from "../src/verify.js";

test("VerifyResultSchema: accepts a passing result with defaults", () => {
  const parsed = VerifyResultSchema.parse({
    passed: true,
    summary: "all green",
  });
  assert.equal(parsed.passed, true);
  assert.deepEqual(parsed.failures, []);
  assert.deepEqual(parsed.checksRun, []);
});

test("VerifyResultSchema: accepts failures with optional command", () => {
  const parsed = VerifyResultSchema.parse({
    passed: false,
    summary: "lint failed",
    failures: [
      { check: "lint", command: "pnpm lint", detail: "3 errors" },
      { check: "typecheck", detail: "broken types" },
    ],
    checksRun: ["lint"],
  });
  assert.equal(parsed.failures.length, 2);
  assert.equal(parsed.failures[0]!.command, "pnpm lint");
  assert.equal(parsed.failures[1]!.command, undefined);
});

test("VerifyResultSchema: summary is required", () => {
  assert.throws(() => VerifyResultSchema.parse({ passed: true }), /summary/);
});

test("VerifyResultSchema: failure detail is required", () => {
  assert.throws(
    () =>
      VerifyResultSchema.parse({
        passed: false,
        summary: "s",
        failures: [{ check: "lint" }],
      }),
    /detail/,
  );
});

test("VerifyResultSchema: passed must be boolean", () => {
  assert.throws(
    () => VerifyResultSchema.parse({ passed: 1, summary: "s" }),
    /Expected boolean/,
  );
});
