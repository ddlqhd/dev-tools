#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import {
  createAndRunTask,
  doctor,
  listTasks,
  getTask,
  listBuiltinPipelines,
  loadPipeline,
  startKernelServer,
  readKernelLock,
  KernelRuntime,
  syncSkills,
} from "@devtools/kernel";
import type { TaskRunResult } from "@devtools/kernel";
import type {
  InterventionDecision,
  InterventionRequest,
  KernelEvent,
  ReviewComment,
} from "@devtools/shared";
import {
  PlainRenderer,
  printRunHeader,
  printRunSummary,
  promptPlainIntervention,
} from "./plain.js";
import { isTerminalEvent, TuiSession } from "./ui/session.js";
import type { TaskUiStatus } from "./ui/reducer.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("codeloop")
  .description("Automated AI development loop (engine adapters: cursor, opencode)")
  .version(VERSION)
  .showHelpAfterError()
  .configureHelp({ sortSubcommands: true });

program.addHelpText(
  "after",
  `
Examples:
  codeloop doctor                               check engine CLI install/login and config
  codeloop run "fix the flaky test" --no-gate   run a task unattended (auto-approve gates)
  codeloop run -f requirements.md --pipeline quick-fix
  codeloop watch <taskId>                       follow a running task
  codeloop approve <taskId>                     pass a pending gate
  codeloop reject <taskId> -m "comments"        send back for fixes
  codeloop serve                                start the kernel daemon (console UI)

Standard workflow:
  1. codeloop doctor
  2. codeloop run "<requirement>" --repo <path>
  3. codeloop watch <taskId>  (at a gate: review output, then approve or reject)
  4. codeloop show <taskId>   (final snapshot: branch, artifacts, usage)
`,
);

program
  .command("doctor")
  .description("Check engine CLI install/login and local config")
  .option("--repo <path>", "repo path", process.cwd())
  .action(async (opts: { repo: string }) => {
    const result = await doctor(resolve(opts.repo));
    for (const check of result.checks) {
      const mark = check.ok ? "✓" : "✗";
      console.log(`${mark} ${check.name}: ${check.detail}`);
    }
    process.exit(result.ok ? 0 : 1);
  });

program
  .command("pipelines")
  .description("List builtin and custom pipeline templates")
  .option("--repo <path>", "repo path", process.cwd())
  .action(async (opts: { repo: string }) => {
    const repo = resolve(opts.repo);
    const builtins = await listBuiltinPipelines();
    console.log("Builtin pipelines:");
    for (const name of builtins) {
      try {
        const loaded = await loadPipeline(name, repo);
        console.log(`  - ${name} (hash=${loaded.hash})`);
      } catch (err) {
        console.log(`  - ${name} (invalid: ${err instanceof Error ? err.message : err})`);
      }
    }
  });

program
  .command("list")
  .description("List tasks in this repo")
  .option("--repo <path>", "repo path", process.cwd())
  .action((opts: { repo: string }) => {
    const tasks = listTasks(resolve(opts.repo));
    if (tasks.length === 0) {
      console.log("No tasks yet.");
      return;
    }
    for (const t of tasks) {
      console.log(
        `${t.id}  ${t.status.padEnd(10)}  ${t.pipeline_name}  ${t.branch}  ${t.current_node ?? "-"}`,
      );
    }
  });

