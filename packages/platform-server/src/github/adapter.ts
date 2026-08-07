import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  CreatePrRequest,
  IssueRef,
  PlatformAdapter,
  PlatformComment,
  PlatformEvent,
  PlatformIssue,
  PlatformTaskStatus,
  ProgressReport,
  PrRef,
  RepoRef,
} from "@devtools/shared";
import { parseCodeloopCommand } from "@devtools/shared";

export class GitHubAdapter implements PlatformAdapter {
  readonly type = "github" as const;

  constructor(private readonly token: string) {
    if (!token) throw new Error("GitHub token required");
  }

  private async api<T>(
    path: string,
    init?: RequestInit & { raw?: boolean },
  ): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "codeloop-platform",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${path} → ${res.status}: ${text.slice(0, 400)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async pollCandidateIssues(repo: RepoRef, triggerLabel: string): Promise<PlatformIssue[]> {
    const [owner, name] = split(repo.fullName);
    const issues = await this.api<
      Array<{
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        labels: Array<{ name: string }>;
        pull_request?: unknown;
      }>
    >(
      `/repos/${owner}/${name}/issues?state=open&labels=${encodeURIComponent(triggerLabel)}&per_page=50`,
    );

    const out: PlatformIssue[] = [];
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const labels = issue.labels.map((l) => l.name);
      if (labels.includes("ai-dev:needs-info")) continue;
      if (labels.includes("ai-dev:in-progress")) continue;
      const comments = await this.fetchIssueComments(owner, name, issue.number);
      out.push({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        labels,
        htmlUrl: issue.html_url,
        comments,
      });
    }
    return out;
  }

  async handleWebhook(
    headers: Record<string, string>,
    body: unknown,
    opts?: {
      triggerLabel?: string;
      webhookSecret?: string;
      rawBody?: string | Uint8Array;
    },
  ): Promise<PlatformEvent | null> {
    if (opts?.webhookSecret) {
      const sig = headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"];
      if (!verifySignature(opts.webhookSecret, opts.rawBody ?? body, sig)) {
        throw new Error("invalid webhook signature");
      }
    }

    const event = headers["x-github-event"] ?? headers["X-GitHub-Event"];
    const payload = body as Record<string, unknown>;
    const repoFull =
      (payload.repository as { full_name?: string } | undefined)?.full_name ?? "";
    const repo: RepoRef = { platform: "github", fullName: repoFull };
    const trigger = opts?.triggerLabel ?? "ai-dev";

    if (event === "issues") {
      const action = payload.action as string;
      const issueRaw = payload.issue as {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        labels: Array<{ name: string }>;
        pull_request?: unknown;
      };
      if (issueRaw.pull_request) return null;
      const label =
        (payload.label as { name?: string } | undefined)?.name ??
        (action === "opened" || action === "labeled"
          ? issueRaw.labels.find((l) => l.name === trigger)?.name
          : undefined);
      if (action === "labeled" && label === trigger) {
        return {
          kind: "issue_labeled",
          label: trigger,
          repo,
          issue: {
            number: issueRaw.number,
            title: issueRaw.title,
            body: issueRaw.body ?? "",
            labels: issueRaw.labels.map((l) => l.name),
            htmlUrl: issueRaw.html_url,
            comments: [],
          },
        };
      }
      return null;
    }

    if (event === "issue_comment") {
      const comment = payload.comment as { body: string; user: { login: string } };
      const issue = payload.issue as { number: number; pull_request?: unknown };
      if (issue.pull_request) {
        // still allow /codeloop on PR comments mapped via issue number
      }
      const cmd = parseCodeloopCommand(comment.body);
      if (cmd) {
        return {
          kind: "codeloop_command",
          issueNumber: issue.number,
          command: cmd.command,
          args: cmd.args,
          user: comment.user.login,
          repo,
        };
      }
      return {
        kind: "issue_comment",
        issueNumber: issue.number,
        comment: comment.body,
        user: comment.user.login,
        repo,
      };
    }

    return null;
  }

  async claimIssue(issue: IssueRef, consoleUrl?: string): Promise<void> {
    const [owner, name] = split(issue.repo.fullName);
    const current = await this.api<{ labels: Array<{ name: string }> }>(
      `/repos/${owner}/${name}/issues/${issue.number}`,
    );
    if (current.labels.some((l) => l.name === "ai-dev:in-progress")) {
      throw new Error("claim failed: already in-progress");
    }

    const existing = await this.fetchIssueComments(owner, name, issue.number);
    if (existing.some((c) => c.body.includes("<!-- codeloop-claim -->"))) {
      throw new Error("claim failed: claim comment already present");
    }

    // Comment-first mutex: earliest claim comment wins (GitHub ids are monotonic).
    const claimId = randomUUID();
    const body = [
      "<!-- codeloop-claim -->",
      `<!-- claim-id:${claimId} -->`,
      "**codeloop** claimed this issue.",
      consoleUrl ? `Console: ${consoleUrl}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    await this.api(`/repos/${owner}/${name}/issues/${issue.number}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });

