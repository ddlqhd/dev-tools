import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTENTION_COLUMNS,
  EMPTY_FILTERS,
  activeFilterCount,
  applyFiltersToSearchParams,
  defaultKeep,
  filtersFromParams,
  filtersToParams,
  laneOfStatus,
  parseBoardView,
  taskMatchesFilters,
  taskMatchesKeep,
  type BoardFilters,
} from "./board-filters.ts";
import type { Task } from "./api.ts";

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    repo_id: "r1",
    source: "manual",
    issue_number: null,
    title: "修复登录跳转",
    requirement: "",
    status: "running",
    priority: 0,
    instance_id: null,
    kernel_task_id: null,
    branch: "codeloop/abc123",
    pr_number: null,
    current_node: "implement",
    loop_state: null,
    pipeline_name: "default",
    error: null,
    created_at: "2026-09-05T02:00:00.000Z",
    updated_at: "2026-09-05T02:00:00.000Z",
    ...over,
  };
}

const ctx = { repoName: (id: string) => (id === "r1" ? "local/dev-tools" : id), range: null };

function withFilters(over: Partial<BoardFilters>): BoardFilters {
  return { ...EMPTY_FILTERS, ...over };
}

test("laneOfStatus: 把细分状态收敛到看板泳道", () => {
  assert.equal(laneOfStatus("preparing"), "queued");
  assert.equal(laneOfStatus("delivering"), "running");
  assert.equal(laneOfStatus("merged"), "done");
  assert.equal(laneOfStatus("cancelled"), "failed");
});

test("taskMatchesFilters: 空筛选放行一切", () => {
  assert.equal(taskMatchesFilters(makeTask(), EMPTY_FILTERS, ctx), true);
});

test("taskMatchesFilters: 泳道按状态归组而非精确状态匹配", () => {
  const task = makeTask({ status: "delivering" });
  assert.equal(taskMatchesFilters(task, withFilters({ lanes: ["running"] }), ctx), true);
  assert.equal(taskMatchesFilters(task, withFilters({ lanes: ["queued"] }), ctx), false);
});

test("taskMatchesFilters: 多选维度取并集", () => {
  const filters = withFilters({ repos: ["r1", "r2"] });
  assert.equal(taskMatchesFilters(makeTask({ repo_id: "r2" }), filters, ctx), true);
  assert.equal(taskMatchesFilters(makeTask({ repo_id: "r9" }), filters, ctx), false);
});

test("taskMatchesFilters: 搜索覆盖标题、仓库名与分支", () => {
  const task = makeTask();
  assert.equal(taskMatchesFilters(task, withFilters({ q: "登录" }), ctx), true);
  assert.equal(taskMatchesFilters(task, withFilters({ q: "dev-tools" }), ctx), true);
  assert.equal(taskMatchesFilters(task, withFilters({ q: "abc123" }), ctx), true);
  assert.equal(taskMatchesFilters(task, withFilters({ q: "不存在" }), ctx), false);
});

test("taskMatchesFilters: 没有 pipeline 的任务会被 pipeline 筛选排除", () => {
  const filters = withFilters({ pipelines: ["default"] });
  assert.equal(taskMatchesFilters(makeTask({ pipeline_name: null }), filters, ctx), false);
});

test("taskMatchesFilters: 各维度之间取交集", () => {
  const filters = withFilters({ lanes: ["running"], repos: ["r1"], q: "登录" });
  assert.equal(taskMatchesFilters(makeTask(), filters, ctx), true);
  assert.equal(taskMatchesFilters(makeTask({ repo_id: "r2" }), filters, ctx), false);
});

test("URL 往返：非默认值才写进 query", () => {
  assert.equal(filtersToParams(EMPTY_FILTERS).toString(), "");

  const filters = withFilters({
    q: "登录",
    lanes: ["running", "failed"],
    repos: ["r1"],
    time: "7d",
  });
  const round = filtersFromParams(new URLSearchParams(filtersToParams(filters).toString()));
  assert.deepEqual(round, filters);
});

test("filtersFromParams: 非法时间模式回落到 all", () => {
  const parsed = filtersFromParams(new URLSearchParams("t=昨天"));
  assert.equal(parsed.time, "all");
});

