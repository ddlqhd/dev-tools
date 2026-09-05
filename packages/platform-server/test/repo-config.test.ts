import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatConfigError,
  getConfigMeta,
  listRepoPipelines,
  loadRepoConfig,
  parseRepoConfig,
  saveRepoConfig,
} from "../src/repo-config.js";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "codeloop-repo-cfg-"));
}

test("loadRepoConfig: creates default config for empty dir", async () => {
  const dir = await freshDir();
  try {
    const { config, pipelines } = await loadRepoConfig(dir);
    assert.equal(config.pipeline, "default-codeloop");
    assert.equal(config.inplace, false);
    assert.equal(config.engines.coder?.type, "cursor");
    assert.ok(pipelines.includes("default-codeloop"));
    assert.ok(pipelines.includes("quick-fix"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveRepoConfig: persists engines, inplace, and budget", async () => {
  const dir = await freshDir();
  try {
    const loaded = await loadRepoConfig(dir);
    const saved = await saveRepoConfig(dir, {
      ...loaded.config,
      inplace: true,
      sandbox: true,
      pipeline: "quick-fix",
      budget: { maxEngineCalls: 12, nodeTimeoutMinutes: 8 },
      engines: {
        ...loaded.config.engines,
        coder: { type: "opencode", model: "  glm-4  " },
      },
    });
    assert.equal(saved.engines.coder?.model, "glm-4");
    const reloaded = await loadRepoConfig(dir);
    assert.equal(reloaded.config.inplace, true);
    assert.equal(reloaded.config.sandbox, true);
    assert.equal(reloaded.config.pipeline, "quick-fix");
    assert.equal(reloaded.config.budget.maxEngineCalls, 12);
    assert.equal(reloaded.config.engines.coder?.type, "opencode");
    assert.equal(reloaded.config.engines.coder?.model, "glm-4");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseRepoConfig: rejects invalid version", () => {
  assert.throws(() => parseRepoConfig({ version: 99 }), /invalid_literal|Literal|version/);
});

test("parseRepoConfig: strips empty model strings", () => {
  const parsed = parseRepoConfig({
    version: 1,
    engines: { coder: { type: "cursor", model: "   " } },
  });
  assert.equal(parsed.engines.coder?.type, "cursor");
  assert.equal(parsed.engines.coder?.model, undefined);
});

test("parseRepoConfig: keeps a custom engine prompt", () => {
  const parsed = parseRepoConfig({
    version: 1,
    engines: { coder: { type: "cursor", prompt: "do {{requirement}}" } },
  });
  assert.equal(parsed.engines.coder?.prompt, "do {{requirement}}");
});

test("formatConfigError: joins zod issues", () => {
  try {
    parseRepoConfig({ version: 99 });
    assert.fail("expected throw");
  } catch (err) {
    assert.match(formatConfigError(err), /version/);
  }
});

test("listRepoPipelines: includes custom yaml", async () => {
  const dir = await freshDir();
  try {
    await mkdir(join(dir, ".codeloop", "pipelines"), { recursive: true });
    await writeFile(join(dir, ".codeloop", "pipelines", "my-flow.yaml"), "pipeline: my-flow\n", "utf8");
    const names = await listRepoPipelines(dir);
    assert.ok(names.includes("my-flow"));
    assert.ok(names.includes("default-codeloop"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getConfigMeta: exposes builtin pipelines and implemented engines", async () => {
  const meta = await getConfigMeta();
  assert.ok(meta.pipelines.includes("default-codeloop"));
  assert.deepEqual(
    meta.engines.map((e) => e.id),
    ["cursor", "opencode"],
  );
});
