import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodeloopCommand, issueToRequirement } from "../src/platform.js";

test("parseCodeloopCommand: each supported command with args", () => {
  assert.deepEqual(parseCodeloopCommand("/codeloop approve"), { command: "approve", args: "" });
  assert.deepEqual(parseCodeloopCommand("/codeloop reject wrong approach"), {
    command: "reject",
    args: "wrong approach",
  });
  assert.deepEqual(parseCodeloopCommand("/codeloop inject  add a test"), {
    command: "inject",
    args: "add a test",
  });
  assert.deepEqual(parseCodeloopCommand("/codeloop abort"), { command: "abort", args: "" });
  assert.deepEqual(parseCodeloopCommand("/codeloop resume"), { command: "resume", args: "" });
});

test("parseCodeloopCommand: case-insensitive command", () => {
  assert.deepEqual(parseCodeloopCommand("/CODELOOP Approve"), { command: "approve", args: "" });
});

test("parseCodeloopCommand: finds the command line in a multi-line comment", () => {
  const body = "LGTM.\n\n/codeloop reject needs more tests\n\nThanks!";
  assert.deepEqual(parseCodeloopCommand(body), {
    command: "reject",
    args: "needs more tests",
  });
});

test("parseCodeloopCommand: null for non-command comments", () => {
  assert.equal(parseCodeloopCommand("just a comment"), null);
  assert.equal(parseCodeloopCommand("/othercmd approve"), null);
  assert.equal(parseCodeloopCommand("/codeloop"), null);
  assert.equal(parseCodeloopCommand("/codeloop fly"), null);
  assert.equal(parseCodeloopCommand(""), null);
});

test("issueToRequirement: title + body", () => {
  const req = issueToRequirement({
    number: 1,
    title: "Fix the bug",
    body: "It crashes on startup.",
    labels: ["ai-dev"],
    htmlUrl: "https://example.com/1",
    comments: [],
  });
  assert.match(req, /^# Fix the bug/);
  assert.match(req, /It crashes on startup\./);
});

test("issueToRequirement: falls back when body missing", () => {
  const req = issueToRequirement({
    number: 2,
    title: "Add feature",
    body: "",
    labels: [],
    htmlUrl: "https://example.com/2",
    comments: [],
  });
  assert.match(req, /\(no description\)/);
});

test("issueToRequirement: appends discussion comments", () => {
  const req = issueToRequirement({
    number: 3,
    title: "T",
    body: "B",
    labels: [],
    htmlUrl: "",
    comments: [
      { user: "alice", body: "first" },
      { user: "bob", body: "second" },
    ],
  });
  assert.match(req, /## Discussion/);
  assert.match(req, /### @alice/);
  assert.match(req, /first/);
  assert.match(req, /### @bob/);
  assert.match(req, /second/);
});
