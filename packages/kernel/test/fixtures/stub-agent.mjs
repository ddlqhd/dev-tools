#!/usr/bin/env node
// Stub Cursor `agent` CLI for integration tests.
// Driven by argv (mirrors `agent -p --output-format stream-json ...`) and env:
//   CODELOOP_STUB_LOG    — jsonl of every invocation {args, prompt, cwd}
//   CODELOOP_STUB_STATE  — path to JSON {reviewTurn, reviewAlwaysFail, verifyFailOnce}
// Behaviors by prompt keyword (mirrors prompts/index.ts):
//   planning           → emits a plan-shaped result line
//   reviewing          → writes .codeloop-review.json (first turn fails by default)
//   fixing review      → no-op
//   verifying          → writes .codeloop-verify.json (once-fail option)
//   final git commit   → squashes WIP commits onto base with a proper message
//   otherwise (code)   → writes feature.txt
import { appendFileSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const args = process.argv.slice(2);
const cwd = arg("--workspace") ?? process.cwd();
const prompt = args[args.length - 1] ?? "";
const mode = arg("--mode") ?? "";

if (process.env.CODELOOP_STUB_LOG) {
  appendFileSync(process.env.CODELOOP_STUB_LOG, JSON.stringify({ args, prompt, cwd, mode }) + "\n");
}

function readState() {
  const path = process.env.CODELOOP_STUB_STATE;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  const path = process.env.CODELOOP_STUB_STATE;
  if (!path) return;
  writeFileSync(path, JSON.stringify(state));
}

function emit(line) {
  process.stdout.write(line + "\n");
}

function emitResult(text) {
  emit(JSON.stringify({ type: "result", session_id: "stub-session", result: text }));
}

function writeJsonFile(name, value) {
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, name), JSON.stringify(value, null, 2));
}

const PLAN = `# Goal
Implement the stub feature end to end with tests.

# Approach
1. Create the feature file.
2. Wire it into the build.
3. Add tests.

# Files likely to change
- feature.txt

# Risks
Low risk, stub only.

# Test plan
Run pnpm test.`;

if (/planning/.test(prompt)) {
  emitResult(PLAN);
  process.exit(0);
}

if (/reviewing/.test(prompt)) {
  const state = readState();
  const turn = state.reviewTurn ?? 0;
  const alwaysFail = state.reviewAlwaysFail === true;
  const fail = alwaysFail || turn === 0;
  writeState({ ...state, reviewTurn: turn + 1 });
  writeJsonFile(".codeloop-review.json", {
    passed: !fail,
    summary: fail ? "stub found an issue" : "stub is satisfied",
    comments: fail
      ? [
          {
            id: "stub-1",
            severity: "major",
            comment: "stub review finding",
            status: "open",
          },
        ]
      : [],
  });
  emitResult(fail ? "Review failed: one major issue." : "Review passed.");
  process.exit(0);
}

if (/verifying/.test(prompt)) {
  const state = readState();
  const failOnce = state.verifyFailOnce === true;
  state.verifyFailOnce = false;
  writeState(state);
  writeJsonFile(".codeloop-verify.json", {
    passed: !failOnce,
    summary: failOnce ? "stub check failed once" : "all stub checks passed",
    checksRun: ["stub-check"],
    failures: failOnce
      ? [{ check: "stub-check", command: "node stub-check", detail: "expected failure" }]
      : [],
  });
  emitResult(failOnce ? "Verification failed." : "Verification passed.");
  process.exit(0);
}

if (/final git commit/.test(prompt)) {
  const baseMatch = /base commit \(exclusive\): ([0-9a-f]{6,40})/.exec(prompt);
  const base = baseMatch?.[1];
  try {
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe" });
    if (base) {
      execFileSync("git", ["reset", "--soft", base], { cwd, stdio: "pipe" });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=stub-engine",
          "-c",
          "user.email=stub@codeloop.local",
          "commit",
          "-m",
          "feat: stub change",
        ],
        { cwd, stdio: "pipe" },
      );
    } else {
      // No base extracted: rely on a plain amend of whatever exists.
      execFileSync(
        "git",
        [
          "-c",
          "user.name=stub-engine",
          "-c",
          "user.email=stub@codeloop.local",
          "commit",
          "--amend",
          "-m",
          "feat: stub change",
        ],
        { cwd, stdio: "pipe" },
      );
    }
  } catch {
    // nothing staged / empty — leave as-is, orchestrator decides
  }
  emitResult("Committed.");
  process.exit(0);
}

// code / fix turns: make a real change so the worktree is dirty
mkdirSync(join(cwd, "src"), { recursive: true });
writeFileSync(join(cwd, "src", "feature.txt"), "stub implementation\n");
emitResult("Implemented the feature.");
process.exit(0);
