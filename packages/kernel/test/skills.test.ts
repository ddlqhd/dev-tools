import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  readdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSkills, SYNC_MANIFEST, SKILL_TARGET_DIRS } from "../src/skills.js";

let root: string;
let source: string;
let project: string;

async function writeSkill(dir: string, name: string) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

async function readManifest(dir: string): Promise<string[]> {
  const raw = JSON.parse(await readFile(join(dir, SYNC_MANIFEST), "utf8")) as {
    skills: string[];
  };
  return raw.skills;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codeloop-skills-"));
  source = join(root, "skills");
  project = join(root, "project");
  await mkdir(source, { recursive: true });
  await writeSkill(source, "alpha");
  await writeSkill(source, "beta");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("syncSkills: mirrors source into all default targets + manifest", async () => {
  const results = syncSkills({ sourceDir: source, projectDir: project });
  assert.equal(results.length, SKILL_TARGET_DIRS.length);
  for (const target of SKILL_TARGET_DIRS) {
    const dir = join(project, target);
    const names = await readdir(dir);
    assert.deepEqual(names.sort(), [SYNC_MANIFEST, "alpha", "beta"], target);
    assert.deepEqual((await readManifest(dir)).sort(), ["alpha", "beta"]);
  }
});

test("syncSkills: preserves user-owned skills not in manifest", async () => {
  const target = join(project, ".opencode/skills");
  await writeSkill(target, "user-own");
  await writeSkill(target, "alpha"); // same name, pre-existing user copy

  syncSkills({ sourceDir: source, projectDir: project });
  syncSkills({ sourceDir: source, projectDir: project }); // idempotent re-run

  const names = await readdir(target);
  assert.deepEqual(names.sort(), [SYNC_MANIFEST, "alpha", "beta", "user-own"]);
  const alpha = await readFile(join(target, "alpha", "SKILL.md"), "utf8");
  assert.match(alpha, /name: alpha/);
});

test("syncSkills: removes previously synced skills that are gone from source", async () => {
  const target = join(project, ".opencode/skills");
  await writeSkill(target, "old-synced");
  await writeFile(join(target, SYNC_MANIFEST), JSON.stringify({ skills: ["old-synced"] }) + "\n");
  await writeSkill(target, "user-own");

  syncSkills({ sourceDir: source, projectDir: project });

  const names = await readdir(target);
  assert.deepEqual(names.sort(), [SYNC_MANIFEST, "alpha", "beta", "user-own"]);
});

test("syncSkills: without manifest, existing skills are left alone", async () => {
  const target = join(project, ".opencode/skills");
  await writeSkill(target, "legacy");

  syncSkills({ sourceDir: source, projectDir: project });

  const names = await readdir(target);
  assert.deepEqual(names.sort(), [SYNC_MANIFEST, "alpha", "beta", "legacy"]);
});

test("syncSkills: throws when source dir missing", () => {
  assert.throws(() => syncSkills({ sourceDir: join(root, "nope"), projectDir: project }));
});