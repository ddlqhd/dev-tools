import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PlatformStore } from "../src/db/store.js";
import { publicRepo } from "../src/public.js";

test("updateRepo: patches writable fields; publicRepo redacts token", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-repos-update-"));
  const store = new PlatformStore(tmp);
  try {
    const now = new Date().toISOString();
    store.insertRepo({
      id: "r1",
      platform: "github",
      full_name: "acme/app",
      clone_path: "/tmp/old",
      trigger_label: "ai-dev",
      max_concurrency: 1,
      github_token: null,
      default_branch: "main",
      created_at: now,
      updated_at: now,
    });

    store.updateRepo("r1", {
      clone_path: "/tmp/new",
      trigger_label: "codeloop",
      max_concurrency: 3,
      default_branch: "develop",
      github_token: "ghp_secret",
    });

    const row = store.getRepo("r1");
    assert.ok(row);
    assert.equal(row.full_name, "acme/app");
    assert.equal(row.platform, "github");
    assert.equal(row.clone_path, "/tmp/new");
    assert.equal(row.trigger_label, "codeloop");
    assert.equal(row.max_concurrency, 3);
    assert.equal(row.default_branch, "develop");
    assert.equal(row.github_token, "ghp_secret");

    const pub = publicRepo(row);
    assert.equal(pub.has_github_token, true);
    assert.equal("github_token" in pub, false);
    assert.equal("loop_config" in row, false);
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("migrate: drops leftover repos.loop_config", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-repos-migrate-"));
  const legacy = new DatabaseSync(join(tmp, "platform.db"));
  legacy.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      full_name TEXT NOT NULL,
      clone_path TEXT NOT NULL,
      trigger_label TEXT NOT NULL DEFAULT 'ai-dev',
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      loop_config TEXT,
      github_token TEXT,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy.close();

  const store = new PlatformStore(tmp);
  try {
    const cols = (
      store.db.prepare(`PRAGMA table_info(repos)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    assert.equal(cols.includes("loop_config"), false);
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
