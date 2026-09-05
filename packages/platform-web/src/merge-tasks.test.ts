import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTaskSnapshot, upsertTask } from "./merge-tasks.ts";

test("upsertTask: inserts unknown id at the front", () => {
  const next = upsertTask([{ id: "a", updated_at: "2026-09-05T02:00:00.000Z" }], {
    id: "b",
    updated_at: "2026-09-05T02:01:00.000Z",
  });
  assert.deepEqual(
    next.map((t) => t.id),
    ["b", "a"],
  );
});

test("upsertTask: ignores an older update", () => {
  const prev = [{ id: "a", updated_at: "2026-09-05T02:02:00.000Z", status: "running" }];
  const next = upsertTask(prev, { id: "a", updated_at: "2026-09-05T02:01:00.000Z", status: "queued" });
  assert.equal(next, prev);
  assert.equal(next[0]!.status, "running");
});

test("upsertTask: applies a newer update", () => {
  const next = upsertTask([{ id: "a", updated_at: "2026-09-05T02:01:00.000Z", status: "queued" }], {
    id: "a",
    updated_at: "2026-09-05T02:02:00.000Z",
    status: "running",
  });
  assert.equal(next[0]!.status, "running");
});

test("mergeTaskSnapshot: stale HTTP list cannot overwrite a newer websocket row", () => {
  const prev = [
    { id: "a", updated_at: "2026-09-05T02:02:00.000Z", status: "running" },
    { id: "b", updated_at: "2026-09-05T02:00:00.000Z", status: "done" },
  ];
  const incoming = [
    { id: "a", updated_at: "2026-09-05T02:01:00.000Z", status: "queued" },
    { id: "b", updated_at: "2026-09-05T02:00:00.000Z", status: "done" },
  ];
  const merged = mergeTaskSnapshot(prev, incoming, "2026-09-05T02:01:30.000Z");
  assert.equal(merged.find((t) => t.id === "a")!.status, "running");
});

test("mergeTaskSnapshot: keeps a row that arrived via websocket after fetch started", () => {
  const fetchedAt = "2026-09-05T02:01:00.000Z";
  const prev = [{ id: "new", updated_at: "2026-09-05T02:01:10.000Z", status: "queued" }];
  const incoming = [{ id: "old", updated_at: "2026-09-05T02:00:00.000Z", status: "done" }];
  const merged = mergeTaskSnapshot(prev, incoming, fetchedAt);
  assert.deepEqual(
    merged.map((t) => t.id),
    ["new", "old"],
  );
});
