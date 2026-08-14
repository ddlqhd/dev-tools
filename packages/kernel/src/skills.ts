import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SKILL_TARGET_DIRS = [
  ".opencode/skills",
  ".claude/skills",
  ".cursor/skills",
] as const;

/** Per-target manifest recording which skill dirs were installed by us. */
export const SYNC_MANIFEST = ".codeloop-sync.json";

export interface SyncSkillsOptions {
  /** Directory containing skill folders (each with SKILL.md). */
  sourceDir: string;
  /** Repo where skills are installed into. Defaults to process.cwd(). */
  projectDir?: string;
  /** Target dirs relative to projectDir. Defaults to SKILL_TARGET_DIRS. */
  targets?: readonly string[];
}

export interface SyncSkillsResult {
  target: string;
  skills: string[];
}

function readManifest(manifestPath: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as { skills?: unknown };
    if (Array.isArray(raw.skills)) {
      return raw.skills.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // missing or malformed manifest: conservative, delete nothing
  }
  return [];
}

/**
 * Mirror the skills under sourceDir into each target dir of projectDir.
 *
 * Only directories recorded in the target's manifest (i.e. installed by a
 * previous sync) are removed and re-copied, so the synced set always matches
 * the source while user-owned skills in the same target dir are preserved.
 * A target without a manifest is treated as untouched: existing skills are
 * left alone and synced skills are copied in.
 */
export function syncSkills(options: SyncSkillsOptions): SyncSkillsResult[] {
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const sourceDir = resolve(options.sourceDir);
  if (!statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`skills source dir not found: ${sourceDir}`);
  }
  const skills = readdirSync(sourceDir);
  const results: SyncSkillsResult[] = [];
  for (const target of options.targets ?? SKILL_TARGET_DIRS) {
    const dest = join(projectDir, target);
    if (statSync(dest, { throwIfNoEntry: false })?.isDirectory()) {
      for (const name of readManifest(join(dest, SYNC_MANIFEST))) {
        rmSync(join(dest, name), { recursive: true, force: true });
      }
    }
    mkdirSync(dest, { recursive: true });
    for (const name of skills) {
      cpSync(join(sourceDir, name), join(dest, name), { recursive: true });
    }
    writeFileSync(
      join(dest, SYNC_MANIFEST),
      `${JSON.stringify({ skills }, null, 2)}\n`,
      "utf8",
    );
    results.push({ target, skills });
  }
  return results;
}