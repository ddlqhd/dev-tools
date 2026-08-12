import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelStore, EventLog, ArtifactStore, type TaskStatus } from "../src/store/index.js";

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
