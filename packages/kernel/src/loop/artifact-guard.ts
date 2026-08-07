import { unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { git, type GitWorktree } from "../git/worktree.js";

const ORCHESTRATOR_TEMP = new Set([".codeloop-plan.md", ".codeloop-review.json"]);

/**
 * After an artifactWriteOnly turn, ensure the worktree only changed allowed
 * orchestrator files. Unexpected edits are reverted, then an error is thrown.
 */
export async function assertOnlyAllowedWrites(
  worktree: GitWorktree,
  allowedBasenames: string[],
  filesChangedFromEngine: string[],
  preHead: string,
): Promise<void> {
  const allowed = new Set(allowedBasenames);
  const dirty = await worktree.changedFiles();
  const fromEngine = (Array.isArray(filesChangedFromEngine) ? filesChangedFromEngine : [])
    .filter((p): p is string => typeof p === "string" && p.length > 1)
    .map((p) => p.replace(/\\/g, "/"));
  const candidates = new Set<string>([...dirty, ...fromEngine]);

  const violations = [...candidates].filter((path) => {
    const norm = path.replace(/\\/g, "/");
    const base = basename(norm);
    if (allowed.has(base) || allowed.has(norm)) return false;
    // Ignore empty / unknown markers from the stream parser
    if (path === "?" || path === "" || path.length <= 1) return false;
    // Worktree may carry a symlink to the repo's node_modules (see linkRepoNodeModules).
    if (base === "node_modules" || norm === "node_modules" || norm.startsWith("node_modules/")) {
      return false;
    }
    return true;
  });

  if (violations.length === 0) return;

  // Restore to pre-turn HEAD so unauthorized edits never stick.
  await worktree.resetHard(preHead);
  // Drop any leftover orchestrator temps that resetHard might leave if untracked
  // was cleaned — resetHard already runs clean -fd.
  for (const name of ORCHESTRATOR_TEMP) {
    try {
      await unlink(join(worktree.worktreePath, name));
    } catch {
      // ok
    }
  }

  throw new Error(
    `artifactWriteOnly violation: unexpected writes [${violations.join(", ")}]. ` +
      `Allowed: ${allowedBasenames.join(", ")}. Worktree restored to ${preHead.slice(0, 8)}.`,
  );
}

/** Unstage/remove known orchestrator temp files from the index and disk. */
export async function dropOrchestratorTempFiles(worktreePath: string): Promise<void> {
  for (const name of ORCHESTRATOR_TEMP) {
    try {
      await git(worktreePath, ["reset", "HEAD", "--", name]);
    } catch {
      // ok
    }
    try {
      await unlink(join(worktreePath, name));
    } catch {
      // ok
    }
  }
}