    const after = await this.api<Array<{ id: number; body: string }>>(
      `/repos/${owner}/${name}/issues/${issue.number}/comments?per_page=100`,
    );
    const claims = after
      .filter((c) => c.body.includes("<!-- codeloop-claim -->"))
      .sort((a, b) => a.id - b.id);
    const winner = claims[0];
    if (!winner || !winner.body.includes(`<!-- claim-id:${claimId} -->`)) {
      throw new Error("claim failed: lost race");
    }

    try {
      await this.api(`/repos/${owner}/${name}/issues/${issue.number}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: ["ai-dev:in-progress"] }),
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      throw new Error(`claim failed (label): ${err instanceof Error ? err.message : err}`);
    }
  }

  async postProgress(issue: IssueRef, report: ProgressReport): Promise<void> {
    const [owner, name] = split(issue.repo.fullName);
    const marker = "<!-- codeloop-progress -->";
    const body = [
      marker,
      `### codeloop progress`,
      "",
      `**Status:** \`${report.status}\`${report.currentNode ? ` · node \`${report.currentNode}\`` : ""}`,
      report.branch ? `**Branch:** \`${report.branch}\`` : null,
      report.consoleUrl ? `**Console:** ${report.consoleUrl}` : null,
      "",
      report.summary,
      report.detailMarkdown ? `\n${report.detailMarkdown}` : null,
    ]
      .filter((x) => x !== null)
      .join("\n");

    const comments = await this.api<Array<{ id: number; body: string; user: { type: string } }>>(
      `/repos/${owner}/${name}/issues/${issue.number}/comments?per_page=100`,
    );
    const existing = comments.find((c) => c.body.includes(marker));
    if (existing) {
      await this.api(`/repos/${owner}/${name}/issues/comments/${existing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
    } else {
      await this.api(`/repos/${owner}/${name}/issues/${issue.number}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
    }
  }

  async createPullRequest(req: CreatePrRequest): Promise<PrRef> {
    const [owner, name] = split(req.repo.fullName);
    const pr = await this.api<{ number: number; html_url: string }>(
      `/repos/${owner}/${name}/pulls`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: req.title,
          body: req.body,
          head: req.head,
          base: req.base,
        }),
      },
    );
    return { repo: req.repo, number: pr.number, url: pr.html_url };
  }

  async updateStatus(issue: IssueRef, status: PlatformTaskStatus): Promise<void> {
    // Soft status via progress comment only for M3
    await this.postProgress(issue, {
      summary: `Status updated to \`${status}\``,
      status,
    });
  }

  async fetchPrComments(pr: PrRef, _since?: string): Promise<PlatformComment[]> {
    const [owner, name] = split(pr.repo.fullName);
    const comments = await this.api<
      Array<{ id: number; body: string; user: { login: string }; created_at: string }>
    >(`/repos/${owner}/${name}/issues/${pr.number}/comments?per_page=100`);
    return comments.map((c) => ({
      id: String(c.id),
      user: c.user.login,
      body: c.body,
      createdAt: c.created_at,
    }));
  }

  private async fetchIssueComments(
    owner: string,
    name: string,
    number: number,
  ): Promise<Array<{ user: string; body: string }>> {
    try {
      const comments = await this.api<Array<{ body: string; user: { login: string } }>>(
        `/repos/${owner}/${name}/issues/${number}/comments?per_page=30`,
      );
      return comments.map((c) => ({ user: c.user.login, body: c.body }));
    } catch {
      return [];
    }
  }
}

function split(fullName: string): [string, string] {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) throw new Error(`invalid repo full name: ${fullName}`);
  return [owner, name];
}

function verifySignature(
  secret: string,
  body: unknown,
  signature: string | undefined,
): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  let raw: Buffer;
  if (typeof body === "string") raw = Buffer.from(body, "utf8");
  else if (body instanceof Uint8Array) raw = Buffer.from(body);
  else {
    // Fallback only — callers should pass the original request bytes.
    raw = Buffer.from(JSON.stringify(body), "utf8");
  }
  const digest = createHmac("sha256", secret).update(raw).digest("hex");
  const expected = `sha256=${digest}`;
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
