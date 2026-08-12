import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { GitHubAdapter } from "../src/github/adapter.js";

type FetchMock = ReturnType<typeof mock.method<typeof globalThis, "fetch">>;

let fetchMock: FetchMock | undefined;

function mockFetch(handler: (url: string, init?: RequestInit) => unknown): void {
  fetchMock?.mock.restore();
  fetchMock = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const data = await handler(u, init);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => {
  fetchMock?.mock.restore();
  fetchMock = undefined;
});

function signedHeaders(secret: string, body: string): Record<string, string> {
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return { "x-hub-signature-256": `sha256=${sig}`, "x-github-event": "issues" };
}

test("handleWebhook: issue labeled with trigger → issue_labeled", async () => {
  const adapter = new GitHubAdapter("token");
  const body = JSON.stringify({
    action: "labeled",
    label: { name: "ai-dev" },
    repository: { full_name: "acme/repo" },
    issue: {
      number: 42,
      title: "Do the thing",
      body: "details",
      html_url: "https://github.com/acme/repo/issues/42",
      labels: [{ name: "ai-dev" }],
      pull_request: undefined,
    },
  });
  const event = await adapter.handleWebhook(signedHeaders("sec", body), JSON.parse(body), {
    triggerLabel: "ai-dev",
    webhookSecret: "sec",
    rawBody: body,
  });
  assert.equal(event?.kind, "issue_labeled");
  if (event?.kind === "issue_labeled") {
    assert.equal(event.issue.number, 42);
    assert.equal(event.repo.fullName, "acme/repo");
  }
});

test("handleWebhook: non-trigger label is ignored", async () => {
  const adapter = new GitHubAdapter("token");
  const body = {
    action: "labeled",
    label: { name: "bug" },
    repository: { full_name: "acme/repo" },
    issue: { number: 1, title: "t", body: "", html_url: "", labels: [{ name: "bug" }] },
  };
  const event = await adapter.handleWebhook({ "x-github-event": "issues" }, body, { triggerLabel: "ai-dev" });
  assert.equal(event, null);
});

test("handleWebhook: issue_comment with /codeloop approve → codeloop_command", async () => {
  const adapter = new GitHubAdapter("token");
  const body = {
    repository: { full_name: "acme/repo" },
    issue: { number: 7, pull_request: undefined },
    comment: { body: "/codeloop approve", user: { login: "alice" } },
  };
  const event = await adapter.handleWebhook({ "x-github-event": "issue_comment" }, body);
  assert.equal(event?.kind, "codeloop_command");
  if (event?.kind === "codeloop_command") {
    assert.equal(event.command, "approve");
    assert.equal(event.user, "alice");
    assert.equal(event.issueNumber, 7);
  }
});

test("handleWebhook: /codeloop reject with args keeps args", async () => {
  const adapter = new GitHubAdapter("token");
  const body = {
    repository: { full_name: "acme/repo" },
    issue: { number: 7 },
    comment: { body: "/codeloop reject approach is wrong", user: { login: "bob" } },
  };
  const event = await adapter.handleWebhook({ "x-github-event": "issue_comment" }, body);
  assert.equal(event?.kind, "codeloop_command");
  if (event?.kind === "codeloop_command") {
    assert.equal(event.command, "reject");
    assert.equal(event.args, "approach is wrong");
  }
});

test("handleWebhook: plain comment → issue_comment", async () => {
  const adapter = new GitHubAdapter("token");
  const body = {
    repository: { full_name: "acme/repo" },
    issue: { number: 7 },
    comment: { body: "just chatting", user: { login: "carol" } },
  };
  const event = await adapter.handleWebhook({ "x-github-event": "issue_comment" }, body);
  assert.equal(event?.kind, "issue_comment");
  if (event?.kind === "issue_comment") {
    assert.equal(event.comment, "just chatting");
  }
});

