import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlowCursor } from "../src/loop/interpreter.js";

test("parseFlowCursor: defaults and ignores junk", () => {
  assert.deepEqual(parseFlowCursor(undefined), { flowIndex: 0 });
  assert.deepEqual(parseFlowCursor("not-json"), { flowIndex: 0 });
  assert.deepEqual(parseFlowCursor("{}"), { flowIndex: 0 });
});

test("parseFlowCursor: keeps loopExhaustion when present", () => {
  const raw = JSON.stringify({
    flowIndex: 1,
    loopExhaustion: { loopId: "planLoop", iteration: 3, maxIterations: 3 },
  });
  assert.deepEqual(parseFlowCursor(raw), {
    flowIndex: 1,
    loopExhaustion: { loopId: "planLoop", iteration: 3, maxIterations: 3 },
  });
});
