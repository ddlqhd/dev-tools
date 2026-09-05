import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_FILTERS,
  activeFilterCount,
  filtersFromParams,
  filtersToParams,
  laneOfStatus,
  taskMatchesFilters,
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
