import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelStore, EventLog, ArtifactStore, CoalescingJsonlWriter, type TaskStatus } from "../src/store/index.js";

let dir: string;
let store: KernelStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codeloop-store-"));
  store = new KernelStore(dir);
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function taskRow(id: string, status: TaskStatus = "created") {
  const now = new Date().toISOString();
  return {
    id,
    requirement: `req ${id}`,
    repo_path: "/repo",
    worktree_path: "/repo/.codeloop/worktrees/" + id,
    branch: `codeloop/${id}`,
    base_commit: "abc123",
    pipeline_name: "default-codeloop",
    pipeline_hash: "h",
    status,
    current_node: null,
    loop_state: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
}

test("KernelStore: insert/get/update/list", () => {
  store.insertTask(taskRow("t1"));
  store.insertTask(taskRow("t2"));

  const got = store.getTask("t1");
  assert.equal(got?.requirement, "req t1");
  assert.equal(got?.status, "created");

  store.updateTask("t1", { status: "running", current_node: "plan" });
  const updated = store.getTask("t1");
  assert.equal(updated?.status, "running");
  assert.equal(updated?.current_node, "plan");
  assert.notEqual(updated?.updated_at, undefined);

  // newest first
  const all = store.listTasks();
  assert.deepEqual(all.map((t) => t.id), ["t2", "t1"]);

  assert.equal(store.getTask("missing"), undefined);
  assert.throws(() => store.updateTask("missing", { status: "failed" }), /not found/);
});

test("KernelStore: checkpoint upsert", () => {
  const cp = {
    task_id: "t1",
    node_id: "code",
    loop_stack: JSON.stringify([{ loopId: "reviewLoop", iteration: 1 }]),
    head_commit: "deadbeef",
    engine_session_id: null,
    instructions: JSON.stringify(["fix it"]),
    flow_cursor: JSON.stringify({ flowIndex: 2 }),
    node_outcomes: JSON.stringify({ plan: { passed: true } }),
    pending_intervention: null,
    updated_at: new Date().toISOString(),
  };
  store.saveCheckpoint(cp);
  const got = store.getCheckpoint("t1");
  assert.equal(got?.node_id, "code");
  assert.equal(JSON.parse(got!.loop_stack)[0].loopId, "reviewLoop");

  // upsert replaces
  store.saveCheckpoint({ ...cp, node_id: "commit", updated_at: new Date().toISOString() });
  assert.equal(store.getCheckpoint("t1")?.node_id, "commit");
});

test("KernelStore: reuse of one database instance stays consistent", () => {
  // open a second handle to the same db
  const store2 = new KernelStore(dir);
  try {
    store.insertTask(taskRow("shared"));
    assert.equal(store2.getTask("shared")?.status, "created");
  } finally {
    store2.close();
  }
});

test("EventLog: append, seq continuity, readAfter", async () => {
  const dirs = await store.ensureTaskDirs("t1");
  const log = await EventLog.open("t1", dirs.taskDir);
  await log.emit("task.started", {});
  await log.emit("node.started", { nodeId: "plan" });

  // Reopening continues seq from the last line
  const log2 = await EventLog.open("t1", dirs.taskDir);
  await log2.emit("task.completed", {});
  const all = await log2.readAfter(0);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(all.map((e) => e.type), ["task.started", "node.started", "task.completed"]);
  assert.equal(all[0]!.taskId, "t1");

  const after = await log2.readAfter(1);
  assert.deepEqual(after.map((e) => e.type), ["node.started", "task.completed"]);
});

test("CoalescingJsonlWriter: persist receiver merges tokens, not the emitter", async () => {
  const dirs = await store.ensureTaskDirs("t-sink");
  const path = join(dirs.taskDir, "events.jsonl");
  const sink = new CoalescingJsonlWriter(path);
  const ev = (seq: number, kind: string, extra: Record<string, unknown>) => ({
    seq,
    taskId: "t-sink",
    ts: "2026-09-05T00:00:00.000Z",
    type: "engine.chunk" as const,
    payload: { nodeId: "plan", chunk: { kind, ...extra } },
  });

  await sink.accept(ev(1, "text", { text: "先" }));
  await sink.accept(ev(2, "text", { text: "定位" }));
  await sink.accept(ev(3, "thinking", { text: "嗯" }));
  await sink.accept(ev(4, "thinking", { text: "。" }));
  await sink.accept(ev(5, "toolUse", { tool: "Read", summary: "a.ts" }));
  await sink.flush();

  const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[0]!.payload.chunk.text, "先定位");
  assert.equal(lines[1]!.payload.chunk.text, "嗯。");
  assert.equal(lines[2]!.payload.chunk.kind, "toolUse");
});

