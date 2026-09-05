import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeArtifactJson } from "../src/artifact-summary.js";

test("summarizeArtifactJson: review result", () => {
  const summary = summarizeArtifactJson(
    JSON.stringify({
      passed: false,
      summary: "two issues",
      comments: [
        {
          id: "c1",
          file: "src/a.ts",
          line: 3,
          severity: "blocker",
          comment: "must fix",
        },
        { id: "c2", severity: "nit", comment: "style" },
      ],
    }),
  );
  assert.equal(summary.kind, "review");
  if (summary.kind === "review") {
    assert.equal(summary.result.passed, false);
    assert.equal(summary.result.comments.length, 2);
  }
});

test("summarizeArtifactJson: verify result", () => {
  const summary = summarizeArtifactJson(
    JSON.stringify({
      passed: true,
      summary: "all green",
    }),
  );
  assert.equal(summary.kind, "verify");
  if (summary.kind === "verify") {
    assert.equal(summary.result.passed, true);
    assert.equal(summary.result.summary, "all green");
    assert.deepEqual(summary.result.failures, []);
  }
});

test("summarizeArtifactJson: invalid JSON", () => {
  const summary = summarizeArtifactJson("{not json");
  assert.equal(summary.kind, "invalid");
  if (summary.kind === "invalid") {
    assert.ok(summary.message.length > 0);
  }
});

test("summarizeArtifactJson: plain object → generic", () => {
  const summary = summarizeArtifactJson(JSON.stringify({ foo: 1, bar: "x" }));
  assert.equal(summary.kind, "generic");
  if (summary.kind === "generic") {
    assert.deepEqual(summary.entries, [
      { key: "foo", display: "1" },
      { key: "bar", display: "x" },
    ]);
  }
});

test("summarizeArtifactJson: invalid comments array is not verify", () => {
  const summary = summarizeArtifactJson(
    JSON.stringify({
      passed: false,
      summary: "looks like verify fields",
      comments: [{ id: "c", severity: "fatal", comment: "bad severity" }],
    }),
  );
  assert.notEqual(summary.kind, "verify");
  assert.equal(summary.kind, "generic");
});
