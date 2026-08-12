import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPipeline, listBuiltinPipelines, parsePipelineYaml } from "@devtools/kernel";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "codeloop-pl-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("listBuiltinPipelines: exposes the five templates", async () => {
  const names = await listBuiltinPipelines();
  for (const expected of [
    "default-codeloop",
    "m1-minimal",
    "quick-fix",
    "plan-only",
    "review-only",
  ]) {
    assert.ok(names.includes(expected), expected);
  }
});

test("loadPipeline: each builtin parses and hashes stably", async () => {
  for (const name of await listBuiltinPipelines()) {
    const p1 = await loadPipeline(name, repo);
    const p2 = await loadPipeline(name, repo);
    assert.equal(p1.name, name);
    assert.ok(p1.hash.length >= 16);
    assert.equal(p1.hash, p2.hash, `hash must be stable for ${name}`);
    assert.ok(p1.flow.length > 0);
  }
});

test("loadPipeline: default-codeloop wiring is well-formed", async () => {
  const p = await loadPipeline("default-codeloop", repo);
  const loopIds = p.flow.filter((s) => s.kind === "loop").map((s) => (s as { id: string }).id);
  assert.deepEqual(loopIds, ["planLoop", "reviewLoop"]);
  // verify step references reviewLoop via onFail
  const verifyStep = p.flow.find(
    (s) => s.kind === "node" && s.nodeId === "verify",
  );
  assert.equal((verifyStep as { onFail?: { goto: string } })?.onFail?.goto, "reviewLoop");
  assert.equal(p.nodes.plan?.engine, "planner");
  assert.equal(p.nodes.code?.engine, "coder");
});

test("loadPipeline: custom pipeline in .codeloop/pipelines wins over builtin", async () => {
  await mkdir(join(repo, ".codeloop", "pipelines"), { recursive: true });
  await writeFile(
    join(repo, ".codeloop", "pipelines", "default-codeloop.yaml"),
    "version: 1\npipeline: default-codeloop\nnodes:\n  code:\n    type: agent\nflow:\n  - code\n",
    "utf8",
  );
  const p = await loadPipeline("default-codeloop", repo);
  assert.deepEqual(Object.keys(p.nodes), ["code"]);
});

test("loadPipeline: unknown pipeline throws", async () => {
  await assert.rejects(() => loadPipeline("nope", repo), /Pipeline not found: nope/);
});

test("parsePipelineYaml: validation rules", async () => {
  // duplicate loop id
  assert.throws(
    () =>
      parsePipelineYaml(`version: 1
pipeline: p
nodes:
  a:
    type: agent
flow:
  - loop:
      id: L
      maxIterations: 2
      body: [a]
      until: a.passed
  - loop:
      id: L
      maxIterations: 2
      body: [a]
      until: a.passed
`),
    /Duplicate loop id/,
  );

  // unknown node in loop body
  assert.throws(
    () =>
      parsePipelineYaml(`version: 1
pipeline: p
nodes:
  a:
    type: agent
flow:
  - loop:
      id: L
      maxIterations: 2
      body: [nope]
      until: a.passed
`),
    /Unknown node in loop L/,
  );

  // unknown node in flow
  assert.throws(
    () => parsePipelineYaml("version: 1\npipeline: p\nnodes:\n  a:\n    type: agent\nflow:\n  - nope\n"),
    /Unknown node in flow/,
  );

  // onFail must reference a loop
  assert.throws(
    () =>
      parsePipelineYaml(`version: 1
pipeline: p
nodes:
  v:
    type: verify
    onFail:
      goto: notALoop
flow:
  - v
`),
    /onFail\.goto must reference a declared loop/,
  );

  // missing maxIterations/until
  assert.throws(
    () =>
      parsePipelineYaml(`version: 1
pipeline: p
nodes:
  a:
    type: agent
flow:
  - loop:
      id: L
      body: [a]
      until: a.passed
`),
    /maxIterations and until/,
  );
});

test("parsePipelineYaml: hash is content-derived", async () => {
  const a = parsePipelineYaml("version: 1\npipeline: p\nnodes:\n  a:\n    type: agent\nflow:\n  - a\n");
  const b = parsePipelineYaml("version: 1\npipeline: p\nnodes:\n  a:\n    type: agent\nflow:\n  - a\n");
  const c = parsePipelineYaml("version: 1\npipeline: p\nnodes:\n  a:\n    type: review\nflow:\n  - a\n");
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
});
