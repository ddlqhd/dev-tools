import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikePlan, resolvePlanContent } from "../src/loop/runners/agent.js";

const STRUCTURED_EN = `# Goal
Ship the flag.

# Approach
1. Edit the config.
2. Add a test.

# Files likely to change
- src/a.ts`;

const STRUCTURED_ZH = `### 目标
完成这项改动，并保证现有测试仍然通过。

### 方案
1. 修改入口模块。
2. 补上对应测试。`;

test("looksLikePlan: structured English plan is accepted", () => {
  assert.equal(looksLikePlan(STRUCTURED_EN), true);
});

test("looksLikePlan: structured Chinese plan is accepted", () => {
  assert.equal(looksLikePlan(STRUCTURED_ZH), true);
});

test("looksLikePlan: short chatter is rejected", () => {
  assert.equal(looksLikePlan("I'll start by reading the repo now."), false);
  assert.equal(looksLikePlan("正在生成计划，请稍候……"), false);
});

test("looksLikePlan: below 40 chars is rejected even with keywords", () => {
  assert.equal(looksLikePlan("Goal Approach"), false);
});

test("resolvePlanContent: captured markdown >= 40 is accepted without sniffing", () => {
  const captured = "x".repeat(40);
  assert.equal(
    resolvePlanContent({ text: "I'll think about it", capturedPlanMarkdown: captured }),
    captured,
  );
});

test("resolvePlanContent: captured markdown under 40 is ignored", () => {
  const out = resolvePlanContent({
    text: "I'll think about it",
    capturedPlanMarkdown: "too short",
  });
  assert.equal(out, null);
});

test("resolvePlanContent: falls back to structured final text", () => {
  assert.equal(resolvePlanContent({ text: STRUCTURED_EN }), STRUCTURED_EN);
});
