import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  readConfig,
  ensureCodeloopDir,
  initCodeloop,
  isCodeloopInitialized,
  CodeloopNotInitializedError,
  getMissingEngineConfigs,
  writeConfig,
  backfillEnginePrompts,
} from "../src/config.js";
import { DEFAULT_ENGINE_ALIASES, DEFAULT_PROMPTS } from "../src/prompts/index.js";
import type { NodeSpec } from "@devtools/shared";

let repo: string;
let codeloopRoot: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "codeloop-cfg-"));
  codeloopRoot = await ensureCodeloopDir(repo);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("ensureCodeloopDir: creates layout + default config", async () => {
  for (const dir of ["pipelines", "worktrees", "tasks"]) {
    const info = await stat(join(codeloopRoot, dir));
    assert.ok(info.isDirectory(), dir);
  }
  const configRaw = await readFile(join(codeloopRoot, "config.yaml"), "utf8");
  assert.match(configRaw, /^version: 1/m);
  const config = await loadConfig(repo);
  for (const alias of DEFAULT_ENGINE_ALIASES) {
    assert.match(configRaw, new RegExp(`^  ${alias}:`, "m"), alias);
    assert.ok(config.engines[alias]?.prompt?.includes("{{requirement}}"), alias);
  }
});

test("ensureCodeloopDir: appends .codeloop/ to an existing .gitignore", async () => {
  await writeFile(join(repo, ".gitignore"), "node_modules/\n", "utf8");
  await ensureCodeloopDir(repo);
  const gi = await readFile(join(repo, ".gitignore"), "utf8");
  assert.match(gi, /\.codeloop\//);
});

test("ensureCodeloopDir: no .gitignore in non-git dir is tolerated", async () => {
  // second call must not throw even though no .gitignore exists
  await ensureCodeloopDir(repo);
});

test("loadConfig: defaults for a fresh repo", async () => {
  const config = await loadConfig(repo);
  assert.equal(config.pipeline, "default-codeloop");
  assert.equal(config.autoApproveGates, false);
  assert.equal(config.skipVerifyIfMissing, true);
  assert.equal(config.inplace, false);
  assert.equal(config.sandbox, false);
  assert.equal(config.budget.maxEngineCalls, 60);
  assert.equal(config.budget.nodeTimeoutMinutes, 30);
  assert.equal(config.git.branchPrefix, "codeloop/");
  // All seven stage aliases default to cursor
  for (const alias of [
    "planner",
    "planReviewer",
    "coder",
    "codeReviewer",
    "fixer",
    "verifier",
    "committer",
  ]) {
    assert.equal(config.engines[alias]?.type, "cursor", alias);
  }
});

test("loadConfig: reads user overrides", async () => {
  await writeFile(
    join(codeloopRoot, "config.yaml"),
    "version: 1\npipeline: quick-fix\nengines:\n  coder:\n    type: cursor\n    model: gpt-5\nbudget:\n  maxEngineCalls: 3\nautoApproveGates: true\n",
    "utf8",
  );
  const config = await loadConfig(repo);
  assert.equal(config.pipeline, "quick-fix");
  assert.equal(config.engines.coder?.model, "gpt-5");
  assert.equal(config.budget.maxEngineCalls, 3);
  assert.equal(config.autoApproveGates, true);
});

test("loadConfig: rejects invalid yaml", async () => {
  await writeFile(join(codeloopRoot, "config.yaml"), "version: 99\n", "utf8");
  await assert.rejects(() => loadConfig(repo));
});

test("writeConfig: round-trips", async () => {
  const config = await loadConfig(repo);
  config.budget.maxEngineCalls = 7;
  config.autoApproveGates = true;
  await writeConfig(repo, config);
  const reloaded = await loadConfig(repo);
  assert.equal(reloaded.budget.maxEngineCalls, 7);
  assert.equal(reloaded.autoApproveGates, true);
});

test("getMissingEngineConfigs: finds engines referenced by nodes", () => {
  const nodes: Record<string, NodeSpec> = {
    plan: { type: "agent", engine: "planner" },
    code: { type: "agent" },
    verify: { type: "verify" },
    gate: { type: "gate" },
  };
  const missing = getMissingEngineConfigs(nodes, { coder: { type: "cursor" } });
  assert.deepEqual([...missing].sort(), ["planner", "verifier"]);
});

test("backfillEnginePrompts: fills missing prompts without overwriting edits", () => {
  const raw = [
    "version: 1",
    "# keep this comment",
    "engines:",
    "  planner:",
    "    type: cursor",
    "    # model note",
    "  coder:",
    "    type: cursor",
    "    prompt: |",
    "      CUSTOM BODY",
    "      {{requirement}}",
    "",
  ].join("\n");
  const updated = backfillEnginePrompts(raw);
  assert.match(updated, /# keep this comment/);
  assert.match(updated, /# model note/);
  assert.match(updated, /CUSTOM BODY/);
  assert.ok(updated.includes(DEFAULT_PROMPTS.planner.trim().slice(0, 40)));
  assert.ok(!updated.includes(DEFAULT_PROMPTS.coder.slice(0, 40)));
});

test("ensureCodeloopDir: backfills prompts on an existing config", async () => {
  await writeFile(
    join(codeloopRoot, "config.yaml"),
    "version: 1\n# preserved\nengines:\n  planner:\n    type: cursor\n  coder:\n    type: cursor\n    prompt: |\n      STAY\n",
    "utf8",
  );
  await ensureCodeloopDir(repo);
  const raw = await readFile(join(codeloopRoot, "config.yaml"), "utf8");
  assert.match(raw, /# preserved/);
  assert.match(raw, /STAY/);
  const config = await loadConfig(repo);
  assert.match(config.engines.planner?.prompt ?? "", /planning a software change/);
  assert.equal(config.engines.coder?.prompt?.trim(), "STAY");
});

test("getMissingEngineConfigs: no missing when all present", () => {
  const nodes: Record<string, NodeSpec> = {
    code: { type: "agent" },
    gate: { type: "gate" },
  };
  const missing = getMissingEngineConfigs(nodes, { coder: { type: "cursor" } });
  assert.deepEqual(missing, []);
});

test("initCodeloop: reports created then exists", async () => {
  const fresh = await mkdtemp(join(tmpdir(), "codeloop-init-"));
  try {
    assert.equal(isCodeloopInitialized(fresh), false);
    const first = await initCodeloop(fresh);
    assert.equal(isCodeloopInitialized(fresh), true);
    assert.ok(first.actions.some((a) => a.path === ".codeloop" && a.status === "created"));
    assert.ok(first.actions.some((a) => a.path === ".codeloop/config.yaml" && a.status === "created"));
    const second = await initCodeloop(fresh);
    assert.equal(
      second.actions.find((a) => a.path === ".codeloop/config.yaml")?.status,
      "exists",
    );
    assert.ok(second.actions.every((a) => a.status === "exists"));
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test("initCodeloop: creates .gitignore in a git repo that lacks one", async () => {
  const fresh = await mkdtemp(join(tmpdir(), "codeloop-init-gi-create-"));
  try {
    await mkdir(join(fresh, ".git"));
    const first = await initCodeloop(fresh);
    assert.equal(first.actions.find((a) => a.path === ".gitignore")?.status, "created");
    const gi = await readFile(join(fresh, ".gitignore"), "utf8");
    assert.equal(gi, ".codeloop/\n");
    const second = await initCodeloop(fresh);
    assert.equal(second.actions.find((a) => a.path === ".gitignore")?.status, "exists");
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test("initCodeloop: updates .gitignore when present", async () => {
  const fresh = await mkdtemp(join(tmpdir(), "codeloop-init-gi-"));
  try {
    await writeFile(join(fresh, ".gitignore"), "node_modules/\n", "utf8");
    const first = await initCodeloop(fresh);
    assert.equal(first.actions.find((a) => a.path === ".gitignore")?.status, "updated");
    const gi = await readFile(join(fresh, ".gitignore"), "utf8");
    assert.match(gi, /\.codeloop\//);
    const second = await initCodeloop(fresh);
    assert.equal(second.actions.find((a) => a.path === ".gitignore")?.status, "exists");
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test("readConfig: throws when not initialized", async () => {
  const fresh = await mkdtemp(join(tmpdir(), "codeloop-read-"));
  try {
    await assert.rejects(() => readConfig(fresh), (err: unknown) => {
      assert.ok(err instanceof CodeloopNotInitializedError);
      assert.match(err.message, /codeloop init/);
      return true;
    });
    assert.equal(existsSync(join(fresh, ".codeloop")), false);
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});
