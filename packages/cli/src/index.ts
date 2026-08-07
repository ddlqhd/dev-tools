#!/usr/bin/env node
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
} from "@devtools/kernel";
import type { KernelEvent } from "@devtools/shared";

const program = new Command();

program
  .name("codeloop")
  .description("Automated AI development loop (Cursor agent engine)")
  .version("0.1.0");

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
  .action((taskId: string, opts: { repo: string }) => {
    const task = getTask(resolve(opts.repo), taskId);
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
  .option("--pipeline <name>", "pipeline template (default: from config / m1-minimal)")
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
        autoApproveGates: opts.gate === false ? true : undefined,
        signal: ac.signal,
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

function printEvent(event: KernelEvent): void {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "task.created":
      console.log(`[task] created pipeline=${(p.pipeline as { name: string }).name}`);
      break;
    case "task.started":
      console.log(`[task] started`);
      break;
    case "task.completed":
      console.log(`[task] completed`);
      break;
    case "task.failed":
      console.log(`[task] failed: ${p.error}`);
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
      const chunk = p.chunk as { kind: string; text?: string; tool?: string; summary?: string; path?: string };
      if (chunk.kind === "toolUse") {
        console.log(`  ⚙ ${chunk.tool} ${chunk.summary ?? ""}`);
      } else if (chunk.kind === "fileChange") {
        console.log(`  ✎ ${chunk.path}`);
      } else if (chunk.kind === "text" && chunk.text && chunk.text.length < 200) {
        // skip noisy partial streams; only show short complete-ish snippets
      }
      break;
    }
    case "git.commit":
      console.log(`[git] commit ${(p.sha as string).slice(0, 8)} — ${p.message}`);
      break;
    case "review.completed":
      console.log(`[review] passed=${p.passed} comments=${(p.comments as unknown[]).length}`);
      break;
    case "intervention.required":
      console.log(`[intervene] ${p.kind}: ${p.summary}`);
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
