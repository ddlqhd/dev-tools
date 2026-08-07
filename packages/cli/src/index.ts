#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
} from "@devtools/kernel";
import type { InterventionDecision, InterventionRequest, KernelEvent, ReviewComment } from "@devtools/shared";

const program = new Command();

program
  .name("codeloop")
  .description("Automated AI development loop (Cursor agent engine)")
  .version("0.2.0");

program
  .command("doctor")
  .description("Check Cursor agent CLI install/login and local config")
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
  .action(async (taskId: string, opts: { repo: string }) => {
    const repo = resolve(opts.repo);
    const lock = await readKernelLock(repo);
    if (lock) {
      const snap = await apiGet(lock, `/tasks/${taskId}`);
      console.log(JSON.stringify(snap, null, 2));
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
  .option("--quiet", "less event output")
  .action(
    async (
      requirement: string | undefined,
      opts: {
        file?: string;
        repo: string;
        pipeline?: string;
        gate?: boolean;
        quiet?: boolean;
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

      // If daemon is running, create task via API
      const lock = await readKernelLock(repoPath);
      if (lock) {
        const created = (await apiPost(lock, "/tasks", {
          requirement: text,
          repoPath,
          pipeline: opts.pipeline,
          configOverrides: { autoApproveGates: autoApprove },
        })) as { taskId: string; branch: string };
        console.log(`task: ${created.taskId} (via serve ${lock.host}:${lock.port})`);
        console.log(`branch: ${created.branch}`);
        console.log("Use: codeloop watch <taskId>");
        return;
      }

      console.log(`repo: ${repoPath}`);
      console.log(`pipeline: ${opts.pipeline ?? "(config default)"}`);
      console.log(`requirement: ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}`);
      console.log("---");

      const ac = new AbortController();
      const onSig = () => {
        console.log("\nInterrupt — aborting…");
        ac.abort();
      };
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);

      const result = await createAndRunTask({
        requirement: text,
        repoPath,
        pipeline: opts.pipeline,
        autoApproveGates: autoApprove,
        signal: ac.signal,
        onIntervention: autoApprove ? undefined : promptIntervention,
        onEvent: (event) => {
          if (opts.quiet && event.type === "engine.chunk") return;
          printEvent(event);
        },
      });

      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);

      console.log("---");
      console.log(`task: ${result.taskId}`);
      console.log(`status: ${result.status}`);
      console.log(`branch: ${result.branch}`);
      console.log(`worktree: ${result.worktreePath}`);
      if (result.error) console.error(`error: ${result.error}`);
      process.exit(result.status === "completed" ? 0 : 1);
    },
  );

program
  .command("serve")
  .description("Start kernel daemon (control API + event WebSocket)")
  .option("--repo <path>", "repo path", process.cwd())
  .option("--host <host>", "bind host", "127.0.0.1")
  .option("--port <port>", "bind port", "4700")
  .option("--token <token>", "optional bearer token")
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
  .command("watch")
  .argument("<taskId>")
  .description("Attach to a running/suspended task and stream events")
  .option("--repo <path>", "repo path", process.cwd())
  .option("--after <seq>", "replay events after seq", "0")
  .action(async (taskId: string, opts: { repo: string; after: string }) => {
    const repo = resolve(opts.repo);
    const lock = await readKernelLock(repo);
    if (!lock) {
      console.error("No kernel daemon (codeloop serve). Showing historical events from disk…");
      const runtime = await KernelRuntime.open(repo);
      try {
        const handle = await runtime.attachTask(taskId);
        const events = await handle.events.readAfter(Number(opts.after));
        for (const e of events) printEvent(e);
      } finally {
        runtime.close();
      }
      return;
    }
    const { default: WebSocket } = await import("ws");
    const tokenQ = lock.token ? `&token=${encodeURIComponent(lock.token)}` : "";
    const ws = new WebSocket(
      `ws://${lock.host}:${lock.port}/tasks/${taskId}/stream?verbose=true&after=${opts.after}${tokenQ}`,
    );
    ws.on("message", (data) => {
      try {
        printEvent(JSON.parse(String(data)) as KernelEvent);
      } catch {
        console.log(String(data));
      }
    });
    ws.on("close", () => process.exit(0));
    ws.on("error", (err) => {
      console.error(err.message);
      process.exit(1);
    });
  });

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
  .argument("<taskId>")
  .option("--repo <path>", "repo path", process.cwd())
  .option("--request <requestId>", "intervention request id (default: pending)")
  .action(async (taskId: string, opts: { repo: string; request?: string }) => {
    await resolveDecision(taskId, opts.repo, opts.request, { action: "approve" });
  });

program
  .command("reject")
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

async function promptIntervention(req: InterventionRequest): Promise<InterventionDecision> {
  console.log("");
  console.log(`── Intervention required (${req.kind}) @ ${req.nodeId}`);
  console.log(`   ${req.summary}`);
  console.log(`   requestId=${req.requestId}`);
  const rl = createInterface({ input, output });
  try {
    for (;;) {
      const answer = (await rl.question("Approve / Reject / Edit [a/r/e]? ")).trim().toLowerCase();
      if (answer === "a" || answer === "approve" || answer === "") {
        return { action: "approve" };
      }
      if (answer === "r" || answer === "reject") {
        const message = await rl.question("Rejection comments: ");
        return {
          action: "reject",
          comments: [
            {
              id: "cli-reject",
              severity: "major",
              comment: message || "Rejected",
              status: "open",
            },
          ],
        };
      }
      if (answer === "e" || answer === "edit") {
        const note = await rl.question("Edit note (you should have edited worktree files): ");
        return { action: "edit", note: note || "human edited" };
      }
      console.log("Please answer a, r, or e.");
    }
  } finally {
    rl.close();
  }
}

async function apiGet(lock: { host: string; port: number; token?: string }, path: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (lock.token) headers.authorization = `Bearer ${lock.token}`;
  const res = await fetch(`http://${lock.host}:${lock.port}${path}`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function apiPost(
  lock: { host: string; port: number; token?: string },
  path: string,
  body: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (lock.token) headers.authorization = `Bearer ${lock.token}`;
  const res = await fetch(`http://${lock.host}:${lock.port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function printEvent(event: KernelEvent): void {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "task.created":
      console.log(`[task] created pipeline=${(p.pipeline as { name: string }).name}`);
      break;
    case "task.started":
      console.log(`[task] started`);
      break;
    case "task.resumed":
      console.log(`[task] resumed @ ${p.nodeId}`);
      break;
    case "task.suspended":
      console.log(`[task] suspended: ${p.reason ?? ""}`);
      break;
    case "task.completed":
      console.log(`[task] completed`);
      break;
    case "task.failed":
      console.log(`[task] failed: ${p.error}`);
      break;
    case "task.aborted":
      console.log(`[task] aborted`);
      break;
    case "node.started":
      console.log(`[node] ▶ ${p.nodeId} (${p.primitive})`);
      break;
    case "node.completed":
      console.log(`[node] ✓ ${p.nodeId}`);
      break;
    case "node.retrying":
      console.log(`[node] retry ${p.nodeId} attempt=${p.attempt}: ${p.error}`);
      break;
    case "loop.iteration":
      console.log(`[loop] ${p.loopId} ${p.iteration}/${p.maxIterations}`);
      break;
    case "engine.chunk": {
      const chunk = p.chunk as {
        kind: string;
        text?: string;
        tool?: string;
        summary?: string;
        path?: string;
      };
      if (chunk.kind === "toolUse") {
        console.log(`  ⚙ ${chunk.tool} ${chunk.summary ?? ""}`);
      } else if (chunk.kind === "fileChange") {
        console.log(`  ✎ ${chunk.path}`);
      }
      break;
    }
    case "git.commit": {
      const msg = String(p.message ?? "").split("\n")[0] ?? "";
      console.log(`[git] commit ${(p.sha as string).slice(0, 8)} — ${msg}`);
      break;
    }
    case "review.completed":
      console.log(`[review] passed=${p.passed} comments=${(p.comments as unknown[]).length}`);
      break;
    case "intervention.required":
      console.log(`[intervene] ${p.kind}: ${p.summary} (${p.requestId})`);
      break;
    case "intervention.resolved":
      console.log(`[intervene] resolved ${(p.decision as { action: string }).action}`);
      break;
    case "instruction.injected":
      console.log(`[inject] ${p.text}`);
      break;
    case "artifact.created":
      console.log(`[artifact] ${p.key} → ${p.path}`);
      break;
    case "log":
      console.log(`[log] ${p.message}`);
      break;
    case "budget.exceeded":
      console.log(`[budget] exceeded`);
      break;
    default:
      break;
  }
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
