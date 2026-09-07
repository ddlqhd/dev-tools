import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, listTasks, initCodeloop, CodeloopNotInitializedError } from "../src/index.js";
import { loadTaskDetail } from "../src/server/task-detail.js";
import { KernelRuntime } from "../src/runtime/kernel-runtime.js";

test("doctor: does not create .codeloop in an uninitialized repo", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codeloop-doctor-"));
  try {
    const result = await doctor(repo);
    const config = result.checks.find((c) => c.name === "config");
    assert.equal(config?.ok, false);
    assert.match(config?.detail ?? "", /codeloop init/);
    assert.equal(existsSync(join(repo, ".codeloop")), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("doctor: does not rewrite an existing config", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codeloop-doctor-ro-"));
  try {
    await initCodeloop(repo);
    const cfgPath = join(repo, ".codeloop", "config.yaml");
    const custom = "version: 1\n# preserved-by-doctor\npipeline: default-codeloop\n";
    await writeFile(cfgPath, custom, "utf8");
    const result = await doctor(repo);
    const config = result.checks.find((c) => c.name === "config");
    assert.equal(config?.ok, true);
    assert.equal(await readFile(cfgPath, "utf8"), custom);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("listTasks: throws a human error when not initialized", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codeloop-list-"));
  try {
    assert.throws(
      () => listTasks(repo),
      (err: unknown) => {
        assert.ok(err instanceof CodeloopNotInitializedError);
        assert.match(err.message, /codeloop init/);
        return true;
      },
    );
    assert.equal(existsSync(join(repo, ".codeloop")), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("listTasks: empty after init", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codeloop-list-init-"));
  try {
    await initCodeloop(repo);
    assert.deepEqual(listTasks(repo), []);
    assert.equal(existsSync(join(repo, ".codeloop", "kernel.db")), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("loadTaskDetail: throws when not initialized without creating .codeloop", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codeloop-show-"));
  try {
    await assert.rejects(() => loadTaskDetail(repo, "abcd1234"), (err: unknown) => {
      assert.ok(err instanceof CodeloopNotInitializedError);
      return true;
    });
    assert.equal(existsSync(join(repo, ".codeloop")), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("loadTaskDetail: does not rewrite config or create kernel.db", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codeloop-show-ro-"));
  try {
    await initCodeloop(repo);
    const cfgPath = join(repo, ".codeloop", "config.yaml");
    const custom = "version: 1\n# preserved-by-show\npipeline: default-codeloop\n";
    await writeFile(cfgPath, custom, "utf8");
    await assert.rejects(() => loadTaskDetail(repo, "missing1"), /not found/i);
    assert.equal(await readFile(cfgPath, "utf8"), custom);
    assert.equal(existsSync(join(repo, ".codeloop", "kernel.db")), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("KernelRuntime.openExisting: throws without creating .codeloop", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codeloop-open-existing-"));
  try {
    await assert.rejects(() => KernelRuntime.openExisting(repo), (err: unknown) => {
      assert.ok(err instanceof CodeloopNotInitializedError);
      return true;
    });
    assert.equal(existsSync(join(repo, ".codeloop")), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("KernelRuntime.openExisting: does not rewrite config or create kernel.db", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codeloop-open-existing-ro-"));
  try {
    await initCodeloop(repo);
    const cfgPath = join(repo, ".codeloop", "config.yaml");
    const custom = "version: 1\n# preserved-by-attach\npipeline: default-codeloop\n";
    await writeFile(cfgPath, custom, "utf8");
    const runtime = await KernelRuntime.openExisting(repo);
    try {
      await assert.rejects(() => runtime.attachTask("missing1"), /not found/i);
    } finally {
      runtime.close();
    }
    assert.equal(await readFile(cfgPath, "utf8"), custom);
    assert.equal(existsSync(join(repo, ".codeloop", "kernel.db")), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
