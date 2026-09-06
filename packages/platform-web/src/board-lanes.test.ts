import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_COMPACT_THRESHOLD,
  COLLAPSE_THRESHOLD,
  coldLaneCollapsed,
  columnVisibleCount,
  parseDensityPrefs,
  parseLanePrefs,
  resolveCompact,
} from "./board-lanes.ts";

test("parseLanePrefs: 只接受完成/失败的折叠状态", () => {
  assert.deepEqual(parseLanePrefs(null), {});
  assert.deepEqual(parseLanePrefs("{"), {});
  assert.deepEqual(parseLanePrefs(JSON.stringify({ done: "collapsed", failed: "nope", queued: "collapsed" })), {
    done: "collapsed",
  });
});

test("coldLaneCollapsed: 热列永不折，空列不折", () => {
  assert.equal(coldLaneCollapsed("running", 40, {}, []), false);
  assert.equal(coldLaneCollapsed("done", 0, {}, []), false);
});

test("coldLaneCollapsed: 达到阈值才自动折", () => {
  assert.equal(coldLaneCollapsed("done", COLLAPSE_THRESHOLD - 1, {}, []), false);
  assert.equal(coldLaneCollapsed("done", COLLAPSE_THRESHOLD, {}, []), true);
  assert.equal(coldLaneCollapsed("failed", 20, {}, []), true);
});

test("coldLaneCollapsed: 手动展开/折叠覆盖阈值", () => {
  assert.equal(coldLaneCollapsed("done", 40, { done: "expanded" }, []), false);
  assert.equal(coldLaneCollapsed("done", 2, { done: "collapsed" }, []), true);
});

test("coldLaneCollapsed: 只筛这一列时强制展开", () => {
  assert.equal(coldLaneCollapsed("done", 40, { done: "collapsed" }, ["done"]), false);
  assert.equal(coldLaneCollapsed("done", 40, {}, ["done", "failed"]), true);
});

test("parseDensityPrefs: 非法值回落到自动/10", () => {
  assert.deepEqual(parseDensityPrefs(null), { compact: "auto", pageSize: 10 });
  assert.deepEqual(parseDensityPrefs(JSON.stringify({ compact: "on", pageSize: 25 })), {
    compact: "on",
    pageSize: 25,
  });
  assert.deepEqual(parseDensityPrefs(JSON.stringify({ compact: "huge", pageSize: 99 })), {
    compact: "auto",
    pageSize: 10,
  });
});

test("resolveCompact: auto 在超过 100 条时打开", () => {
  assert.equal(resolveCompact({ compact: "auto", pageSize: 10 }, AUTO_COMPACT_THRESHOLD), false);
  assert.equal(resolveCompact({ compact: "auto", pageSize: 10 }, AUTO_COMPACT_THRESHOLD + 1), true);
  assert.equal(resolveCompact({ compact: "off", pageSize: 10 }, 500), false);
});

test("columnVisibleCount: 至少一页，不超过总数", () => {
  assert.equal(columnVisibleCount(3, 0, 10), 3);
  assert.equal(columnVisibleCount(40, 10, 10), 10);
  assert.equal(columnVisibleCount(40, 20, 10), 20);
  assert.equal(columnVisibleCount(40, 80, 10), 40);
});
