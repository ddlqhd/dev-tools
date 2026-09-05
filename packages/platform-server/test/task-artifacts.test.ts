import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSafeArtifactId,
  listTaskArtifacts,
  readTaskArtifact,
} from "../src/task-artifacts.js";

test("isSafeArtifactId: rejects path traversal", () => {
  assert.equal(isSafeArtifactId("planDoc"), true);
  assert.equal(isSafeArtifactId("verify-report"), true);
  assert.equal(isSafeArtifactId("../secret"), false);
  assert.equal(isSafeArtifactId("a/b"), false);
});

test("list/read task artifacts from disk after kernel is gone", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-arts-"));
  const repoPath = join(tmp, "repo");
  const dir = join(repoPath, ".codeloop", "tasks", "k1", "artifacts");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "planDoc.md"), "# Plan\n");
    await writeFile(join(dir, "verifyReport.json"), '{"ok":true}');

    const listed = await listTaskArtifacts(repoPath, "k1");
    assert.deepEqual(
      listed.map((a) => `${a.key}.${a.ext}`),
      ["planDoc.md", "verifyReport.json"],
    );
    assert.ok(listed[0]!.size > 0);

    const plan = await readTaskArtifact(repoPath, "k1", "planDoc");
    assert.equal(plan?.contentType, "text/plain; charset=utf-8");
    assert.equal(plan?.body, "# Plan\n");

    const report = await readTaskArtifact(repoPath, "k1", "verifyReport");
    assert.equal(report?.contentType, "application/json");
    assert.match(report?.body ?? "", /ok/);

    assert.equal(await readTaskArtifact(repoPath, "k1", "missing"), null);
    assert.equal((await listTaskArtifacts(repoPath, "../k1")).length, 0);
    assert.equal(await readTaskArtifact(repoPath, "k1", "../planDoc"), null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
