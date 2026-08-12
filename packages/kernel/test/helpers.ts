import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelEvent, ReviewComment } from "@devtools/shared";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Path to the stub agent. Compiled tests live in dist-test/test/, so the
 * fixture resolves back up into the package's test/ directory.
 */
export const STUB_PATH = fileURLToPath(
  new URL("../../test/fixtures/stub-agent.mjs", import.meta.url),
);

export interface StubState {
  reviewTurn?: number;
  reviewAlwaysFail?: boolean;
  verifyFailOnce?: boolean;
}

export interface RepoOptions {
  pipeline?: string;
  configYaml?: string;
  customPipeline?: { name: string; yaml: string };
}

export async function freshRepo(opts: RepoOptions = {}): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "codeloop-e2e-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "e2e@codeloop.local"]);
  git(repo, ["config", "user.name", "e2e"]);
  await writeFile(join(repo, "README.md"), "# e2e\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  if (opts.customPipeline) {
    await mkdir(join(repo, ".codeloop", "pipelines"), { recursive: true });
    await writeFile(
      join(repo, ".codeloop", "pipelines", `${opts.customPipeline.name}.yaml`),
      opts.customPipeline.yaml,
      "utf8",
    );
  }
  if (opts.configYaml) {
    await mkdir(join(repo, ".codeloop"), { recursive: true });
    await writeFile(join(repo, ".codeloop", "config.yaml"), opts.configYaml, "utf8");
  }
  return repo;
}

export async function cleanupRepo(repo: string): Promise<void> {
  await rm(repo, { recursive: true, force: true });
}

export async function makeStubState(state: StubState): Promise<string> {
  const path = join(tmpdir(), `codeloop-stub-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, JSON.stringify({ reviewTurn: 0, ...state }), "utf8");
  return path;
}

export async function readStubLog(logPath: string): Promise<Array<{ args: string[]; prompt: string; cwd: string; mode: string }>> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(logPath, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function waitForEvent(
  events: KernelEvent[],
  predicate: (e: KernelEvent) => boolean,
  timeoutMs = 30_000,
): Promise<KernelEvent> {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = events.find(predicate);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for event; got types: ${events.map((e) => e.type).join(",")}`));
      }
    }, 50);
  });
}

export function reviewComments(texts: string[]): ReviewComment[] {
  return texts.map((comment, i) => ({
    id: `e2e-${i}`,
    severity: "major",
    comment,
    status: "open",
  }));
}