program
  .command("show")
  .argument("<taskId>")
  .description("Show task details")
  .option("--repo <path>", "repo path", process.cwd())
  .addHelpText("after", `
Examples:
  codeloop show <taskId>
  codeloop show <taskId> --repo /path/to/repo`,)
  .action(async (taskId: string, opts: { repo: string }) => {
    const repo = resolve(opts.repo);
    const lock = await readKernelLock(repo);
    if (lock) {
      const snap = await apiGet(lock, `/tasks/${taskId}`);
      console.log(JSON.stringify(snap, null, 2));
      // stderr keeps stdout parseable as JSON
      const tokenQ = lock.token ? `?token=${encodeURIComponent(lock.token)}` : "";
      console.error(`trace: http://${lock.host}:${lock.port}/tasks/${taskId}/view${tokenQ}`);
      return;
    }
    const task = getTask(repo, taskId);
    if (!task) {
      console.error(`Task not found: ${taskId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(task, null, 2));
  });

program
  .command("run")
  .description("Create and run a development task")
  .argument("[requirement]", "requirement text")
  .option("-f, --file <path>", "read requirement from file")
  .option("--repo <path>", "repo path", process.cwd())
  .option("--pipeline <name>", "pipeline template (default: from config)")
  .option("--no-gate", "auto-approve gate nodes")
  .option("--inplace", "work in the repo itself instead of a git worktree")
  .option("--sandbox", "sandbox write-mode engine turns")
  .option("--quiet", "less event output")
  .option("--plain", "disable the interactive TUI")
  .addHelpText("after", `
Examples:
  codeloop run "implement user login"
  codeloop run -f requirements.md --pipeline quick-fix --no-gate
  codeloop run "add endpoint tests" --repo /path/to/repo --inplace`,)
  .action(
    async (
      requirement: string | undefined,
      opts: {
        file?: string;
        repo: string;
        pipeline?: string;
        gate?: boolean;
        inplace?: boolean;
        sandbox?: boolean;
        quiet?: boolean;
        plain?: boolean;
      },
    ) => {
      let text = requirement ?? "";
      if (opts.file) {
        text = await readFile(resolve(opts.file), "utf8");
      }
      text = text.trim();
      if (!text) {
        console.error("Requirement required. Pass text or -f <file>.");
        process.exit(1);
      }

      const repoPath = resolve(opts.repo);
      const autoApprove = opts.gate === false;
      const useTui = !opts.plain && isInteractiveTerminal();

      // If daemon is running, create task via API
      const lock = await readKernelLock(repoPath);
      if (lock) {
        const created = (await apiPost(lock, "/tasks", {
          requirement: text,
          repoPath,
          pipeline: opts.pipeline,
          configOverrides: {
            autoApproveGates: autoApprove,
            inplace: opts.inplace,
            sandbox: opts.sandbox,
          },
        })) as { taskId: string; branch: string };
        if (useTui) {
          const status = await watchRemoteTask({
            taskId: created.taskId,
            repoPath,
            after: 0,
            quiet: opts.quiet,
            lock,
          });
          if (isTerminalStatus(status)) {
            process.exitCode = status === "completed" ? 0 : 1;
          }
          return;
        }
        console.log(`task: ${created.taskId} (via serve ${lock.host}:${lock.port})`);
        console.log(`branch: ${created.branch}`);
        console.log("Use: codeloop watch <taskId>");
        return;
      }

      const runOptions: LocalRunOptions = {
        requirement: text,
        repoPath,
        pipeline: opts.pipeline,
        autoApproveGates: autoApprove,
        inplace: opts.inplace,
        sandbox: opts.sandbox,
        quiet: opts.quiet,
      };
      const result = useTui
        ? await runLocalWithTui(runOptions)
        : await runLocalPlain(runOptions);
      printRunSummary(result, repoPath);
      process.exitCode = result.status === "completed" ? 0 : 1;
    },
  );

program
  .command("serve")
  .description("Start kernel daemon (control API + event WebSocket)")
  .option("--repo <path>", "repo path", process.cwd())
  .option("--host <host>", "bind host", "127.0.0.1")
  .option("--port <port>", "bind port", "4700")
  .option("--token <token>", "optional bearer token")
  .addHelpText("after", `
Examples:
  codeloop serve
  codeloop serve --port 4701 --token secret`,)
  .action(async (opts: { repo: string; host: string; port: string; token?: string }) => {
    const repoPath = resolve(opts.repo);
    const existing = await readKernelLock(repoPath);
    if (existing) {
      console.error(
        `Kernel already running at ${existing.host}:${existing.port} (pid ${existing.pid}).`,
      );
      process.exit(1);
    }
    const handle = await startKernelServer({
      repoPath,
      host: opts.host,
      port: Number(opts.port),
      token: opts.token,
    });
    console.log(`codeloop serve listening on ${handle.url}`);
    console.log(`console UI:          ${handle.url}/`);
    console.log(`lock: ${repoPath}/.codeloop/kernel.lock`);

    const shutdown = async () => {
      console.log("\nShutting down…");
      await handle.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });

program
  .command("sync-skills")
  .description("Install bundled skills into a repo (.opencode/.claude/.cursor)")
  .option("--repo <path>", "repo path", process.cwd())
  .action(async (opts: { repo: string }) => {
    const sourceDir = findSkillsDir();
    if (!sourceDir) {
      console.error(
        "Bundled skills not found (package built without the skills/ directory).",
      );
      process.exit(1);
    }
    const repo = resolve(opts.repo);
    const results = syncSkills({ sourceDir, projectDir: repo });
    for (const r of results) {
      console.log(`synced ${join(repo, r.target)} (${r.skills.join(", ")})`);
    }
  });

program
  .command("watch")
  .argument("<taskId>")
  .description("Attach to a running/suspended task and stream events")
  .option("--repo <path>", "repo path", process.cwd())
  .option("--after <seq>", "replay events after seq", "0")
  .option("--quiet", "hide engine output")
  .option("--plain", "disable the interactive TUI")
  .addHelpText("after", `
Examples:
  codeloop watch <taskId>
  codeloop watch <taskId> --after 42   resume viewing after a disconnect`,)
  .action(
    async (
      taskId: string,
      opts: { repo: string; after: string; quiet?: boolean; plain?: boolean },
    ) => {
      const repo = resolve(opts.repo);
      const lock = await readKernelLock(repo);
      if (!lock) {
        console.error("No kernel daemon (codeloop serve). Showing historical events from disk…");
        const runtime = await KernelRuntime.open(repo);
        const plain = new PlainRenderer();
        try {
          const handle = await runtime.attachTask(taskId);
          const events = await handle.events.readAfter(parseSequence(opts.after));
          for (const event of events) {
            if (opts.quiet && event.type === "engine.chunk") continue;
            plain.print(event);
          }
        } finally {
          plain.end();
          runtime.close();
        }
        return;
      }
      if (!opts.plain && isInteractiveTerminal()) {
        const status = await watchRemoteTask({
          taskId,
          repoPath: repo,
          after: parseSequence(opts.after),
          quiet: opts.quiet,
          lock,
        });
        if (isTerminalStatus(status)) {
          process.exitCode = status === "completed" ? 0 : 1;
        }
        return;
      }
      const status = await watchRemotePlain({
        taskId,
        after: parseSequence(opts.after),
        quiet: opts.quiet,
        lock,
      });
      if (isTerminalStatus(status)) {
        process.exitCode = status === "completed" ? 0 : 1;
      }
    },
  );

for (const action of ["pause", "resume", "abort"] as const) {
  program
    .command(action)
    .argument("<taskId>")
    .description(`${action} a task`)
    .option("--repo <path>", "repo path", process.cwd())
    .option("-m, --message <text>", "instruction (resume only)")
    .action(async (taskId: string, opts: { repo: string; message?: string }) => {
      const repo = resolve(opts.repo);
      const lock = await readKernelLock(repo);
      if (lock) {
        const body = action === "resume" ? { instruction: opts.message } : {};
        const result = await apiPost(lock, `/tasks/${taskId}/${action}`, body);
        console.log(JSON.stringify(result));
        return;
      }
      const runtime = await KernelRuntime.open(repo);
      try {
        const handle = await runtime.attachTask(taskId);
        if (action === "pause") await handle.pause();
        else if (action === "abort") await handle.abort();
        else {
          const result = await handle.resume(opts.message);
          console.log(JSON.stringify(result));
          return;
        }
        console.log({ ok: true, action });
      } finally {
        runtime.close();
      }
    });
}

program
  .command("inject")
  .description("Inject an instruction into a running task")
  .argument("<taskId>")
  .requiredOption("-m, --message <text>", "instruction text")
  .option("--repo <path>", "repo path", process.cwd())
  .action(async (taskId: string, opts: { repo: string; message: string }) => {
    const repo = resolve(opts.repo);
    const lock = await readKernelLock(repo);
    if (lock) {
      console.log(JSON.stringify(await apiPost(lock, `/tasks/${taskId}/instructions`, { text: opts.message })));
      return;
    }
    const runtime = await KernelRuntime.open(repo);
    try {
      const handle = await runtime.attachTask(taskId);
      await handle.inject(opts.message);
      console.log({ ok: true });
    } finally {
      runtime.close();
    }
  });

program
  .command("approve")
  .description("Approve a pending gate intervention")
  .argument("<taskId>")
  .option("--repo <path>", "repo path", process.cwd())
  .option("--request <requestId>", "intervention request id (default: pending)")
  .action(async (taskId: string, opts: { repo: string; request?: string }) => {
    await resolveDecision(taskId, opts.repo, opts.request, { action: "approve" });
  });

program
  .command("reject")
  .description("Reject a pending gate intervention with comments, fixes loop continues")
  .argument("<taskId>")
  .requiredOption("-m, --message <text>", "rejection reason / comments")
  .option("--repo <path>", "repo path", process.cwd())
  .option("--request <requestId>", "intervention request id")
  .action(async (taskId: string, opts: { repo: string; message: string; request?: string }) => {
    const comments: ReviewComment[] = [
      {
        id: "reject-1",
        severity: "major",
        comment: opts.message,
        status: "open",
      },
    ];
    await resolveDecision(taskId, opts.repo, opts.request, { action: "reject", comments });
  });

async function resolveDecision(
  taskId: string,
  repoOpt: string,
  requestId: string | undefined,
  decision: InterventionDecision,
): Promise<void> {
  const repo = resolve(repoOpt);
  const lock = await readKernelLock(repo);

  let reqId = requestId;
  if (!reqId) {
    if (lock) {
      const snap = (await apiGet(lock, `/tasks/${taskId}`)) as {
        pendingIntervention?: { requestId: string };
      };
      reqId = snap.pendingIntervention?.requestId;
    } else {
      const runtime = await KernelRuntime.open(repo);
      try {
        const snap = await runtime.getSnapshot(taskId);
        reqId = snap.pendingIntervention?.requestId;
      } finally {
        runtime.close();
      }
    }
  }
  if (!reqId) {
    console.error("No pending intervention found for task.");
    process.exit(1);
  }

  if (lock) {
    console.log(
      JSON.stringify(await apiPost(lock, `/tasks/${taskId}/interventions/${reqId}`, decision)),
    );
    return;
  }

  const runtime = await KernelRuntime.open(repo);
  try {
    const handle = await runtime.attachTask(taskId);
    // No daemon: apply decision and await resume so the short-lived CLI can finish the gate.
    const result = await handle.applyIntervention(reqId, decision, {
      resume: true,
      wait: true,
    });
    console.log({ requestId: reqId, ...result });
  } finally {
    runtime.close();
  }
}

interface LocalRunOptions {
  requirement: string;
  repoPath: string;
  pipeline?: string;
  autoApproveGates: boolean;
  inplace?: boolean;
  sandbox?: boolean;
  quiet?: boolean;
}

interface KernelEndpoint {
  host: string;
  port: number;
  token?: string;
}

interface RemoteWatchOptions {
  taskId: string;
  after: number;
  quiet?: boolean;
  lock: KernelEndpoint;
}

interface InteractiveRemoteWatchOptions extends RemoteWatchOptions {
  repoPath: string;
}

interface TaskSnapshot {
  task: {
    id: string;
    requirement: string;
    repo_path: string;
    branch: string;
    pipeline_name: string;
    status: "created" | "running" | "suspended" | "completed" | "failed" | "aborted";
    current_node: string | null;
    error: string | null;
    created_at: string;
  };
  pendingIntervention?: InterventionRequest | null;
}

async function runLocalPlain(options: LocalRunOptions): Promise<TaskRunResult> {
  printRunHeader(options.repoPath, options.pipeline, options.requirement);
  const renderer = new PlainRenderer();
  const controller = new AbortController();
  const abort = () => {
    if (controller.signal.aborted) return;
    renderer.end();
    console.log("\nInterrupt — aborting…");
    controller.abort();
  };
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    return await createAndRunTask({
      requirement: options.requirement,
      repoPath: options.repoPath,
      pipeline: options.pipeline,
      autoApproveGates: options.autoApproveGates,
      inplace: options.inplace,
      sandbox: options.sandbox,
      signal: controller.signal,
      onIntervention: options.autoApproveGates
        ? undefined
        : async (request) => {
            renderer.end();
            return promptPlainIntervention(request, {
              signal: controller.signal,
              onInterrupt: abort,
            });
          },
      onEvent: (event) => {
        if (options.quiet && event.type === "engine.chunk") return;
        renderer.print(event);
      },
    });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    renderer.end();
  }
}

async function runLocalWithTui(options: LocalRunOptions): Promise<TaskRunResult> {
  const controller = new AbortController();
  let pending:
    | {
        requestId: string;
        resolve: (decision: InterventionDecision) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let aborting = false;
  let tui: TuiSession;

  const abort = () => {
    if (aborting) return;
    aborting = true;
    tui.notice("warn", "Interrupt received — aborting the task…");
    tui.store.flush();
    pending?.reject(new Error("aborted"));
    pending = undefined;
    controller.abort();
  };

  tui = new TuiSession({
    meta: {
      mode: "run",
      pipeline: options.pipeline ?? "(config default)",
      repoPath: options.repoPath,
      requirement: options.requirement,
    },
    quiet: options.quiet,
    onDecision: (request, decision) => {
      if (!pending) throw new Error("No local intervention is waiting");
      if (pending.requestId !== request.requestId) {
        throw new Error(
          `Intervention mismatch: waiting=${pending.requestId}, got=${request.requestId}`,
        );
      }
      const current = pending;
      pending = undefined;
      current.resolve(decision);
    },
    onCancel: abort,
  });
  tui.start();

  const onIntervention = (request: InterventionRequest): Promise<InterventionDecision> =>
    new Promise((resolveDecision, rejectDecision) => {
      if (pending) {
        rejectDecision(new Error("Another intervention is already waiting"));
        return;
      }
      pending = {
        requestId: request.requestId,
        resolve: resolveDecision,
        reject: rejectDecision,
      };
      tui.pending(request);
    });

  const onSignal = () => abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const result = await createAndRunTask({
      requirement: options.requirement,
      repoPath: options.repoPath,
      pipeline: options.pipeline,
      autoApproveGates: options.autoApproveGates,
      inplace: options.inplace,
      sandbox: options.sandbox,
      signal: controller.signal,
      onIntervention: options.autoApproveGates ? undefined : onIntervention,
      onEvent: (event) => tui.event(event),
    });
    tui.finish(result.status, result.error);
    await tui.stop();
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tui.finish(aborting ? "aborted" : "failed", message);
    await tui.stop();
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function apiGet(
  lock: { host: string; port: number; token?: string },
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (lock.token) headers.authorization = `Bearer ${lock.token}`;
  const res = await fetch(`http://${lock.host}:${lock.port}${path}`, {
    headers,
    signal: requestSignal(signal),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function apiPost(
  lock: { host: string; port: number; token?: string },
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (lock.token) headers.authorization = `Bearer ${lock.token}`;
  const res = await fetch(`http://${lock.host}:${lock.port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function watchRemoteTask(
  options: InteractiveRemoteWatchOptions,
): Promise<TaskUiStatus> {
  const requests = new AbortController();
  const snapshot = (await apiGet(
    options.lock,
    `/tasks/${encodeURIComponent(options.taskId)}`,
    requests.signal,
  )) as TaskSnapshot;
  const status = toUiStatus(snapshot.task.status);
  const { default: WebSocket } = await import("ws");
  let socket: InstanceType<typeof WebSocket> | undefined;
  let detached = false;
  let terminal = false;
  let tui: TuiSession;

  function detach(): void {
    if (detached) return;
    detached = true;
    tui.notice("info", "Detached; the task continues in the daemon.");
    tui.store.flush();
    requests.abort();
    if (!socket) return;
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.terminate();
    }
  }

  tui = new TuiSession({
    meta: {
      mode: "watch",
      taskId: snapshot.task.id,
      pipeline: snapshot.task.pipeline_name,
      branch: snapshot.task.branch,
      repoPath: snapshot.task.repo_path || options.repoPath,
      requirement: snapshot.task.requirement,
      endpoint: `${options.lock.host}:${options.lock.port}`,
    },
    quiet: options.quiet,
    onDecision: async (request, decision) => {
      await apiPost(
        options.lock,
        `/tasks/${encodeURIComponent(options.taskId)}/interventions/${encodeURIComponent(request.requestId)}`,
        decision,
        requests.signal,
      );
    },
    onInject: async (text) => {
      await apiPost(
        options.lock,
        `/tasks/${encodeURIComponent(options.taskId)}/instructions`,
        { text },
        requests.signal,
      );
    },
    onCancel: () => detach(),
  });
  tui.hydrate(status, {
    startedAt: parseTimestamp(snapshot.task.created_at),
    currentNode: snapshot.task.current_node ?? undefined,
    error: snapshot.task.error ?? undefined,
  });
  tui.start();
  if (snapshot.pendingIntervention) tui.pending(snapshot.pendingIntervention);

  if (isTerminalStatus(status)) {
    try {
      const history = (await apiGet(
        options.lock,
        `/tasks/${encodeURIComponent(options.taskId)}/events?after=${options.after}`,
        requests.signal,
      )) as { events?: KernelEvent[] };
      for (const event of history.events ?? []) tui.event(event);
      tui.finish(status, snapshot.task.error ?? undefined);
    } finally {
      requests.abort();
      await tui.stop();
    }
    return status;
  }

  const token = options.lock.token
    ? `&token=${encodeURIComponent(options.lock.token)}`
    : "";
  const url =
    `ws://${options.lock.host}:${options.lock.port}` +
    `/tasks/${encodeURIComponent(options.taskId)}/stream` +
    `?verbose=${options.quiet ? "false" : "true"}&after=${options.after}${token}`;

  try {
    await new Promise<void>((resolveDone, rejectDone) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolveDone();
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        rejectDone(error);
      };

      socket = new WebSocket(url);
      socket.on("open", () => {
        if (detached) socket?.terminate();
      });
      socket.on("message", (data) => {
        try {
          const event = JSON.parse(String(data)) as KernelEvent;
          tui.event(event);
          if (isTerminalEvent(event)) {
            terminal = true;
            socket?.close(1000, "task finished");
          }
        } catch (error) {
          tui.notice(
            "warn",
            `Ignored malformed stream event: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
      socket.on("close", () => resolveOnce());
      socket.on("error", (error) => {
        if (detached) {
          resolveOnce();
          return;
        }
        rejectOnce(error);
      });
    });
    if (!detached && !terminal) throw new Error("Event stream closed before the task finished");
  } catch (error) {
    tui.notice(
      "error",
      `Stream error: ${error instanceof Error ? error.message : String(error)}`,
    );
    tui.store.flush();
    throw error;
  } finally {
    requests.abort();
    await tui.stop();
  }
  return tui.store.getState().status;
}

async function watchRemotePlain(options: RemoteWatchOptions): Promise<TaskUiStatus> {
  const renderer = new PlainRenderer();
  const snapshot = (await apiGet(
    options.lock,
    `/tasks/${encodeURIComponent(options.taskId)}`,
  )) as TaskSnapshot;
  const snapshotStatus = toUiStatus(snapshot.task.status);
  if (isTerminalStatus(snapshotStatus)) {
    try {
      const history = (await apiGet(
        options.lock,
        `/tasks/${encodeURIComponent(options.taskId)}/events?after=${options.after}`,
      )) as { events?: KernelEvent[] };
      for (const event of history.events ?? []) {
        if (options.quiet && event.type === "engine.chunk") continue;
        renderer.print(event);
      }
    } finally {
      renderer.end();
    }
    return snapshotStatus;
  }

  const { default: WebSocket } = await import("ws");
  const token = options.lock.token
    ? `&token=${encodeURIComponent(options.lock.token)}`
    : "";
  const verbose = options.quiet ? "false" : "true";
  const url =
    `ws://${options.lock.host}:${options.lock.port}` +
    `/tasks/${encodeURIComponent(options.taskId)}/stream` +
    `?verbose=${verbose}&after=${options.after}${token}`;

  let socket: InstanceType<typeof WebSocket> | undefined;
  let interrupted = false;
  let terminalStatus: TaskUiStatus | undefined;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    renderer.end();
    if (
      socket?.readyState === WebSocket.OPEN ||
      socket?.readyState === WebSocket.CONNECTING
    ) {
      socket.terminate();
    }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await new Promise<void>((resolveDone, rejectDone) => {
      socket = new WebSocket(url);
      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolveDone();
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        rejectDone(error);
      };
      const stop = () => {
        if (socket?.readyState === WebSocket.OPEN) socket.close(1000, "task finished");
      };
      socket.on("message", (data) => {
        try {
          const event = JSON.parse(String(data)) as KernelEvent;
          renderer.print(event);
          terminalStatus = statusFromTerminalEvent(event) ?? terminalStatus;
          if (terminalStatus) stop();
        } catch {
          renderer.end();
          console.log(String(data));
        }
      });
      socket.on("close", () => {
        if (interrupted || terminalStatus) resolveOnce();
        else rejectOnce(new Error("Event stream closed before the task finished"));
      });
      socket.on("error", (error) => {
        if (interrupted) resolveOnce();
        else rejectOnce(error);
      });
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    renderer.end();
  }
  return terminalStatus ?? snapshotStatus;
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function findSkillsDir(): string | undefined {
  // Installed: <pkg>/dist/cli → <pkg>/skills (../../skills).
  // Monorepo dev: <root>/packages/cli/dist → <root>/skills (../../../skills).
  for (const candidate of [
    join(import.meta.dirname, "..", "..", "skills"),
    join(import.meta.dirname, "..", "..", "..", "skills"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function parseSequence(value: string): number {
  const sequence = Number(value);
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(`Invalid --after sequence: ${value}`);
  }
  return sequence;
}

function parseTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toUiStatus(status: TaskSnapshot["task"]["status"]): TaskUiStatus {
  return status === "created" ? "idle" : status;
}

function isTerminalStatus(status: TaskUiStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

function statusFromTerminalEvent(event: KernelEvent): TaskUiStatus | undefined {
  if (event.type === "task.completed") return "completed";
  if (event.type === "task.failed") return "failed";
  if (event.type === "task.aborted") return "aborted";
  return undefined;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
