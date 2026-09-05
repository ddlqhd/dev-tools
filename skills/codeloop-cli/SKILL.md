---
name: codeloop-cli
description: Use when working with the codeloop CLI to create, run, monitor, and control automated AI development tasks. Triggers on codeloop, run task, watch, show, handover, approve, reject, inject, pause, resume, abort, gate intervention, pipeline. Covers the command reference, task lifecycle, daemon mode, and taking over a failed/running/completed task from its full snapshot.
---

# codeloop CLI

codeloop is the L1 kernel CLI for automated AI development tasks. A task runs an
explicitly orchestrated pipeline (plan → plan review → code → code review →
fix loop → verify → commit) over a git repository, using an engine CLI
(Cursor Agent CLI by default) as the coding agent.

## Invocation

- **Installed**: `codeloop <command>`. The package bundles skills; run
  `codeloop sync-skills [--repo <path>]` once in a repo to install them into
  `.opencode/skills`, `.claude/skills`, `.cursor/skills`. It only replaces
  skills it installed previously (tracked in a `.codeloop-sync.json`
  manifest); your own skills in those directories are preserved.
- **In this monorepo (dev)**: `pnpm codeloop -- <command>` (runs
  `packages/cli/dist/index.js`). If the CLI seems stale, run `pnpm build` first.
  The dev copies under `.opencode/skills` / `.claude/skills` / `.cursor/skills`
  are kept in sync with `skills/` via `pnpm sync-skills`.
- **Targeting another repo**: most commands take `--repo <path>`
  (default: `process.cwd()`). When working on a different repository, always
  pass `--repo /path/to/target-repo`.
- **Health check**: `codeloop doctor` verifies engine CLI install/login and
  local config; exit code 0 = all ok.
- **Prerequisite**: Node.js ≥ 22.13, git, and a logged-in engine CLI
  (e.g. `agent login` for Cursor).

## Task lifecycle

