---
name: codeloop-cli
description: Use when working with the codeloop CLI to create, run, monitor, and control automated AI development tasks. Triggers on codeloop, run task, watch, approve, reject, inject, pause, resume, abort, gate intervention, pipeline. Covers the codeloop command reference, task lifecycle, daemon mode, and the standard run → review → fix → commit workflow.
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

A task's `status` is one of: `running`, `waiting_human` (blocked on a gate
intervention), `paused`, `completed`, `failed`.

Task data lives under `.codeloop/` in the target repo (gitignored).
`--inplace` works in the repo itself; the default is a git worktree under
`.codeloop/worktrees/`.

Commands auto-detect a running daemon via `.codeloop/kernel.lock`: if present,
they forward to the daemon's HTTP API + WebSocket; otherwise they run the
kernel in-process (and `watch`/`show` fall back to replaying events from disk).

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
codeloop show <taskId> [--repo <path>]
```

Print task detail as pretty JSON on stdout (trace info goes to stderr, so
stdout stays parseable). Shows current node, loop counters, pipeline, artifacts,
git state, usage.

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

Lifecycle control. `resume -m` resumes a paused task with an instruction
(after e.g. the user fixed something or approved a gate). `resume` without
`-m` just continues.

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

Resolve a pending gate intervention (`status: waiting_human`). Default
`--request` is the pending one. `reject` attaches the message as a review
comment and the fix loop continues; `approve` lets the task proceed.

### serve

```bash
codeloop serve [--repo <path>] [--host 127.0.0.1] [--port 4700] [--token <token>]
```

Start the kernel daemon (control API + event WebSocket). Writes
`.codeloop/kernel.lock`; other commands then forward to it. Also exposes a
console UI at `http://host:port/`. Graceful shutdown on SIGINT/SIGTERM.

## Standard workflow

1. `codeloop doctor` — verify engine CLI ready.
2. `codeloop run "<requirement>" --repo <target>` — create and run the task.
3. `codeloop watch <taskId>` — follow progress; when the task hits a gate
   (`waiting_human`), review the output.
4. `codeloop approve <taskId>` to pass the gate, or
   `codeloop reject <taskId> -m "<review comments>"` to send back for fixes.
5. If the task pauses or blocks, use `codeloop resume <taskId> [-m ...]` or
   `codeloop inject <taskId> -m ...` to steer it.
6. `codeloop show <taskId>` for the final snapshot (branch, artifacts, usage).

## Notes

- Keep stdout parseable: details/logs that are not the primary output go to
  stderr.
- `autoApproveGates` defaults to `false`; use `--no-gate` for unattended runs.
- Engine config (models per stage, budget, git options) lives in
  `.codeloop/config.yaml` of the target repo.
- After a disconnect, replay with `watch --after <seq>` (events are
  seq-numbered for idempotent replay).
- This file is distributed by `codeloop sync-skills`. In dev, copies under
  `.opencode/skills/`, `.claude/skills/`, `.cursor/skills/` are generated by
  `scripts/sync-skills.mjs` — do not edit them; edit
  `skills/codeloop-cli/SKILL.md` and run `pnpm sync-skills`.
