import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createTaskWorktree,
  createInplaceWorktree,
  openExistingWorktree,
  snapshotWorkingTreeInto,
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

test("snapshotWorkingTreeInto: copies dirty + untracked files without touching the source", async () => {
  await writeFile(join(repo, "README.md"), "# dirty\n", "utf8");
  await writeFile(join(repo, "new-file.txt"), "untracked\n", "utf8");
  git(repo, ["add", "README.md"]);

  const wt = await createTaskWorktree({
    repoPath: repo,
    worktreeRoot: join(repo, ".codeloop", "worktrees"),
    branchPrefix: "codeloop/",
    taskId: "review1",
  });
  try {
    assert.equal(await snapshotWorkingTreeInto(repo, wt), true);
    assert.equal(await wt.statusPorcelain(), "");
    assert.match(await wt.lastCommitMessage(), /snapshot working tree/);
    const readme = execFileSync("git", ["show", "HEAD:README.md"], {
      cwd: wt.worktreePath,
      encoding: "utf8",
    });
    assert.equal(readme, "# dirty\n");
    const added = execFileSync("git", ["show", "HEAD:new-file.txt"], {
      cwd: wt.worktreePath,
      encoding: "utf8",
    });
    assert.equal(added, "untracked\n");
    // Source checkout still has the user's WIP.
    assert.match(git(repo, ["status", "--porcelain"]), /README\.md/);
    assert.match(git(repo, ["status", "--porcelain"]), /new-file\.txt/);
    assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  } finally {
    git(repo, ["worktree", "remove", "--force", wt.worktreePath]);
    git(repo, ["branch", "-D", "codeloop/review1"]);
  }
});

test("snapshotWorkingTreeInto: HEAD excludes a dest node_modules symlink", async () => {
  await writeFile(join(repo, ".gitignore"), "node_modules/\n", "utf8");
  git(repo, ["add", ".gitignore"]);
  git(repo, ["commit", "-m", "ignore node_modules"]);
  await writeFile(join(repo, "README.md"), "# dirty\n", "utf8");
  await mkdir(join(repo, "node_modules"), { recursive: true });
  await writeFile(join(repo, "node_modules", "pkg"), "dep\n", "utf8");

  const wt = await createTaskWorktree({
    repoPath: repo,
    worktreeRoot: join(repo, ".codeloop", "worktrees"),
    branchPrefix: "codeloop/",
    taskId: "review-nm",
  });
  try {
    await symlink(join(repo, "node_modules"), join(wt.worktreePath, "node_modules"), "dir");
    assert.equal(await snapshotWorkingTreeInto(repo, wt), true);
    const tree = execFileSync("git", ["ls-tree", "-r", "-t", "--name-only", "HEAD"], {
      cwd: wt.worktreePath,
      encoding: "utf8",
    });
    assert.equal(
      tree.split("\n").includes("node_modules"),
      false,
      `snapshot HEAD must not contain node_modules:\n${tree}`,
    );
    const readme = execFileSync("git", ["show", "HEAD:README.md"], {
      cwd: wt.worktreePath,
      encoding: "utf8",
    });
    assert.equal(readme, "# dirty\n");
  } finally {
    git(repo, ["worktree", "remove", "--force", wt.worktreePath]);
    git(repo, ["branch", "-D", "codeloop/review-nm"]);
  }
});

test("createInplaceWorktree: dirty ok, detached rejected; resetHard is no-op", async () => {
  const clean = await createInplaceWorktree(repo);
  assert.equal(clean.worktreePath, repo);
  assert.equal(clean.branch, "main");
  assert.equal(clean.inplace, true);
  assert.equal(clean.baseCommit, git(repo, ["rev-parse", "HEAD"]));

  await writeFile(join(repo, "dirty.txt"), "x\n", "utf8");
  const headBefore = git(repo, ["rev-parse", "HEAD"]);
  const wt = await createInplaceWorktree(repo);
  assert.equal(wt.inplace, true);
  assert.match(await wt.statusPorcelain(), /dirty\.txt/);

  await wt.resetHard(headBefore);
  assert.equal(await wt.head(), headBefore);
  assert.match(await wt.statusPorcelain(), /dirty\.txt/);

  const reopened = await openExistingWorktree(repo, repo, "main", wt.baseCommit);
  assert.equal(reopened.inplace, true);
  await reopened.resetHard(headBefore);
  assert.match(await reopened.statusPorcelain(), /dirty\.txt/);

  await rm(join(repo, "dirty.txt"));
  git(repo, ["checkout", "--detach", "HEAD"]);
  await assert.rejects(() => createInplaceWorktree(repo), /detached HEAD/);
});

test("linked worktree: inplace is false and resetHard clears dirt", async () => {
  const wt = await createTaskWorktree({
    repoPath: repo,
    worktreeRoot: join(repo, ".codeloop", "worktrees"),
    branchPrefix: "codeloop/",
    taskId: "linked1",
  });
  try {
    assert.equal(wt.inplace, false);
    const base = wt.baseCommit;
    await writeFile(join(wt.worktreePath, "dirt.txt"), "y\n", "utf8");
    await wt.resetHard(base);
    assert.equal(await wt.head(), base);
    assert.equal((await wt.statusPorcelain()).trim(), "");
  } finally {
    git(repo, ["worktree", "remove", "--force", wt.worktreePath]);
    git(repo, ["branch", "-D", "codeloop/linked1"]);
  }
});

test("inplace squashToBase: identical-tree restore keeps pre-squash dirty files", async () => {
  // Empty commit on base → soft reset leaves index tree == base; restore with
  // --mixed before add -A so startup dirty files remain.
  git(repo, ["commit", "--allow-empty", "-m", "empty on top"]);
  await writeFile(join(repo, "wip.txt"), "keep me\n", "utf8");
  const headBefore = git(repo, ["rev-parse", "HEAD"]);
  const base = git(repo, ["rev-parse", "HEAD~1"]);

  const wt = await openExistingWorktree(repo, repo, "main", base);
  assert.equal(wt.inplace, true);
  assert.equal(await wt.head(), headBefore);

  const result = await wt.squashToBase("noop squash", "engine");
  assert.equal(result, headBefore);
  assert.equal(await wt.head(), headBefore);
  assert.match(await wt.statusPorcelain(), /wip\.txt/);
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
    assert.equal(reopened.inplace, false);
  } finally {
    git(repo, ["worktree", "remove", "--force", wt.worktreePath]);
    git(repo, ["branch", "-D", "codeloop/abc123"]);
  }
});
