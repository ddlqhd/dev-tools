import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePersistedAndLive } from "./merge-events.ts";

test("mergePersistedAndLive: keeps live tokens ahead of the coalesced snapshot", () => {
  const persisted = [{ seq: 4, text: "写下" }];
  const live = [
    { seq: 3, text: "写" },
    { seq: 4, text: "下" },
    { seq: 5, text: "来" },
  ];
  assert.deepEqual(mergePersistedAndLive(persisted, live), [
    { seq: 4, text: "写下" },
    { seq: 5, text: "来" },
  ]);
});

test("mergePersistedAndLive: empty snapshot keeps the live buffer", () => {
  const live = [{ seq: 1, text: "a" }];
  assert.equal(mergePersistedAndLive([], live), live);
});
