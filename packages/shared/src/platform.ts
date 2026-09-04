export type PlatformType = "github" | "gitlab" | "gitee";

export type PlatformTaskStatus =
  | "queued"
  | "preparing"
  | "running"
  | "paused"
  | "waiting_human"
  | "delivering"
  | "done"
  | "merged"
  | "failed"
  | "cancelled";

export interface RepoRef {
  platform: PlatformType;
  fullName: string; // owner/name
}

export interface IssueRef {
  repo: RepoRef;
  number: number;
}

export interface PrRef {
  repo: RepoRef;
  number: number;
  url?: string;
}

export interface PlatformIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  htmlUrl: string;
  comments: Array<{ user: string; body: string }>;
}

export interface PlatformComment {
  id: string;
  user: string;
  body: string;
  createdAt: string;
}

export interface ProgressReport {
  summary: string;
  status: PlatformTaskStatus;
  currentNode?: string;
  branch?: string;
  prNumber?: number;
  consoleUrl?: string;
  detailMarkdown?: string;
}

export interface CreatePrRequest {
  repo: RepoRef;
  title: string;
  body: string;
  head: string;
  base: string;
  issueNumber?: number;
}

export type PlatformEvent =
  | { kind: "issue_labeled"; issue: PlatformIssue; label: string; repo: RepoRef }
  | {
      kind: "issue_comment";
      issueNumber: number;
      comment: string;
      user: string;
      repo: RepoRef;
    }
  | {
      kind: "codeloop_command";
      issueNumber: number;
      command: string;
      args: string;
      user: string;
      repo: RepoRef;
    }
  | {
      kind: "pr_merged";
      prNumber: number;
      branch: string;
      repo: RepoRef;
    }
  | {
      kind: "ci_failed";
      prNumber?: number;
      branch?: string;
      headSha?: string;
      /** Human-readable failing check names + optional run URLs. */
      checks: Array<{ name: string; url?: string }>;
      repo: RepoRef;
    };

/** Kernel-facing platform adapter contract (L2). */
export interface PlatformAdapter {
  readonly type: PlatformType;
  pollCandidateIssues(repo: RepoRef, triggerLabel: string): Promise<PlatformIssue[]>;
  handleWebhook(
    headers: Record<string, string>,
    body: unknown,
    opts?: {
      triggerLabel?: string;
      webhookSecret?: string;
      /** Original request body bytes/text for HMAC (do not re-serialize JSON). */
      rawBody?: string | Uint8Array;
    },
  ): Promise<PlatformEvent | null>;
  claimIssue(issue: IssueRef, consoleUrl?: string): Promise<void>;
  postProgress(issue: IssueRef, report: ProgressReport): Promise<void>;
  createPullRequest(req: CreatePrRequest): Promise<PrRef>;
  updateStatus(issue: IssueRef, status: PlatformTaskStatus): Promise<void>;
  fetchPrComments(pr: PrRef, since?: string): Promise<PlatformComment[]>;
}

export type CodeloopCommentCommand =
  | { command: "approve"; args: string }
  | { command: "reject"; args: string }
  | { command: "inject"; args: string }
  | { command: "abort"; args: string }
  | { command: "resume"; args: string };

/** Parse `/codeloop <cmd> [args…]` from an issue/PR comment body. */
export function parseCodeloopCommand(body: string): CodeloopCommentCommand | null {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^\/codeloop\b/i.test(l));
  if (!line) return null;
  const rest = line.replace(/^\/codeloop\s*/i, "").trim();
  if (!rest) return null;
  const m = /^(\w+)\s*([\s\S]*)$/.exec(rest);
  if (!m) return null;
  const command = m[1]!.toLowerCase();
  const args = (m[2] ?? "").trim();
  if (
    command !== "approve" &&
    command !== "reject" &&
    command !== "inject" &&
    command !== "abort" &&
    command !== "resume"
  ) {
    return null;
  }
  return { command, args };
}

/** Build requirement text from an issue title/body/comments. */
export function issueToRequirement(issue: PlatformIssue): string {
  const parts = [`# ${issue.title}`, "", issue.body?.trim() || "(no description)"];
  if (issue.comments.length) {
    parts.push("", "## Discussion", "");
    for (const c of issue.comments) {
      parts.push(`### @${c.user}`, c.body, "");
    }
  }
  return parts.join("\n").trim();
}
