import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsInStageRange, foldNodeEventStream, type KernelEvent } from "../src/index.js";

function ev(seq: number, type: KernelEvent["type"], payload: unknown): KernelEvent {
  return { seq, taskId: "k1", ts: `2026-08-23T00:00:0${seq}.000Z`, type, payload };
}

test("foldNodeEventStream: skips node boundaries and merges text chunks", () => {
  const items = foldNodeEventStream([
    ev(1, "node.started", { nodeId: "plan" }),
    ev(2, "engine.chunk", { nodeId: "plan", chunk: { kind: "text", text: "hello " } }),
    ev(3, "engine.chunk", { nodeId: "plan", chunk: { kind: "text", text: "world" } }),
    ev(4, "engine.chunk", { nodeId: "plan", chunk: { kind: "toolUse", tool: "Read", summary: "a.ts" } }),
    ev(5, "artifact.created", { key: "planDoc" }),
    ev(6, "node.completed", { nodeId: "plan" }),
  ]);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { kind: "text", text: "hello world", ts: "2026-08-23T00:00:02.000Z" });
  assert.equal(items[1]!.kind, "tool");
  assert.equal(items[2]!.kind, "meta");
  if (items[2]!.kind !== "meta") throw new Error("expected meta");
  assert.equal(items[2].label, "交付件");
  assert.equal(items[2].detail, "planDoc");
});

test("foldNodeEventStream: keeps raw chunks as meta", () => {
  const items = foldNodeEventStream([
    ev(1, "engine.chunk", { nodeId: "plan", chunk: { kind: "raw", type: "delta", data: { n: 1 } } }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "meta");
  if (items[0]!.kind !== "meta") throw new Error("expected meta");
  assert.equal(items[0].label, "delta");
});

test("eventsInStageRange: latest running stage includes seqs past eventRange.to", () => {
  const events = [ev(2, "node.started", { nodeId: "plan" }), ev(5, "engine.chunk", { chunk: { kind: "text", text: "x" } })];
  const stage = { eventRange: { from: 2, to: 2 }, status: "running" as const };
  assert.deepEqual(
    eventsInStageRange(events, stage, true).map((e) => e.seq),
    [2, 5],
  );
  assert.deepEqual(
    eventsInStageRange(events, stage, false).map((e) => e.seq),
    [2],
  );
});

test("eventsInStageRange: completed stage stays clipped", () => {
  const events = [ev(1, "node.started", {}), ev(3, "node.completed", {}), ev(4, "node.started", {})];
  const stage = { eventRange: { from: 1, to: 3 }, status: "completed" as const };
  assert.deepEqual(
    eventsInStageRange(events, stage, true).map((e) => e.seq),
    [1, 3],
  );
});
