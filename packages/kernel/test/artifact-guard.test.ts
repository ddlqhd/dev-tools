import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createTaskWorktree, type GitWorktree } from "../src/git/worktree.js";
import {
  assertOnlyAllowedWrites,
  dropOrchestratorTempFiles,
} from "../src/loop/artifact-guard.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let repo: string;
let wt: GitWorktree;
let base: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "codeloop-guard-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@codeloop.local"]);
  git(repo, ["config", "user.name", "test"]);
  await writeFile(join(repo, "README.md"), "# repo\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  wt = await createTaskWorktree({
    repoPath: repo,
    worktreeRoot: join(repo, ".codeloop", "worktrees"),
    branchPrefix: "codeloop/",
    taskId: "g1",
  });
  base = await wt.head();
});

afterEach(async () => {
  git(repo, ["worktree", "remove", "--force", wt.worktreePath]);
  git(repo, ["branch", "-D", "codeloop/g1"]);
  await rm(repo, { recursive: true, force: true });
});

test("assertOnlyAllowedWrites: allowed file passes", async () => {
  await writeFile(join(wt.worktreePath, ".codeloop-review.json"), "{}", "utf8");
  await assertOnlyAllowedWrites(wt, [".codeloop-review.json"], [], base);
});

test("assertOnlyAllowedWrites: violation throws and resets the worktree", async () => {
  await writeFile(join(wt.worktreePath, ".codeloop-review.json"), "{}", "utf8");
  await writeFile(join(wt.worktreePath, "src.ts"), "oops\n", "utf8");
  await assert.rejects(
    () => assertOnlyAllowedWrites(wt, [".codeloop-review.json"], [], base),
    /artifactWriteOnly violation/,
  );
  // worktree restored to pre-turn state
  assert.equal(await wt.head(), base);
  assert.equal((await wt.statusPorcelain()).trim(), "");
  await assert.rejects(() => access(join(wt.worktreePath, "src.ts")));
});

test("assertOnlyAllowedWrites: engine-reported path also counts", async () => {
  await writeFile(join(wt.worktreePath, "evil.txt"), "x", "utf8");
  await assert.rejects(
    () => assertOnlyAllowedWrites(wt, [".codeloop-review.json"], ["evil.txt"], base),
    /evil\.txt/,
  );
});

test("assertOnlyAllowedWrites: node_modules symlink is exempt", async () => {
  const target = await mkdtemp(join(tmpdir(), "codeloop-nm-"));
  await symlink(target, join(wt.worktreePath, "node_modules"), "dir");
  try {
    await assertOnlyAllowedWrites(wt, [".codeloop-review.json"], ["node_modules/pkg/x.js"], base);
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(join(wt.worktreePath, "node_modules"), { recursive: true, force: true });
  }
});

test("dropOrchestratorTempFiles: removes known temps and unstages", async () => {
  await writeFile(join(wt.worktreePath, ".codeloop-review.json"), "{}", "utf8");
  await writeFile(join(wt.worktreePath, ".codeloop-plan.md"), "# plan", "utf8");
  await wt.addAllAndCommit("with temps", "engine");
  await dropOrchestratorTempFiles(wt.worktreePath);
  await assert.rejects(() => access(join(wt.worktreePath, ".codeloop-review.json")));
  await assert.rejects(() => access(join(wt.worktreePath, ".codeloop-plan.md")));
});
