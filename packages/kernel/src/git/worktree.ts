import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const TEMP_FILES = [
  ".codeloop-plan.md",
  ".codeloop-review.json",
  ".codeloop-verify.json",
];

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
  /** Commits reachable from HEAD but not from `base`. */
  commitCountSince(base: string): Promise<number>;
  /** Tree object id of a ref — identical trees mean identical content. */
  treeHash(ref: string): Promise<string>;
  lastCommitMessage(): Promise<string>;
}

export async function createTaskWorktree(opts: {
  repoPath: string;
  worktreeRoot: string;
  branchPrefix: string;
  taskId: string;
  baseRef?: string;
  /** Check out this existing branch instead of creating codeloop/<taskId>. */
  existingBranch?: string;
}): Promise<GitWorktree> {
  const branch = opts.existingBranch || `${opts.branchPrefix}${opts.taskId}`;
  const worktreePath = join(opts.worktreeRoot, opts.taskId);
  await mkdir(dirname(worktreePath), { recursive: true });

  if (opts.existingBranch) {
    // Make sure we actually have the branch locally (e.g. pushed by another
    // machine); fetch it from origin when missing.
    const local = await git(opts.repoPath, ["rev-parse", "--verify", branch]).catch(() => null);
    if (!local) {
      await git(opts.repoPath, ["fetch", "origin", branch]);
      await git(opts.repoPath, [
        "worktree",
        "add",
        "--track",
        "-b",
        branch,
        worktreePath,
        `origin/${branch}`,
      ]);
    } else {
      // Best-effort fast-forward to origin before starting (branch is not
      // checked out anywhere yet, so updating the ref is safe).
      await git(opts.repoPath, ["fetch", "origin", `${branch}:${branch}`]).catch(() => undefined);
      // A delivered task's worktree may still hold the branch checked out
      // (worktrees are not auto-removed after completion). Such a worktree is
      // inert — its task is done — so reclaim the branch before adding ours.
      const holder = await findWorktreeHoldingBranch(opts.repoPath, branch);
      if (holder) {
        await git(opts.repoPath, ["worktree", "remove", "--force", holder]).catch(() => undefined);
      }
      await git(opts.repoPath, ["worktree", "add", worktreePath, branch]);
    }
    // The task starts from the branch head, not the repo checkout's HEAD.
    const startCommit = (await git(opts.repoPath, ["rev-parse", branch])).trim();
    return new WorktreeHandle(opts.repoPath, worktreePath, branch, startCommit);
  }

  const base = opts.baseRef ?? "HEAD";
  const baseCommit = (await git(opts.repoPath, ["rev-parse", base])).trim();
  await git(opts.repoPath, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);

  return new WorktreeHandle(opts.repoPath, worktreePath, branch, baseCommit);
}

/**
 * Path of the worktree currently holding `branch` checked out, if any.
 * Parses `git worktree list --porcelain` (entries: worktree/HEAD/branch…).
 */
async function findWorktreeHoldingBranch(
  repoPath: string,
  branch: string,
): Promise<string | null> {
  const out = await git(repoPath, ["worktree", "list", "--porcelain"]).catch(() => "");
  const target = `refs/heads/${branch}`;
  let currentPath: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && currentPath) {
      if (line.slice("branch ".length).trim() === target) return currentPath;
      currentPath = null;
    }
  }
  return null;
}

/**
 * Inplace mode: operate on the repository checkout itself. Pause/rollback uses
 * `reset --hard` + `clean -fd`, so pre-existing uncommitted work is refused
 * rather than silently destroyed.
 */
export async function createInplaceWorktree(repoPath: string): Promise<GitWorktree> {
  await excludeCodeloopState(repoPath);

  const status = await git(repoPath, ["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error(
      `Inplace mode needs a clean working tree — commit or stash first:\n${status.trim()}`,
    );
  }

  const branch = (await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (branch === "HEAD") {
    throw new Error("Inplace mode needs a checked-out branch (repo is in detached HEAD)");
  }
  const baseCommit = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

  return new WorktreeHandle(repoPath, repoPath, branch, baseCommit);
}

/**
 * Inplace mode shares its checkout with `.codeloop/`, so the state directory has
 * to be invisible to git: otherwise `add -A` commits it and `clean -fd` deletes
 * the running task's own store. Uses `.git/info/exclude` to leave the
 * repository's tracked `.gitignore` alone.
 */
async function excludeCodeloopState(repoPath: string): Promise<void> {
  const gitCommonDir = (await git(repoPath, ["rev-parse", "--git-common-dir"])).trim();
  const gitDir = isAbsolute(gitCommonDir) ? gitCommonDir : join(repoPath, gitCommonDir);
  const excludePath = join(gitDir, "info", "exclude");

  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch {
    // no exclude file yet
  }
  const patterns = new Set(["/.codeloop/", ".codeloop/", ".codeloop"]);
  if (content.split("\n").some((line) => patterns.has(line.trim()))) return;

  await mkdir(dirname(excludePath), { recursive: true });
  const prefix = content.trim() ? `${content.trimEnd()}\n` : "";
  await writeFile(excludePath, `${prefix}/.codeloop/\n`, "utf8");
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

  async commitCountSince(base: string): Promise<number> {
    const out = await git(this.worktreePath, ["rev-list", "--count", `${base}..HEAD`]);
    return Number.parseInt(out.trim(), 10);
  }

  async treeHash(ref: string): Promise<string> {
    return (await git(this.worktreePath, ["rev-parse", `${ref}^{tree}`])).trim();
  }

  async lastCommitMessage(): Promise<string> {
    return (await git(this.worktreePath, ["log", "-1", "--pretty=%B"])).trim();
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
    for (const name of TEMP_FILES) {
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
      for (const name of TEMP_FILES) {
        try {
          await unlink(join(this.worktreePath, name));
        } catch {
          // ok
        }
      }
      await git(this.worktreePath, ["add", "-A"]);
      // Ensure orchestrator temp files are not part of the squash commit.
      try {
        await git(this.worktreePath, ["reset", "HEAD", "--", ...TEMP_FILES]);
      } catch {
        // ok if paths were never staged
      }
      for (const name of TEMP_FILES) {
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
