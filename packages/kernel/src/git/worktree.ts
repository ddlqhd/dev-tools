import { spawn } from "node:child_process";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface GitWorktree {
  repoPath: string;
  worktreePath: string;
  branch: string;
  /** SHA the task branch was created from (exclusive base for squash). */
  baseCommit: string;
  head(): Promise<string>;
  statusPorcelain(): Promise<string>;
  addAllAndCommit(message: string, author: "engine" | "human"): Promise<string>;
  /** Soft-reset to base and create one commit with the full tree. */
  squashToBase(message: string, author: "engine" | "human"): Promise<string>;
  resetHard(sha: string): Promise<void>;
  diffStat(): Promise<string>;
  changedFiles(): Promise<string[]>;
}

export async function createTaskWorktree(opts: {
  repoPath: string;
  worktreeRoot: string;
  branchPrefix: string;
  taskId: string;
  baseRef?: string;
}): Promise<GitWorktree> {
  const branch = `${opts.branchPrefix}${opts.taskId}`;
  const worktreePath = join(opts.worktreeRoot, opts.taskId);
  await mkdir(dirname(worktreePath), { recursive: true });

  const base = opts.baseRef ?? "HEAD";
  const baseCommit = (await git(opts.repoPath, ["rev-parse", base])).trim();
  await git(opts.repoPath, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);

  return new WorktreeHandle(opts.repoPath, worktreePath, branch, baseCommit);
}

export async function openExistingWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseCommit: string,
): Promise<GitWorktree> {
  return new WorktreeHandle(repoPath, worktreePath, branch, baseCommit);
}

class WorktreeHandle implements GitWorktree {
  constructor(
    readonly repoPath: string,
    readonly worktreePath: string,
    readonly branch: string,
    readonly baseCommit: string,
  ) {}

  async head(): Promise<string> {
    return (await git(this.worktreePath, ["rev-parse", "HEAD"])).trim();
  }

  async statusPorcelain(): Promise<string> {
    return git(this.worktreePath, ["status", "--porcelain"]);
  }

  async changedFiles(): Promise<string[]> {
    const out = await git(this.worktreePath, ["diff", "--name-only", "HEAD"]);
    const staged = await git(this.worktreePath, ["diff", "--name-only", "--cached"]);
    const untracked = await git(this.worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    // Important: do NOT spread the git stdout strings (that iterates characters).
    const names = [out, staged, untracked]
      .join("\n")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return [...new Set(names)];
  }

  async diffStat(): Promise<string> {
    return git(this.worktreePath, ["diff", "--stat", "HEAD"]);
  }

  async addAllAndCommit(message: string, author: "engine" | "human"): Promise<string> {
    await git(this.worktreePath, ["add", "-A"]);
    const status = await this.statusPorcelain();
    if (!status.trim()) {
      return this.head();
    }

    await commitWithAuthor(this.worktreePath, message, author);
    return this.head();
  }

  async squashToBase(message: string, author: "engine" | "human"): Promise<string> {
    // Drop orchestrator temp files before staging.
    for (const name of [".codeloop-plan.md", ".codeloop-review.json"]) {
      try {
        await unlink(join(this.worktreePath, name));
      } catch {
        // ok
      }
    }

    const head = await this.head();
    if (head === this.baseCommit) {
      // No commits yet — stage working tree if any
      await git(this.worktreePath, ["add", "-A"]);
      const status = await this.statusPorcelain();
      if (!status.trim()) {
        return head;
      }
      await commitWithAuthor(this.worktreePath, message, author);
      return this.head();
    }

    // Keep the full tree at HEAD, rewrite history to a single commit on base.
    // Soft reset leaves the prior HEAD tree in the index; also stage any
    // uncommitted working-tree changes so the squash is complete.
    // If anything fails after soft-reset, restore the original HEAD.
    try {
      await git(this.worktreePath, ["reset", "--soft", this.baseCommit]);
      for (const name of [".codeloop-plan.md", ".codeloop-review.json"]) {
        try {
          await unlink(join(this.worktreePath, name));
        } catch {
          // ok
        }
      }
      await git(this.worktreePath, ["add", "-A"]);
      // Ensure orchestrator temp files are not part of the squash commit.
      try {
        await git(this.worktreePath, [
          "reset",
          "HEAD",
          "--",
          ".codeloop-plan.md",
          ".codeloop-review.json",
        ]);
      } catch {
        // ok if paths were never staged
      }
      for (const name of [".codeloop-plan.md", ".codeloop-review.json"]) {
        try {
          await unlink(join(this.worktreePath, name));
        } catch {
          // ok
        }
      }

      const status = await this.statusPorcelain();
      if (!status.trim()) {
        // Soft reset with identical tree to base — nothing to commit.
        // Restore original HEAD so we don't leave the branch at base with a dirty index.
        await git(this.worktreePath, ["reset", "--hard", head]);
        return head;
      }

      await commitWithAuthor(this.worktreePath, message, author);
      return this.head();
    } catch (err) {
      try {
        await this.resetHard(head);
      } catch {
        // best-effort restore
      }
      throw err;
    }
  }

  async resetHard(sha: string): Promise<void> {
    await git(this.worktreePath, ["reset", "--hard", sha]);
    await git(this.worktreePath, ["clean", "-fd"]);
  }
}

async function commitWithAuthor(
  cwd: string,
  message: string,
  author: "engine" | "human",
): Promise<void> {
  const name = author === "human" ? "codeloop-human" : "codeloop-engine";
  const email = author === "human" ? "human@codeloop.local" : "engine@codeloop.local";
  await git(cwd, [
    "-c",
    `user.name=${name}`,
    "-c",
    `user.email=${email}`,
    "commit",
    "-m",
    message,
  ]);
}

export async function git(cwd: string, args: string[], attempts = 5): Promise<string> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await gitOnce(cwd, args);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/index\.lock/i.test(msg) && i < attempts) {
        await new Promise((r) => setTimeout(r, 200 * i));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function gitOnce(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
    child.on("error", reject);
  });
}
