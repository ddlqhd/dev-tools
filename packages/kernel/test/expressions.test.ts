import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExpression } from "../src/loop/expressions.js";

const outcomes = {
  plan: { passed: true, approved: false, comments: 3, name: "x" },
  review: { passed: false },
};

test("path expression: truthy field", () => {
  assert.equal(evaluateExpression("plan.passed", outcomes), true);
  assert.equal(evaluateExpression("review.passed", outcomes), false);
});

test("path expression: missing node/field is falsy", () => {
  assert.equal(evaluateExpression("nope.passed", outcomes), false);
  assert.equal(evaluateExpression("plan.nope", outcomes), false);
});

test("path expression: numeric field is truthy", () => {
  assert.equal(evaluateExpression("plan.comments", outcomes), true);
});

test("equality: boolean/string/number/null", () => {
  assert.equal(evaluateExpression("plan.passed == true", outcomes), true);
  assert.equal(evaluateExpression("plan.passed == false", outcomes), false);
  assert.equal(evaluateExpression("plan.approved == false", outcomes), true);
  assert.equal(evaluateExpression("plan.comments == 3", outcomes), true);
  assert.equal(evaluateExpression("plan.comments == 4", outcomes), false);
  assert.equal(evaluateExpression("plan.passed == null", outcomes), false);
  assert.equal(evaluateExpression('plan.name == "x"', outcomes), true);
  assert.equal(evaluateExpression("plan.name == 'y'", outcomes), false);
});

test("negation", () => {
  assert.equal(evaluateExpression("!review.passed", outcomes), true);
  assert.equal(evaluateExpression("!plan.passed", outcomes), false);
  assert.equal(evaluateExpression("!plan.missing", outcomes), true);
});

test("empty expression is falsy", () => {
  assert.equal(evaluateExpression("", outcomes), false);
  assert.equal(evaluateExpression("   ", outcomes), false);
});

test("unsupported expression throws", () => {
  assert.throws(() => evaluateExpression("plan.passed && review.passed", outcomes), /Unsupported/);
  assert.throws(() => evaluateExpression("random text", outcomes), /Unsupported/);
});
