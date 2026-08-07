import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface GitWorktree {
  repoPath: string;
  worktreePath: string;
  branch: string;
  head(): Promise<string>;
  statusPorcelain(): Promise<string>;
  addAllAndCommit(message: string, author: "engine" | "human"): Promise<string>;
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
  await git(opts.repoPath, ["worktree", "add", "-b", branch, worktreePath, base]);

  return new WorktreeHandle(opts.repoPath, worktreePath, branch);
}

export async function openExistingWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<GitWorktree> {
  return new WorktreeHandle(repoPath, worktreePath, branch);
}

class WorktreeHandle implements GitWorktree {
  constructor(
    readonly repoPath: string,
    readonly worktreePath: string,
    readonly branch: string,
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
    return [...new Set([...out, ...staged, ...untracked].join("\n").split("\n").filter(Boolean))];
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

    const name = author === "human" ? "codeloop-human" : "codeloop-engine";
    const email = author === "human" ? "human@codeloop.local" : "engine@codeloop.local";
    await git(
      this.worktreePath,
      ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", message],
    );
    return this.head();
  }

  async resetHard(sha: string): Promise<void> {
    await git(this.worktreePath, ["reset", "--hard", sha]);
    await git(this.worktreePath, ["clean", "-fd"]);
  }
}

export function git(cwd: string, args: string[]): Promise<string> {
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