test("EventLog: pushes every token live; persist receiver coalesces jsonl", async () => {
  const dirs = await store.ensureTaskDirs("t-coalesce");
  const log = await EventLog.open("t-coalesce", dirs.taskDir);
  const live: string[] = [];
  log.on((e) => {
    if (e.type === "engine.chunk") {
      const chunk = (e.payload as { chunk?: { kind?: string; text?: string } }).chunk;
      live.push(`${chunk?.kind}:${chunk?.text ?? ""}`);
    }
  });

  await log.emit("engine.chunk", { nodeId: "plan", chunk: { kind: "thinking", text: "先" } });
  await log.emit("engine.chunk", { nodeId: "plan", chunk: { kind: "thinking", text: "想" } });
  await log.emit("engine.chunk", { nodeId: "plan", chunk: { kind: "text", text: "写" } });
  await log.emit("engine.chunk", { nodeId: "plan", chunk: { kind: "text", text: "下" } });
  await log.emit("engine.chunk", { nodeId: "plan", chunk: { kind: "toolUse", tool: "Read", summary: "a.ts" } });
  await log.emit("node.completed", { nodeId: "plan" });

  assert.deepEqual(live, ["thinking:先", "thinking:想", "text:写", "text:下", "toolUse:"]);

  const disk = await log.readAfter(0);
  assert.deepEqual(
    disk.map((e) => e.type),
    ["engine.chunk", "engine.chunk", "engine.chunk", "node.completed"],
  );
  const chunks = disk.filter((e) => e.type === "engine.chunk").map((e) => {
    const chunk = (e.payload as { chunk: { kind: string; text?: string; tool?: string } }).chunk;
    return { seq: e.seq, kind: chunk.kind, text: chunk.text, tool: chunk.tool };
  });
  assert.deepEqual(chunks, [
    { seq: 2, kind: "thinking", text: "先想", tool: undefined },
    { seq: 4, kind: "text", text: "写下", tool: undefined },
    { seq: 5, kind: "toolUse", text: undefined, tool: "Read" },
  ]);
});

test("EventLog: task.completed flushes the pending text buffer to disk", async () => {
  const dirs = await store.ensureTaskDirs("t-end");
  const log = await EventLog.open("t-end", dirs.taskDir);
  await log.emit("engine.chunk", { nodeId: "plan", chunk: { kind: "text", text: "完整段落" } });
  await log.emit("task.completed", {});
  const raw = await readFile(join(dirs.taskDir, "events.jsonl"), "utf8");
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as { type: string; payload: { chunk?: { text?: string } } });
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.payload.chunk?.text, "完整段落");
  assert.equal(lines[1]!.type, "task.completed");
});

test("EventLog: explicit flush persists pending without a trailing event", async () => {
  const dirs = await store.ensureTaskDirs("t-flush");
  const log = await EventLog.open("t-flush", dirs.taskDir);
  await log.emit("engine.chunk", { nodeId: "plan", chunk: { kind: "thinking", text: "未完成" } });
  await log.flush();
  const raw = await readFile(join(dirs.taskDir, "events.jsonl"), "utf8");
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as { payload: { chunk: { text: string } } });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.payload.chunk.text, "未完成");
});

test("EventLog: readAfter does not flush pending, later same-kind tokens still merge", async () => {
  const dirs = await store.ensureTaskDirs("t-pending");
  const log = await EventLog.open("t-pending", dirs.taskDir);
  await log.emit("engine.chunk", { nodeId: "plan", chunk: { kind: "text", text: "先" } });
  const mid = await log.readAfter(0);
  assert.equal(mid.length, 1);
  assert.equal((mid[0]!.payload as { chunk: { text: string } }).chunk.text, "先");

  const onDisk = await readFile(join(dirs.taskDir, "events.jsonl"), "utf8").catch(() => "");
  assert.equal(onDisk.trim(), "");

  await log.emit("engine.chunk", { nodeId: "plan", chunk: { kind: "text", text: "定位" } });
  await log.emit("engine.chunk", { nodeId: "plan", chunk: { kind: "toolUse", tool: "Grep", summary: "x" } });
  const disk = await log.readAfter(0);
  assert.equal(disk.length, 2);
  assert.equal((disk[0]!.payload as { chunk: { text: string } }).chunk.text, "先定位");
  assert.equal((disk[1]!.payload as { chunk: { kind: string } }).chunk.kind, "toolUse");
});

