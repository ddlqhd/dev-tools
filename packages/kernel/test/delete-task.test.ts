import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { KernelRuntime } from "@devtools/kernel";
import { cleanupRepo, freshRepo } from "./helpers.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("deleteTask: removes linked worktree, db row, task dir, and self-created branch", async () => {
  const repo = await freshRepo({
    configYaml: "version: 1\npipeline: m1-minimal\ninplace: false\n",
  });
  const rt = await KernelRuntime.open(repo);
  try {
    const handle = await rt.createTask({
      requirement: "delete me",
      repoPath: repo,
      pipeline: "m1-minimal",
      inplace: false,
    });
    const taskId = handle.taskId;
    const wtPath = handle.getWorktreePath();
    const branch = handle.getBranch();
    const taskDir = rt.store.taskDir(taskId);

    assert.equal(await pathExists(wtPath), true);
    assert.equal(await pathExists(taskDir), true);
    assert.ok(git(repo, ["branch", "--list", branch]).includes(branch));

    await rt.deleteTask(taskId);

    assert.equal(await pathExists(wtPath), false);
    assert.equal(await pathExists(taskDir), false);
    assert.equal(rt.store.getTask(taskId), undefined);
    assert.equal(git(repo, ["branch", "--list", branch]), "");
    assert.equal(git(repo, ["worktree", "list"]).includes(wtPath), false);
  } finally {
    rt.close();
    await cleanupRepo(repo);
  }
});

test("deleteTask: inplace keeps repo checkout and current branch", async () => {
  const repo = await freshRepo({
    configYaml: "version: 1\npipeline: m1-minimal\ninplace: true\n",
  });
  const rt = await KernelRuntime.open(repo);
  try {
    const handle = await rt.createTask({
      requirement: "inplace delete",
      repoPath: repo,
      pipeline: "m1-minimal",
      inplace: true,
    });
    const taskId = handle.taskId;
    const branch = handle.getBranch();
    assert.equal(handle.getWorktreePath(), repo);

    await rt.deleteTask(taskId);

    assert.equal(await pathExists(repo), true);
    assert.equal(await pathExists(join(repo, "README.md")), true);
    assert.equal(rt.store.getTask(taskId), undefined);
    assert.ok(git(repo, ["branch", "--list", branch]).includes(branch));
    assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), branch);
  } finally {
    rt.close();
    await cleanupRepo(repo);
  }
});

test("deleteTask: existingBranch is retained after worktree removal", async () => {
  const repo = await freshRepo({
    configYaml: "version: 1\npipeline: m1-minimal\ninplace: false\n",
  });
  git(repo, ["checkout", "-b", "feature/reuse"]);
  await writeFile(join(repo, "feat.txt"), "x\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "feature"]);
  git(repo, ["checkout", "main"]);

  const rt = await KernelRuntime.open(repo);
  try {
    const handle = await rt.createTask({
      requirement: "reuse branch",
      repoPath: repo,
      pipeline: "m1-minimal",
      inplace: false,
      existingBranch: "feature/reuse",
    });
    const taskId = handle.taskId;
    const wtPath = handle.getWorktreePath();
    assert.equal(handle.getBranch(), "feature/reuse");

    await rt.deleteTask(taskId);

    assert.equal(await pathExists(wtPath), false);
    assert.equal(rt.store.getTask(taskId), undefined);
    assert.ok(git(repo, ["branch", "--list", "feature/reuse"]).includes("feature/reuse"));
  } finally {
    rt.close();
    await cleanupRepo(repo);
  }
});

test("deleteTask: missing task is a no-op", async () => {
  const repo = await freshRepo({
    configYaml: "version: 1\npipeline: m1-minimal\n",
  });
  const rt = await KernelRuntime.open(repo);
  try {
    await rt.deleteTask("no-such-task");
  } finally {
    rt.close();
    await cleanupRepo(repo);
  }
});

test("deleteTask: clears checkpoints when present", async () => {
  const repo = await freshRepo({
    configYaml: "version: 1\npipeline: m1-minimal\ninplace: false\n",
  });
  const rt = await KernelRuntime.open(repo);
  try {
    const handle = await rt.createTask({
      requirement: "with checkpoint",
      repoPath: repo,
      pipeline: "m1-minimal",
      inplace: false,
    });
    const taskId = handle.taskId;
    await mkdir(rt.store.taskDir(taskId), { recursive: true });
    rt.store.saveCheckpoint({
      task_id: taskId,
      node_id: "plan",
      loop_stack: "[]",
      head_commit: "abc",
      engine_session_id: null,
      instructions: "[]",
      flow_cursor: '{"flowIndex":0}',
      node_outcomes: "{}",
      pending_intervention: null,
      updated_at: new Date().toISOString(),
    });
    assert.ok(rt.store.getCheckpoint(taskId));

    await rt.deleteTask(taskId);
    assert.equal(rt.store.getCheckpoint(taskId), undefined);
  } finally {
    rt.close();
    await cleanupRepo(repo);
  }
});
