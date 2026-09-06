import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InterventionRequest, KernelEvent } from "@devtools/shared";
import {
  freshRepo,
  cleanupRepo,
  makeStubState,
  readStubLog,
  waitForEvent,
  STUB_PATH,
  reviewComments,
} from "./helpers.js";

process.env.CODELOOP_CURSOR_BIN = STUB_PATH;

const { createAndRunTask, KernelRuntime } = await import("@devtools/kernel");

const STUB_LOG = join(process.cwd(), "dist-test", "stub-log.jsonl");
const DEFAULT_CONFIG = "version: 1\npipeline: default-codeloop\n";

function runOpts(repo: string, state: string, extra: Record<string, unknown> = {}) {
  process.env.CODELOOP_STUB_STATE = state;
  return {
    requirement: "implement the stub feature",
    repoPath: repo,
    inplace: true,
    autoApproveGates: true,
    sandbox: false,
    ...extra,
  };
}

test("m1-minimal: full pipeline completes inplace with a single commit", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({});
  try {
    const result = await createAndRunTask(runOpts(repo, state, { pipeline: "m1-minimal" }));
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.branch, "main", "inplace stays on the current branch");
    assert.equal(result.worktreePath, repo);

    const count = (await import("node:child_process"))
      .execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" })
      .trim();
    assert.equal(count, "2", "init + one squashed commit");

    const headMsg = (await import("node:child_process"))
      .execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: repo, encoding: "utf8" })
      .trim();
    assert.equal(headMsg, "feat: stub change");
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("default-codeloop: full loop with gate auto-approve and artifacts", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({});
  try {
    const seen: KernelEvent[] = [];
    const result = await createAndRunTask({
      ...runOpts(repo, state),
      onEvent: (e) => seen.push(e),
    });
    assert.equal(result.status, "completed", result.error);

    const types = seen.map((e) => e.type);
    assert.ok(types.includes("task.completed"));
    assert.ok(types.includes("loop.iteration"), "planLoop+reviewLoop ran");
    assert.ok(types.includes("review.completed"));

    // review first fails, then passes after the fix turn
    const reviews = seen.filter((e) => e.type === "review.completed");
    assert.ok(reviews.length >= 2);
    assert.equal((reviews[0]!.payload as { passed: boolean }).passed, false);
    assert.equal((reviews[reviews.length - 1]!.payload as { passed: boolean }).passed, true);

    // artifacts on disk
    const plan = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(repo, ".codeloop", "tasks", result.taskId, "artifacts", "planDoc.md"), "utf8").catch(() => null),
    );
    assert.ok(plan?.includes("Goal"));
    const verifyReport = await import("node:fs/promises").then((fs) =>
      fs
        .readFile(join(repo, ".codeloop", "tasks", result.taskId, "artifacts", "verifyReport.json"), "utf8")
        .catch(() => null),
    );
    assert.ok(verifyReport?.includes('"passed": true'));

    // exactly one commit on top of the base
    const commits = (await import("node:child_process"))
      .execFileSync("git", ["rev-list", "--count", "HEAD~1..HEAD"], { cwd: repo, encoding: "utf8" })
      .trim();
    assert.equal(commits, "1");
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("gate reject loops back into planLoop and completes after approval", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({});
  await rm(STUB_LOG, { force: true });
  process.env.CODELOOP_STUB_LOG = STUB_LOG;
  try {
    let gateCalls = 0;
    const result = await createAndRunTask({
      ...runOpts(repo, state, { autoApproveGates: false }),
      onIntervention: async (_req) => {
        gateCalls += 1;
        if (gateCalls === 1) {
          return { action: "reject", comments: reviewComments(["plan is wrong"]) };
        }
        return { action: "approve" };
      },
    });
    assert.equal(result.status, "completed", result.error);
    assert.equal(gateCalls, 2, "gate should be hit twice (reject → re-loop → approve)");

    // reject comments are injected into the next plan turn as instructions
    const calls = await readStubLog(STUB_LOG);
    const planCalls = calls.filter((c) => /planning/.test(c.prompt));
    assert.ok(planCalls.length >= 2, `expected ≥2 plan turns, got ${planCalls.length}`);
    const postRejectPlan = planCalls.at(-1)!.prompt;
    assert.match(postRejectPlan, /Gate rejected with comments/);
    assert.match(postRejectPlan, /plan is wrong/);
    // the previous plan is fed back so the model can revise, not restart
    assert.match(postRejectPlan, /## Previous plan/);
    assert.match(postRejectPlan, /Implement the stub feature/);
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
    delete process.env.CODELOOP_STUB_LOG;
  }
});