A task's `status` (kernel/CLI layer) is one of: `created`, `running`,
`suspended` (blocked on a gate intervention or paused by an operator),
`completed`, `failed`, `aborted`. (`waiting_human` / `paused` are the
platform-server layer's names for the same `suspended` states.)

Task data lives under `.codeloop/` in the target repo (gitignored):
`kernel.db` (sqlite — tasks, checkpoints, usage), `events.jsonl` (event
stream), `tasks/<id>/` (pipeline snapshot, artifacts, engine logs), and git
worktrees. `--inplace` works in the repo itself; the default is a git worktree
under `.codeloop/worktrees/`.

Commands auto-detect a running daemon via `.codeloop/kernel.lock`: if present,
they forward to the daemon's HTTP API + WebSocket; otherwise they run the
kernel in-process (and `watch`/`show` fall back to replaying events from disk).

### The taskId

Every task gets a **short id** (8 chars, e.g. `a1b2c3d4`) generated when it is
created. `codeloop run` prints it as `task: <taskId>`; you can also look it up
with `codeloop list`. All subsequent commands (`watch`, `show`, `approve`,
`reject`, `inject`, `pause`, `resume`, `abort`) take this id as their first
argument — **capture it from the `run` output and reuse it**.

## Command reference

### doctor

```bash
codeloop doctor [--repo <path>]
```

Check engine CLI install/login and local config. Prints `✓`/`✗` per check.
Exit 0 if all ok, 1 otherwise.

### pipelines

```bash
codeloop pipelines [--repo <path>]
```

List builtin and custom pipeline templates with their validation status.
Builtin: `default-codeloop` / `m1-minimal` / `quick-fix` / `plan-only` / `review-only`.

### list

```bash
codeloop list [--repo <path>]
```

List tasks in the repo: `id  status  pipeline  branch  current_node`.

### show

```bash
codeloop show <taskId> [--repo <path>] [--events]
```

**Handover snapshot.** Same JSON shape whether the task is `running`,
`suspended`, `failed`, `completed`, or `aborted`, and whether a daemon is
running. Pretty-print `TaskDetail` on stdout (trace URL goes to stderr).

Always use this — not `watch` — when a human or agent needs to take over.

Key fields:

| Field | Use |
|---|---|
| `requirement` / `status` / `currentNode` / `error` | what ran and where it stopped |
| `paths` | absolute `taskDir`, `artifactsDir`, `eventsPath`, `worktreePath`, `pipelineSnapshot` |
| `artifacts[]` | deliverables; each has `key`, `ext`, **`path`** (open this file), `producedByNodeId` |
| `git` | `repoPath`, `worktreePath`, `branch`, `baseCommit`, `head`, `dirty` |
| `commits[]` | code deliverable SHAs (code lives in the worktree/branch, not `artifacts/`) |
| `workflow` / `stages[]` | pipeline graph + each node run (outcome, filesChanged, eventRange) |
| `interventions[]` / `pendingIntervention` | gate history and the waiting request |
| `usage` | tokens / turns folded from events |
| `lastSeq` | resume `watch --after` from here |

`--events` adds the raw event log as `events` on the same JSON object (can be
large). Prefer `artifacts[].path` and `stages` first; pull events only when
you need a node-level replay.

Typical artifact keys: `planDoc` (`.md`), `planComments` / `reviewComments`
(`.json`), `verifyReport` (`.json`).

### run

```bash
codeloop run "<requirement text>" [options]
codeloop run -f requirements.md --pipeline quick-fix --no-gate
```

Create and run a task. Requirement is a positional arg or `-f <file>`.

Options:

| Flag | Meaning |
|---|---|
| `-f, --file <path>` | read requirement from file |
| `--repo <path>` | target repo (default cwd) |
| `--pipeline <name>` | pipeline template (default from repo config) |
| `--no-gate` | auto-approve gate nodes (default: gates require human approval) |
| `--inplace` | work in the repo itself instead of a git worktree |
| `--sandbox` | sandbox write-mode engine turns |
| `--quiet` | less event output |
| `--plain` | disable interactive TUI (use when not in an interactive terminal) |

Exit code: 0 if completed, 1 if failed. With `--plain` (or non-interactive
terminal) output is text; `--no-gate` is useful for unattended runs.

Output: prints `task: <taskId>` (plus `status:`, `branch:`, `worktree:` in
plain mode) on completion. When a daemon is running (`codeloop serve`), run
kicks the task off in the background and prints `task: <taskId>` immediately —
the task continues after the command returns, so use `watch <taskId>` to follow
it. Run with `--no-gate` for fully unattended runs; otherwise gates suspend the
task until you `approve` or `reject` it.

### watch

```bash
codeloop watch <taskId> [--repo <path>] [--after <seq>] [--quiet] [--plain]
```

Attach to a running/suspended task and stream events. `--after <seq>` replays
events after a sequence number (resume after disconnect). Without a daemon,
replays historical events from disk.

### pause / resume / abort

```bash
codeloop pause <taskId>
codeloop resume <taskId> [-m "<instruction>"]
codeloop abort <taskId>
```

Lifecycle control. `resume` continues a `suspended`/`failed` task from its
last checkpoint — it rebuilds the interpreter state from the sqlite
`checkpoints` table (flow index, loop stack, node outcomes, instruction queue,
head commit) and hard-resets the worktree to the checkpoint commit before
re-running the node. `resume -m` also injects an instruction first. `resume`
without `-m` just continues.

### inject

```bash
codeloop inject <taskId> -m "<instruction>"
```

Inject an instruction into a running task without changing its state
(e.g. "don't touch legacy/", "use zod for validation").

### approve / reject

```bash
codeloop approve <taskId> [--request <requestId>]
codeloop reject <taskId> -m "<reason/comments>"
```

Resolve a pending gate intervention (task status `suspended`; the gate node
fires an `intervention.required` event with a `requestId`). Default
`--request` is the pending one. `reject` attaches the message as a review
comment and the fix loop continues; `approve` lets the task proceed.

### serve

```bash
codeloop serve [--repo <path>] [--host 127.0.0.1] [--port 4700] [--token <token>]
```

Start the kernel daemon (control API + event WebSocket). Writes
`.codeloop/kernel.lock`; other commands then forward to it. Also exposes a
console UI at `http://host:port/`. Graceful shutdown on SIGINT/SIGTERM.

## Handover / takeover

Use this when any task (failed, in-progress, gated, or done) should continue
as a human, or as an agent using this skill.

1. `codeloop list --repo <path>` — find `taskId` + status + `current_node`.
2. `codeloop show <taskId> --repo <path>` — the single source of truth.
3. Read `artifacts[].path` (plan, review comments, verify report).
4. Inspect code at `git.worktreePath` on `git.branch` (`commits[]` for SHAs).
   Do not treat `artifacts/` as the code tree.
5. Then either:
   - **Resume automation**: `codeloop resume <taskId> [-m "..."]` (or
     `approve` / `reject` if `pendingIntervention` is set).
   - **Take over manually**: work in `paths.worktreePath` using the
     requirement, plan, and review comments as context.

`show` does not change task state. `watch` is live follow only.

## Standard workflow

1. `codeloop doctor` — verify engine CLI ready.
2. `codeloop run "<requirement>" --repo <target>` — create and run the task.
   **Capture `task: <taskId>` from the output** (or get it via `codeloop list`).
3. `codeloop watch <taskId>` — follow progress; when the task hits a gate
   (`status: suspended`), review the output.
4. `codeloop approve <taskId>` to pass the gate, or
   `codeloop reject <taskId> -m "<review comments>"` to send back for fixes.
5. If the task pauses or blocks, use `codeloop resume <taskId> [-m ...]` or
   `codeloop inject <taskId> -m ...` to steer it.
6. `codeloop show <taskId>` for the handover snapshot (paths, artifacts, git,
   stages, usage). Same command for a failed or aborted run.

## Notes

- Keep stdout parseable: details/logs that are not the primary output go to
  stderr. `show` always emits one JSON object (`TaskDetail`, plus `events`
  when `--events` is set).
- `show` works without `codeloop serve`: it folds `kernel.db` +
  `events.jsonl` + `artifacts/` from disk. With a daemon it calls
  `GET /tasks/:id/detail` and returns the same shape.
- `autoApproveGates` defaults to `false`; use `--no-gate` for unattended runs.
- A gate is the `gate` pipeline node (see `codeloop pipelines`); hitting one
  sets the task `suspended` until approved or rejected. Rejecting re-enters
  the preceding loop with the comments fed back as review input.
- Resumability: `resume` works for `suspended`, `failed`, and `running` tasks
  with no live runner (e.g. daemon died). It restores the worktree to the
  checkpoint commit via `git reset --hard`, so uncommitted edits since the
  checkpoint are discarded.
- Engine config (models per stage, **prompts**, budget, git options) lives in
  `.codeloop/config.yaml` of the target repo. Edit `engines.<alias>.prompt`
  to customize a stage. Placeholders (`{{requirement}}`, `{{planDoc}}`,
  `{{reviewComments}}`, `{{instructions}}`, `{{previousPlan}}`, `{{branch}}`,
  `{{baseCommit}}`, `{{messageStyle}}`) are interpolated at run time; unknown
  `{{name}}` is left as-is. Empty `prompt` falls back to the built-in text.
  Do not rename `.codeloop-review.json` / `.codeloop-verify.json` in those
  prompts — the runners still look for those exact files. Full table:
  `docs/kernel-design.md` §2.5.
- After a disconnect, replay with `watch --after <seq>` (events are
  seq-numbered for idempotent replay).
- This file is distributed by `codeloop sync-skills`. In dev, copies under
  `.opencode/skills/`, `.claude/skills/`, `.cursor/skills/` are generated by
  `scripts/sync-skills.mjs` — do not edit them; edit
  `skills/codeloop-cli/SKILL.md` and run `pnpm sync-skills`.
