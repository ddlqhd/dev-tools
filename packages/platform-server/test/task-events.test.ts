import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformStore, type TaskRow } from "../src/db/store.js";
import { listTaskEvents } from "../src/task-events.js";

test("listTaskEvents: reads engine.chunk from kernel events.jsonl", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codeloop-events-"));
  const store = new PlatformStore(tmp);
  const repoPath = join(tmp, "repo");
  try {
    await mkdir(join(repoPath, ".codeloop", "tasks", "k1"), { recursive: true });
    await writeFile(
      join(repoPath, ".codeloop", "tasks", "k1", "events.jsonl"),
      [
        JSON.stringify({
          seq: 1,
          taskId: "k1",
          ts: "2026-09-02T00:00:01.000Z",
          type: "node.started",
          payload: { nodeId: "plan" },
        }),
        JSON.stringify({
          seq: 2,
          taskId: "k1",
          ts: "2026-09-02T00:00:02.000Z",
          type: "engine.chunk",
          payload: { nodeId: "plan", chunk: { kind: "text", text: "hello" } },
        }),
      ].join("\n") + "\n",
    );

    store.insertRepo({
      id: "r1",
      platform: "github",
      full_name: "o/r",
      clone_path: repoPath,
      trigger_label: "ai-dev",
      max_concurrency: 1,
      github_token: null,
      default_branch: "main",
      created_at: "2026-09-02T00:00:00.000Z",
      updated_at: "2026-09-02T00:00:00.000Z",
    });
    const task: TaskRow = {
      id: "p1",
      repo_id: "r1",
      source: "manual",
      issue_number: null,
      title: "t",
      requirement: "req",
      status: "done",
      priority: 0,
      instance_id: null,
      kernel_task_id: "k1",
      branch: null,
      pr_number: null,
      current_node: null,
      loop_state: null,
      pipeline_name: "m1-minimal",
      progress_comment_id: null,
      error: null,
      created_at: "2026-09-02T00:00:00.000Z",
      updated_at: "2026-09-02T00:00:00.000Z",
    };
    store.insertTask(task);

    const events = await listTaskEvents(store, task, store.getRepo("r1")!, 0);
    assert.equal(events.length, 2);
    assert.equal(events[1]!.type, "engine.chunk");
    assert.match(events[1]!.payload, /hello/);
  } finally {
    store.db.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