test("verify failure with onFail re-enters reviewLoop and recovers", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({ verifyFailOnce: true });
  try {
    const seen: KernelEvent[] = [];
    const result = await createAndRunTask({
      ...runOpts(repo, state),
      onEvent: (e) => seen.push(e),
    });
    assert.equal(result.status, "completed", result.error);

    const verifyLogs = seen.filter(
      (e) => e.type === "log" && /verify/.test(String((e.payload as { message: string }).message)),
    );
    assert.ok(verifyLogs.some((l) => /failed/.test((l.payload as { message: string }).message)), "first verify failed");
    assert.ok(verifyLogs.some((l) => /passed/.test((l.payload as { message: string }).message)), "second verify passed");
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("maxIterations: never-passing review suspends with a limit intervention", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({ reviewAlwaysFail: true });
  try {
    const seen: KernelEvent[] = [];
    const result = await createAndRunTask({
      ...runOpts(repo, state, { pipeline: "quick-fix" }),
      onEvent: (e) => seen.push(e),
    });
    assert.equal(result.status, "suspended");
    assert.match(result.error ?? "", /Loop reviewLoop reached maxIterations/);

    const limit = seen.find(
      (e) => e.type === "intervention.required" && (e.payload as InterventionRequest).kind === "limit",
    );
    assert.ok(limit, "expected a limit intervention.required event");
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("maxIterations: approving a limit intervention continues the pipeline", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({ reviewAlwaysFail: true });
  try {
    const runtime = await KernelRuntime.open(repo);
    try {
      process.env.CODELOOP_STUB_STATE = state;
      const handle = await runtime.createTask({
        requirement: "implement the stub feature",
        repoPath: repo,
        inplace: true,
        pipeline: "quick-fix",
        parkInterventions: true,
      });
      const events: KernelEvent[] = [];
      handle.onEvent((e) => events.push(e));
      const runPromise = handle.start();

      const reqEvent = await waitForEvent(
        events,
        (e) =>
          e.type === "intervention.required" &&
          (e.payload as InterventionRequest).kind === "limit",
      );
      const req = reqEvent.payload as InterventionRequest;
      const applied = await handle.applyIntervention(req.requestId, { action: "approve" });
      assert.equal(applied.ok, true);

      const finished = await runPromise;
      assert.equal(finished.status, "completed", finished.error);
      assert.equal(runtime.store.getTask(handle.taskId)?.error, null);

      const resolved = events.find((e) => e.type === "intervention.resolved");
      assert.ok(resolved, "limit approve must emit intervention.resolved");
      assert.equal((resolved!.payload as { requestId?: string }).requestId, req.requestId);
    } finally {
      runtime.close();
    }
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("budget: exceeding maxEngineCalls fails the task", { timeout: 60_000 }, async () => {
  const repo = await freshRepo({
    configYaml: "version: 1\npipeline: m1-minimal\nbudget:\n  maxEngineCalls: 1\n",
  });
  const state = await makeStubState({});
  try {
    const seen: KernelEvent[] = [];
    const result = await createAndRunTask({
      ...runOpts(repo, state),
      onEvent: (e) => seen.push(e),
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /Budget exceeded/);
    assert.ok(seen.some((e) => e.type === "budget.exceeded"));
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("pause → resume completes with an instruction", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({});
  try {
    const runtime = await KernelRuntime.open(repo);
    try {
      process.env.CODELOOP_STUB_STATE = state;
      const handle = await runtime.createTask({
        requirement: "implement the stub feature",
        repoPath: repo,
        inplace: true,
        pipeline: "default-codeloop",
        parkInterventions: true,
      });
      const events: KernelEvent[] = [];
      handle.onEvent((e) => events.push(e));
      const runPromise = handle.start();

      await waitForEvent(events, (e) => e.type === "intervention.required");
      assert.equal(handle.getPendingIntervention()?.kind, "gate");

      await handle.pause();
      const paused = await runPromise;
      assert.equal(paused.status, "suspended");
      const dbFile = await import("node:fs/promises").then((fs) => fs.stat(join(repo, ".codeloop", "kernel.db")));
      assert.ok(dbFile.size > 0, "kernel.db exists");

      // ignore the pre-pause events; look for the post-resume gate request
      events.splice(0);
      await handle.kickoffResume();
      await waitForEvent(events, (e) => e.type === "intervention.required");
      const req = handle.getPendingIntervention()!;
      const applied = await handle.applyIntervention(req.requestId, { action: "approve" });
      assert.equal(applied.ok, true);
      const finished = await handle.wait();
      assert.equal(finished.status, "completed", finished.error);
    } finally {
      runtime.close();
    }
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("daemon restart: intervention recovered from the event log and task resumes", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({});
  try {
    const runtime = await KernelRuntime.open(repo);
    let taskId: string;
    let requestId: string;
    try {
      process.env.CODELOOP_STUB_STATE = state;
      const handle = await runtime.createTask({
        requirement: "implement the stub feature",
        repoPath: repo,
        inplace: true,
        pipeline: "default-codeloop",
        parkInterventions: true,
      });
      taskId = handle.taskId;
      const events: KernelEvent[] = [];
      handle.onEvent((e) => events.push(e));
      const runPromise = handle.start();
      const reqEvent = await waitForEvent(events, (e) => e.type === "intervention.required");
      const reqPayload = reqEvent.payload as InterventionRequest;
      await handle.pause();
      await runPromise;
      requestId = reqPayload.requestId;
    } finally {
      runtime.close(); // simulate daemon death
    }

    // Fresh runtime — the pending request must be recoverable from the event log
    const runtime2 = await KernelRuntime.open(repo);
    try {
      const handle2 = await runtime2.attachTask(taskId);
      const recovered = await handle2.events.findUnresolvedIntervention();
      assert.ok(recovered, "pending intervention should survive a restart");
      assert.equal(recovered!.requestId, requestId);

      const applied = await handle2.applyIntervention(requestId, { action: "approve" });
      assert.equal(applied.ok, true);
      const finished = await handle2.wait();
      assert.equal(finished.status, "completed", finished.error);
    } finally {
      runtime2.close();
    }
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("abort stops the task and marks it aborted", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({});
  try {
    const runtime = await KernelRuntime.open(repo);
    try {
      process.env.CODELOOP_STUB_STATE = state;
      const handle = await runtime.createTask({
        requirement: "implement the stub feature",
        repoPath: repo,
        inplace: true,
        pipeline: "default-codeloop",
        parkInterventions: true,
      });
      const events: KernelEvent[] = [];
      handle.onEvent((e) => events.push(e));
      const runPromise = handle.start();
      await waitForEvent(events, (e) => e.type === "intervention.required");
      await handle.abort();
      const result = await runPromise;
      assert.equal(result.status, "aborted");
      const task = runtime.store.getTask(handle.taskId);
      assert.equal(task?.status, "aborted");
    } finally {
      runtime.close();
    }
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("sandbox: write turns opt-in via config", { timeout: 60_000 }, async () => {
  const repo = await freshRepo({ configYaml: DEFAULT_CONFIG });
  const state = await makeStubState({});
  await rm(STUB_LOG, { force: true });
  process.env.CODELOOP_STUB_LOG = STUB_LOG;
  try {
    const result = await createAndRunTask({
      ...runOpts(repo, state),
      sandbox: true,
      pipeline: "m1-minimal",
    });
    assert.equal(result.status, "completed", result.error);
    const calls = await readStubLog(STUB_LOG);
    const writeTurn = calls.find((c) => !/planning/.test(c.prompt));
    const sandboxIdx = writeTurn?.args.indexOf("--sandbox");
    assert.ok(sandboxIdx !== undefined && sandboxIdx >= 0);
    assert.equal(writeTurn!.args[sandboxIdx + 1], "enabled");
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
    delete process.env.CODELOOP_STUB_LOG;
  }
});

test("inplace hygiene: .codeloop never committed, branch unchanged, tree clean", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({});
  try {
    const result = await createAndRunTask(runOpts(repo, state, { pipeline: "m1-minimal" }));
    assert.equal(result.status, "completed", result.error);

    const branch = (await import("node:child_process"))
      .execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" })
      .trim();
    assert.equal(branch, "main");

    const files = (await import("node:child_process"))
      .execFileSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: repo, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    assert.ok(files.includes("src/feature.txt"), files.join(","));
    assert.ok(!files.some((f) => f.startsWith(".codeloop")), "no .codeloop files in commit");

    const status = (await import("node:child_process"))
      .execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })
      .trim();
    assert.equal(status, "", "worktree left dirty");
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("review-only on a dirty inplace checkout snapshots into an isolated worktree", async () => {
  const repo = await freshRepo();
  try {
    await writeFile(join(repo, ".gitignore"), "node_modules/\n", "utf8");
    await writeFile(join(repo, "WIP.md"), "local change\n", "utf8");
    await mkdir(join(repo, "node_modules"), { recursive: true });
    await writeFile(join(repo, "node_modules", "pkg"), "dep\n", "utf8");
    const runtime = await KernelRuntime.open(repo);
    try {
      const seen: KernelEvent[] = [];
      const handle = await runtime.createTask({
        requirement: "review local changes",
        repoPath: repo,
        pipeline: "review-only",
        inplace: true,
        onEvent: (e) => seen.push(e),
      });
      const row = runtime.store.getTask(handle.taskId);
      assert.ok(row);
      assert.notEqual(row.worktree_path, repo);
      assert.match(row.worktree_path, /worktrees/);
      assert.equal(await readFile(join(row.worktree_path, "WIP.md"), "utf8"), "local change\n");
      const created = seen.find((e) => e.type === "task.created");
      assert.ok(created);
      assert.equal((created.payload as { inplace: boolean }).inplace, false);
      assert.equal((created.payload as { worktreePath: string }).worktreePath, row.worktree_path);
      const tree = (await import("node:child_process")).execFileSync(
        "git",
        ["ls-tree", "-r", "-t", "--name-only", "HEAD"],
        { cwd: row.worktree_path, encoding: "utf8" },
      );
      assert.equal(
        tree.split("\n").includes("node_modules"),
        false,
        `snapshot HEAD must not contain node_modules:\n${tree}`,
      );
      assert.match(
        (await import("node:child_process")).execFileSync(
          "git",
          ["status", "--porcelain"],
          { cwd: repo, encoding: "utf8" },
        ),
        /WIP\.md/,
      );
    } finally {
      runtime.close();
    }
  } finally {
    await cleanupRepo(repo);
  }
});

test("planLoop exhaustion: skips limit intervention and directly asks for gate with loopExhaustion", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({ reviewAlwaysFail: true });
  try {
    const seen: KernelEvent[] = [];
    const interventions: InterventionRequest[] = [];
    const result = await createAndRunTask({
      ...runOpts(repo, state, { pipeline: "plan-only", autoApproveGates: false }),
      onEvent: (e) => seen.push(e),
      onIntervention: async (req) => {
        interventions.push(req);
        return { action: "approve" };
      },
    });

    assert.equal(result.status, "completed", result.error);

    // Verify no limit intervention was requested
    const limitReqs = interventions.filter((r) => r.kind === "limit");
    assert.equal(limitReqs.length, 0, "should not have emitted a limit intervention");

    // Verify exactly one gate intervention was requested, with loopExhaustion
    const gateReqs = interventions.filter((r) => r.kind === "gate");
    assert.equal(gateReqs.length, 1, "expected exactly one gate intervention");
    assert.deepEqual(gateReqs[0]!.loopExhaustion, {
      loopId: "planLoop",
      iteration: 3,
      maxIterations: 3,
    });
    assert.match(gateReqs[0]!.summary, /planLoop reached maxIterations=3; review did not pass/);

    // Verify events
    const reqEvents = seen.filter((e) => e.type === "intervention.required");
    assert.equal(reqEvents.length, 1);
    const payload = reqEvents[0]!.payload as InterventionRequest;
    assert.equal(payload.kind, "gate");
    assert.deepEqual(payload.loopExhaustion, {
      loopId: "planLoop",
      iteration: 3,
      maxIterations: 3,
    });
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("planLoop exhaustion: autoApproveGates auto-approves gate and completes", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({ reviewAlwaysFail: true });
  try {
    const seen: KernelEvent[] = [];
    const result = await createAndRunTask({
      ...runOpts(repo, state, { pipeline: "plan-only", autoApproveGates: true }),
      onEvent: (e) => seen.push(e),
    });

    assert.equal(result.status, "completed", result.error);

    const reqEvents = seen.filter((e) => e.type === "intervention.required");
    assert.equal(reqEvents.length, 0, "autoApproveGates should not require intervention");

    const warnLog = seen.find(
      (e) =>
        e.type === "log" &&
        (e.payload as { level?: string; message?: string }).level === "warn" &&
        (e.payload as { message?: string }).message?.includes("Gate auto-approved despite loop exhaustion"),
    );
    assert.ok(warnLog, "should emit a warning log for gate auto-approval under loop exhaustion");
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("planLoop exhaustion: gate reject loops back into planLoop and completes", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({ reviewAlwaysFail: true });
  try {
    let gateCalls = 0;
    const result = await createAndRunTask({
      ...runOpts(repo, state, { pipeline: "plan-only", autoApproveGates: false }),
      onIntervention: async (req) => {
        gateCalls += 1;
        assert.equal(req.kind, "gate");
        assert.ok(req.loopExhaustion);
        if (gateCalls === 1) {
          return { action: "reject", comments: reviewComments(["plan needs more detail"]) };
        }
        return { action: "approve" };
      },
    });
    assert.equal(result.status, "completed", result.error);
    assert.equal(gateCalls, 2, "gate should be hit twice (exhaust → reject → re-exhaust → approve)");
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

test("planLoop exhaustion: pause and resume keeps loopExhaustion on the gate", { timeout: 60_000 }, async () => {
  const repo = await freshRepo();
  const state = await makeStubState({ reviewAlwaysFail: true });
  try {
    const runtime = await KernelRuntime.open(repo);
    try {
      process.env.CODELOOP_STUB_STATE = state;
      const handle = await runtime.createTask({
        requirement: "implement the stub feature",
        repoPath: repo,
        inplace: true,
        pipeline: "plan-only",
        parkInterventions: true,
      });
      const events: KernelEvent[] = [];
      handle.onEvent((e) => events.push(e));
      const runPromise = handle.start();

      await waitForEvent(events, (e) => e.type === "intervention.required");
      const first = handle.getPendingIntervention();
      assert.equal(first?.kind, "gate");
      assert.deepEqual(first?.loopExhaustion, {
        loopId: "planLoop",
        iteration: 3,
        maxIterations: 3,
      });

      const cp = runtime.store.getCheckpoint(handle.taskId);
      const cursor = JSON.parse(cp?.flow_cursor || "{}") as { loopExhaustion?: unknown };
      assert.deepEqual(cursor.loopExhaustion, first?.loopExhaustion);

      await handle.pause();
      const paused = await runPromise;
      assert.equal(paused.status, "suspended");

      events.splice(0);
      await handle.kickoffResume();
      await waitForEvent(events, (e) => e.type === "intervention.required");
      const resumed = handle.getPendingIntervention();
      assert.equal(resumed?.kind, "gate");
      assert.deepEqual(resumed?.loopExhaustion, {
        loopId: "planLoop",
        iteration: 3,
        maxIterations: 3,
      });

      const applied = await handle.applyIntervention(resumed!.requestId, { action: "approve" });
      assert.equal(applied.ok, true);
      const finished = await handle.wait();
      assert.equal(finished.status, "completed", finished.error);
    } finally {
      runtime.close();
    }
  } finally {
    await cleanupRepo(repo);
    await rm(state, { force: true });
  }
});