test("handleWebhook: pull request issue payloads are ignored", async () => {
  const adapter = new GitHubAdapter("token");
  const body = {
    action: "labeled",
    label: { name: "ai-dev" },
    repository: { full_name: "acme/repo" },
    issue: { number: 99, title: "t", body: "", html_url: "", labels: [{ name: "ai-dev" }], pull_request: {} },
  };
  const event = await adapter.handleWebhook({ "x-github-event": "issues" }, body, { triggerLabel: "ai-dev" });
  assert.equal(event, null);
});

test("handleWebhook: wrong secret rejects, right secret passes", async () => {
  const adapter = new GitHubAdapter("token");
  const body = '{"action":"labeled","label":{"name":"ai-dev"},"repository":{"full_name":"a/b"},"issue":{"number":1,"title":"t","body":"","html_url":"","labels":[{"name":"ai-dev"}]}}';
  await assert.rejects(
    () => adapter.handleWebhook(signedHeaders("wrong", body), JSON.parse(body), {
      triggerLabel: "ai-dev",
      webhookSecret: "right",
      rawBody: body,
    }),
    /invalid webhook signature/,
  );
  const ok = await adapter.handleWebhook(signedHeaders("right", body), JSON.parse(body), {
    triggerLabel: "ai-dev",
    webhookSecret: "right",
    rawBody: body,
  });
  assert.equal(ok?.kind, "issue_labeled");
});

test("pollCandidateIssues: filters PRs, needs-info and in-progress", async () => {
  mockFetch((url: string) => {
    if (url.includes("/issues?state=open")) {
      return [
        { number: 1, title: "a", body: "", html_url: "u1", labels: [{ name: "ai-dev" }] },
        { number: 2, title: "b", body: "", html_url: "u2", labels: [{ name: "ai-dev" }], pull_request: {} },
        { number: 3, title: "c", body: "", html_url: "u3", labels: [{ name: "ai-dev:needs-info" }] },
        { number: 4, title: "d", body: "", html_url: "u4", labels: [{ name: "ai-dev:in-progress" }] },
        { number: 5, title: "e", body: "", html_url: "u5", labels: [{ name: "ai-dev" }] },
      ];
    }
    if (url.includes("/comments")) {
      return [];
    }
    return [];
  });
  const adapter = new GitHubAdapter("token");
  const issues = await adapter.pollCandidateIssues(
    { platform: "github", fullName: "acme/repo" },
    "ai-dev",
  );
  assert.deepEqual(issues.map((i) => i.number), [1, 5]);
});

test("claimIssue: loses the race when another claim comment exists first", async () => {
  const calls: string[] = [];
  mockFetch((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    // issue detail
    if (/\/issues\/1$/.test(url)) {
      return { labels: [{ name: "ai-dev" }] };
    }
    // after posting our claim comment, the list shows a different claim first
    if (url.includes("comments?per_page")) {
      return [{ id: 101, body: "<!-- codeloop-claim -->\n<!-- claim-id:not-mine -->" }];
    }
    return [];
  });
  const adapter = new GitHubAdapter("token");
  await assert.rejects(
    () => adapter.claimIssue({ repo: { platform: "github", fullName: "a/b" }, number: 1 }),
    /lost race/,
  );
  assert.ok(calls.some((c) => c === "POST https://api.github.com/repos/a/b/issues/1/comments"));
});

test("postProgress: PATCHes the existing marker comment", async () => {
  const calls: string[] = [];
  mockFetch((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/comments?per_page")) {
      return [{ id: 500, body: "<!-- codeloop-progress -->" }];
    }
    return [];
  });
  const adapter = new GitHubAdapter("token");
  await adapter.postProgress(
    { repo: { platform: "github", fullName: "a/b" }, number: 1 },
    { summary: "working", status: "running" },
  );
  assert.ok(calls.includes("PATCH https://api.github.com/repos/a/b/issues/comments/500"));
});