test("activeFilterCount: 按维度计数，而不是按选项个数", () => {
  assert.equal(activeFilterCount(EMPTY_FILTERS), 0);
  assert.equal(activeFilterCount(withFilters({ lanes: ["a", "b", "c"] })), 1);
  assert.equal(activeFilterCount(withFilters({ lanes: ["a"], q: "x", time: "today" })), 3);
  assert.equal(activeFilterCount(withFilters({ q: "   " })), 0);
});

test("ATTENTION_COLUMNS: 等人与失败在前，完成在后", () => {
  assert.deepEqual(
    ATTENTION_COLUMNS.map((c) => c.key),
    ["waiting_human", "failed", "paused", "running", "queued", "done"],
  );
});

test("parseBoardView: 只接受三种视图", () => {
  assert.equal(parseBoardView("focus"), "focus");
  assert.equal(parseBoardView("kanban"), null);
});

test("defaultKeep: 看板/注意 7 天，列表全部保留", () => {
  assert.equal(defaultKeep("board"), "7d");
  assert.equal(defaultKeep("focus"), "7d");
  assert.equal(defaultKeep("list"), "all");
});

test("keep 缺省不写进 URL，显式值才写", () => {
  assert.equal(filtersToParams(EMPTY_FILTERS, "board").get("keep"), null);
  assert.equal(filtersToParams(withFilters({ keep: "all" }), "list").get("keep"), null);
  assert.equal(filtersToParams(withFilters({ keep: "all" }), "board").get("keep"), "all");
  assert.equal(filtersToParams(withFilters({ keep: "7d" }), "list").get("keep"), "7d");
});

test("filtersFromParams: 未写 keep 时按视图回落", () => {
  assert.equal(filtersFromParams(new URLSearchParams(), "board").keep, "7d");
  assert.equal(filtersFromParams(new URLSearchParams(), "list").keep, "all");
  assert.equal(filtersFromParams(new URLSearchParams("keep=30d"), "list").keep, "30d");
});

test("activeFilterCount: 缺省 keep 不计入，显式 keep 计入", () => {
  assert.equal(activeFilterCount(withFilters({ keep: "7d" }), "board"), 0);
  assert.equal(activeFilterCount(withFilters({ keep: "all" }), "board"), 1);
  assert.equal(activeFilterCount(withFilters({ keep: "30d" }), "board"), 1);
  assert.equal(activeFilterCount(withFilters({ keep: "all" }), "list"), 0);
  assert.equal(activeFilterCount(withFilters({ keep: "7d" }), "list"), 1);
});

test("applyFiltersToSearchParams: 保留 view/group/sort/archived", () => {
  const current = new URLSearchParams("view=list&group=repo&sort=title&archived=1&q=旧");
  const next = applyFiltersToSearchParams(current, withFilters({ q: "新" }), "list");
  assert.equal(next.get("view"), "list");
  assert.equal(next.get("group"), "repo");
  assert.equal(next.get("sort"), "title");
  assert.equal(next.get("archived"), "1");
  assert.equal(next.get("q"), "新");
});

test("taskMatchesKeep: 热态永远留下，终态按 updated_at 衰减", () => {
  const now = Date.parse("2026-09-06T12:00:00.000Z");
  const running = makeTask({ status: "running", updated_at: "2026-01-01T00:00:00.000Z" });
  const recentDone = makeTask({
    status: "done",
    updated_at: "2026-09-05T12:00:00.000Z",
  });
  const oldDone = makeTask({
    status: "done",
    updated_at: "2026-08-01T12:00:00.000Z",
  });
  const oldFailed = makeTask({
    status: "failed",
    updated_at: "2026-08-20T12:00:00.000Z",
  });

  assert.equal(taskMatchesKeep(running, "7d", now), true);
  assert.equal(taskMatchesKeep(recentDone, "7d", now), true);
  assert.equal(taskMatchesKeep(oldDone, "7d", now), false);
  assert.equal(taskMatchesKeep(oldFailed, "7d", now), false);
  assert.equal(taskMatchesKeep(oldDone, "all", now), true);
  assert.equal(taskMatchesKeep(oldFailed, "30d", now), true);
});