test("EventLog: does not merge different nodes or non-text kinds", async () => {
  const dirs = await store.ensureTaskDirs("t-nomerge");
  const log = await EventLog.open("t-nomerge", dirs.taskDir);
  await log.emit("engine.chunk", { nodeId: "plan", chunk: { kind: "text", text: "a" } });
  await log.emit("engine.chunk", { nodeId: "code", chunk: { kind: "text", text: "b" } });
  await log.emit("engine.chunk", { nodeId: "code", chunk: { kind: "toolUse", tool: "Grep", summary: "x" } });
  await log.emit("engine.chunk", { nodeId: "code", chunk: { kind: "toolUse", tool: "Read", summary: "y" } });

  const disk = await log.readAfter(0);
  assert.equal(disk.length, 4);
  assert.deepEqual(
    disk.map((e) => (e.payload as { chunk: { kind: string; text?: string } }).chunk.kind),
    ["text", "text", "toolUse", "toolUse"],
  );
});

test("CoalescingJsonlWriter: flush rejects after a failed append", async () => {
  const dirs = await store.ensureTaskDirs("t-write-fail");
  const path = join(dirs.taskDir, "events.jsonl");
  const sink = new CoalescingJsonlWriter(path, async () => {
    throw new Error("disk full");
  });
  await sink.accept({
    seq: 1,
    taskId: "t-write-fail",
    ts: "2026-09-06T00:00:00.000Z",
    type: "task.started",
    payload: {},
  }).catch(() => undefined);
  await assert.rejects(() => sink.flush(), /disk full/);
});

test("EventLog.readFile: replays jsonl without writing", async () => {
  const dirs = await store.ensureTaskDirs("t-readonly");
  const path = join(dirs.taskDir, "events.jsonl");
  await writeFile(
    path,
    `${JSON.stringify({ seq: 1, taskId: "t-readonly", ts: "2026-09-06T00:00:00.000Z", type: "task.started", payload: {} })}\n`,
    "utf8",
  );
  const before = await readFile(path, "utf8");
  const rows = await EventLog.readFile(dirs.taskDir, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, "task.started");
  assert.equal(await readFile(path, "utf8"), before);
});

test("EventLog: findUnresolvedIntervention", async () => {
  const dirs = await store.ensureTaskDirs("t2");
  const log = await EventLog.open("t2", dirs.taskDir);
  await log.emit("intervention.required", { requestId: "r1", nodeId: "planGate", kind: "gate", summary: "approve?" });
  assert.equal((await log.findUnresolvedIntervention())?.requestId, "r1");

  // resolved clears it
  await log.emit("intervention.resolved", { requestId: "r1", decision: { action: "approve" } });
  assert.equal(await log.findUnresolvedIntervention(), null);

  // multiple open → the latest wins
  await log.emit("intervention.required", { requestId: "r2", nodeId: "a", kind: "gate", summary: "s" });
  await log.emit("intervention.required", { requestId: "r3", nodeId: "b", kind: "gate", summary: "s" });
  assert.equal((await log.findUnresolvedIntervention())?.requestId, "r3");
});

test("ArtifactStore: write/read text and json", async () => {
  const dirs = await store.ensureTaskDirs("t3");
  const artifacts = new ArtifactStore(dirs.artifactsDir);
  const planPath = await artifacts.writeText("planDoc", "# Plan\ncontent");
  assert.match(planPath, /planDoc\.md$/);
  assert.equal(await artifacts.readText("planDoc"), "# Plan\ncontent");
  assert.equal(await artifacts.readText("missing"), null);

  const reviewPath = await artifacts.writeJson("reviewComments", { passed: false, comments: [] });
  assert.match(reviewPath, /reviewComments\.json$/);
  assert.deepEqual(await artifacts.readJson("reviewComments"), { passed: false, comments: [] });
  assert.equal(await artifacts.readJson("missing"), null);
});
