import { test } from "node:test";
import assert from "node:assert/strict";
import {
  artifactExt,
  defaultArtifactInputs,
  isPlanAgent,
  normalizeFlow,
  resolveNodeEngineKey,
  NodeSpecSchema,
  type NodeSpec,
} from "../src/pipeline.js";

test("normalizeFlow: bare string step inherits node-level onFail", () => {
  const nodes: Record<string, NodeSpec> = {
    code: { type: "agent", engine: "coder" },
    verify: {
      type: "verify",
      engine: "verifier",
      onFail: { goto: "reviewLoop", asComment: "blocker" },
    },
  };
  const flow = normalizeFlow(["code", "verify"], nodes);
  assert.deepEqual(flow, [
    { kind: "node", nodeId: "code", onFail: undefined },
    { kind: "node", nodeId: "verify", onFail: { goto: "reviewLoop", asComment: "blocker" } },
  ]);
});

test("normalizeFlow: loop block step", () => {
  const flow = normalizeFlow([
    {
      loop: {
        id: "reviewLoop",
        maxIterations: 5,
        body: ["codeReview", "fixReview"],
        until: "codeReview.passed",
      },
    },
  ]);
  assert.deepEqual(flow, [
    {
      kind: "loop",
      id: "reviewLoop",
      maxIterations: 5,
      body: ["codeReview", "fixReview"],
      until: "codeReview.passed",
    },
  ]);
});

test("normalizeFlow: single-key object step with flow-level onFail wins over node-level", () => {
  const nodes: Record<string, NodeSpec> = {
    verify: {
      type: "verify",
      engine: "verifier",
      onFail: { goto: "loopA" },
    },
  };
  const flow = normalizeFlow(
    [{ verify: { onFail: { goto: "loopB", asComment: "major" } } }],
    nodes,
  );
  assert.deepEqual(flow, [
    { kind: "node", nodeId: "verify", onFail: { goto: "loopB", asComment: "major" } },
  ]);
});

test("normalizeFlow: invalid step throws", () => {
  assert.throws(() => normalizeFlow([{ a: 1, b: 2 }]), /Invalid flow step/);
  assert.throws(() => normalizeFlow([42]), /Invalid flow step/);
});

test("resolveNodeEngineKey: defaults per primitive", () => {
  assert.equal(resolveNodeEngineKey({ type: "agent" }), "coder");
  assert.equal(resolveNodeEngineKey({ type: "review" }), "coder");
  assert.equal(resolveNodeEngineKey({ type: "verify" }), "verifier");
  assert.equal(resolveNodeEngineKey({ type: "commit" }), "committer");
});

test("resolveNodeEngineKey: non-engine primitives return undefined", () => {
  assert.equal(resolveNodeEngineKey({ type: "gate" }), undefined);
  assert.equal(resolveNodeEngineKey({ type: "command" }), undefined);
});

test("resolveNodeEngineKey: explicit engine wins", () => {
  assert.equal(
    resolveNodeEngineKey({ type: "agent", engine: "planner" }),
    "planner",
  );
  assert.equal(
    resolveNodeEngineKey({ type: "verify", engine: "custom" }),
    "custom",
  );
});

test("NodeSpecSchema: parses a full node", () => {
  const node: NodeSpec = {
    type: "agent",
    engine: "coder",
    model: "gpt-5",
    readonly: false,
    promptTemplate: "code",
    inputs: ["planDoc"],
    outputs: ["reviewComments"],
    timeout: "30m",
    severityGate: "major",
    run: ["pnpm test"],
    messageStyle: "conventional",
    onFail: { goto: "reviewLoop", asComment: "blocker" },
  };
  const parsed = NodeSpecSchema.parse(node);
  assert.equal(parsed.type, "agent");
  assert.equal(parsed.onFail?.goto, "reviewLoop");
});

test("NodeSpecSchema: rejects unknown type", () => {
  assert.throws(() => NodeSpecSchema.parse({ type: "wat" }), /Invalid enum value/);
});

test("NodeSpecSchema: rejects invalid severityGate", () => {
  assert.throws(
    () => NodeSpecSchema.parse({ type: "review", severityGate: "fatal" }),
    /Invalid enum value/,
  );
});

test("NodeSpecSchema: defaults applied for absent fields", () => {
  const parsed = NodeSpecSchema.parse({ type: "gate" });
  assert.equal(parsed.type, "gate");
  assert.equal(parsed.onFail, undefined);
});

test("isPlanAgent: promptTemplate plan", () => {
  assert.equal(isPlanAgent({ type: "agent", promptTemplate: "plan" }), true);
});

test("isPlanAgent: outputs include planDoc", () => {
  assert.equal(isPlanAgent({ type: "agent", outputs: ["planDoc"] }), true);
});

test("isPlanAgent: code agent is false", () => {
  assert.equal(
    isPlanAgent({ type: "agent", engine: "coder", promptTemplate: "code" }),
    false,
  );
});

test("isPlanAgent: review node is false", () => {
  assert.equal(isPlanAgent({ type: "review", engine: "planReviewer" }), false);
});

test("artifactExt: comments and reports are json", () => {
  assert.equal(artifactExt("planComments"), "json");
  assert.equal(artifactExt("reviewComments"), "json");
  assert.equal(artifactExt("verifyReport"), "json");
  assert.equal(artifactExt("planDoc"), "md");
});

test("defaultArtifactInputs: plan / fix / other", () => {
  assert.deepEqual(
    defaultArtifactInputs({ type: "agent", promptTemplate: "plan" }),
    ["planDoc", "planComments"],
  );
  assert.deepEqual(
    defaultArtifactInputs({ type: "agent", promptTemplate: "fix" }),
    ["reviewComments"],
  );
  assert.deepEqual(defaultArtifactInputs({ type: "agent", promptTemplate: "code" }), [
    "planDoc",
  ]);
  assert.deepEqual(defaultArtifactInputs({ type: "review" }), ["planDoc"]);
  assert.deepEqual(defaultArtifactInputs({ type: "verify" }), ["planDoc"]);
  assert.deepEqual(defaultArtifactInputs({ type: "commit" }), ["planDoc"]);
  assert.deepEqual(defaultArtifactInputs({ type: "gate" }), []);
});
