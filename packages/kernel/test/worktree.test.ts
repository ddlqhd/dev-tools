import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createTaskWorktree,
  createInplaceWorktree,
  openExistingWorktree,
} from "../src/git/worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "codeloop-wt-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@codeloop.local"]);
  git(repo, ["config", "user.name", "test"]);
  await writeFile(join(repo, "README.md"), "# repo\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("createTaskWorktree: creates branch + linked worktree", async () => {
  const wt = await createTaskWorktree({
    repoPath: repo,
    worktreeRoot: join(repo, ".codeloop", "worktrees"),
    branchPrefix: "codeloop/",
    taskId: "abc123",
  });
  try {
    assert.match(wt.worktreePath, /worktrees\/abc123$/);
    assert.equal(wt.branch, "codeloop/abc123");
    assert.equal(wt.baseCommit, git(repo, ["rev-parse", "HEAD"]));
    assert.equal(git(repo, ["worktree", "list"]).includes(wt.worktreePath), true);
  } finally {
    git(repo, ["worktree", "remove", "--force", wt.worktreePath]);
    git(repo, ["branch", "-D", "codeloop/abc123"]);
  }
});

test("createTaskWorktree: existingBranch reclaims a branch held by a stale worktree", async () => {
  const stalePath = join(repo, "stale-wt");
  git(repo, ["worktree", "add", "-b", "feature", stalePath]);
  git(stalePath, ["commit", "--allow-empty", "-m", "wip on feature"]);

  const wt = await createTaskWorktree({
    repoPath: repo,
    worktreeRoot: join(repo, ".codeloop", "worktrees"),
    branchPrefix: "codeloop/",
    taskId: "fix1",
    existingBranch: "feature",
  });
  try {
    assert.equal(wt.branch, "feature");
    // The stale worktree must have been removed, the new one holds the branch.
    assert.equal(git(repo, ["worktree", "list"]).includes(stalePath), false);
    assert.equal(git(repo, ["worktree", "list"]).includes(wt.worktreePath), true);
    // Task base is the branch head (not repo HEAD).
    assert.equal(wt.baseCommit, git(repo, ["rev-parse", "feature"]));
    assert.equal(await wt.commitCountSince(wt.baseCommit), 0);
  } finally {
    git(repo, ["worktree", "remove", "--force", wt.worktreePath]);
  }
});

test("WorktreeHandle: commit lifecycle and git queries", async () => {
  const wt = await createTaskWorktree({
    repoPath: repo,
    worktreeRoot: join(repo, ".codeloop", "worktrees"),
    branchPrefix: "codeloop/",
    taskId: "abc123",
  });
  try {
    const base = wt.baseCommit;
    assert.equal(await wt.commitCountSince(base), 0);

    await writeFile(join(wt.worktreePath, "a.txt"), "hello\n", "utf8");
    assert.notEqual((await wt.statusPorcelain()).trim(), "");
    const files = await wt.changedFiles();
    assert.ok(files.includes("a.txt"));

    const sha = await wt.addAllAndCommit("wip change", "engine");
    assert.equal(await wt.commitCountSince(base), 1);
    assert.equal(await wt.head(), sha);
    assert.equal(await wt.lastCommitMessage(), "wip change");

    // treeHash stable across identical content
    const tree1 = await wt.treeHash("HEAD");
    await wt.addAllAndCommit("another wip", "engine");
    const tree2 = await wt.treeHash("HEAD");
    assert.equal(tree1, tree2, "identical trees must hash identically");

    await wt.resetHard(base);
    assert.equal(await wt.head(), base);
    assert.equal((await wt.statusPorcelain()).trim(), "");
    assert.equal(await wt.commitCountSince(base), 0);
  } finally {
    git(repo, ["worktree", "remove", "--force", wt.worktreePath]);
    git(repo, ["branch", "-D", "codeloop/abc123"]);
  }
});

test("createInplaceWorktree: clean repo ok, dirty rejected, detached rejected", async () => {
  const wt = await createInplaceWorktree(repo);
  assert.equal(wt.worktreePath, repo);
  assert.equal(wt.branch, "main");
  assert.equal(wt.baseCommit, git(repo, ["rev-parse", "HEAD"]));

  await writeFile(join(repo, "dirty.txt"), "x\n", "utf8");
  await assert.rejects(() => createInplaceWorktree(repo), /clean working tree/);
  await rm(join(repo, "dirty.txt"));

  git(repo, ["checkout", "--detach", "HEAD"]);
  await assert.rejects(() => createInplaceWorktree(repo), /detached HEAD/);
});

test("openExistingWorktree: reopens a worktree handle", async () => {
  const wt = await createTaskWorktree({
    repoPath: repo,
    worktreeRoot: join(repo, ".codeloop", "worktrees"),
    branchPrefix: "codeloop/",
    taskId: "abc123",
  });
  try {
    const reopened = await openExistingWorktree(repo, wt.worktreePath, "codeloop/abc123", wt.baseCommit);
    assert.equal(await reopened.head(), await wt.head());
    assert.equal(reopened.branch, "codeloop/abc123");
  } finally {
    git(repo, ["worktree", "remove", "--force", wt.worktreePath]);
    git(repo, ["branch", "-D", "codeloop/abc123"]);
  }
});
