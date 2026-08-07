import { randomUUID } from "node:crypto";
import { issueToRequirement, type PlatformIssue } from "@devtools/shared";
import type { PlatformConfig } from "./config.js";
import type { PlatformStore, RepoRow, TaskRow } from "./db/store.js";
import { GitHubAdapter } from "./github/adapter.js";
import { KernelClient } from "./kernel-client.js";
import type { LocalProcessLauncher, InstanceHandle } from "./launcher/local.js";
import type { RepoManager } from "./repo-manager.js";
import type { EventSync } from "./sync.js";

export type HubEmit = (event: { type: string; payload: unknown }) => void;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly live = new Map<string, InstanceHandle>();

  constructor(
    private readonly store: PlatformStore,
    private readonly config: PlatformConfig,
    private readonly repos: RepoManager,
    private readonly launcher: LocalProcessLauncher,
    private readonly sync: EventSync,
    private readonly hub: HubEmit,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.config.scheduler.tickMs);
    this.pollTimer = setInterval(
      () => void this.pollGitHub(),
      this.config.scheduler.pollIntervalMs,
    );
    void this.tick();
    void this.pollGitHub();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.timer = null;
    this.pollTimer = null;
  }

  async enqueueManual(opts: {
    repoId: string;
    title: string;
    requirement: string;
    priority?: number;
    pipeline?: string;
  }): Promise<TaskRow> {
    const repo = this.store.getRepo(opts.repoId);
    if (!repo) throw new Error(`repo not found: ${opts.repoId}`);
    const now = new Date().toISOString();
    const task: TaskRow = {
      id: randomUUID().slice(0, 10),
      repo_id: repo.id,
      source: "manual",
      issue_number: null,
      title: opts.title,
      requirement: opts.requirement,
      status: "queued",
      priority: opts.priority ?? 0,
      instance_id: null,
      kernel_task_id: null,
      branch: null,
      pr_number: null,
      current_node: null,
      loop_state: null,
      pipeline_name: opts.pipeline ?? null,
      progress_comment_id: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    this.store.insertTask(task);
    this.hub({ type: "task.updated", payload: task });
    void this.tick();
    return task;
  }

  async enqueueIssue(repo: RepoRow, issue: PlatformIssue): Promise<TaskRow | null> {
    if (issue.labels.includes("ai-dev:needs-info")) return null;
    const existing = this.store.findOpenTaskByIssue(repo.id, issue.number);
    if (existing) return existing;

    const adapter = this.adapterFor(repo);
    if (!adapter) return null;

    const consoleUrl =
      this.config.consoleBaseUrl ??
      `http://${this.config.listen.host}:${this.config.listen.port}`;
    try {
      await adapter.claimIssue(
        { repo: { platform: "github", fullName: repo.full_name }, number: issue.number },
        consoleUrl,
      );
    } catch {
      return null; // already claimed / race lost
    }

    // Enrich comments if empty
    let enriched = issue;
    if (!issue.comments.length) {
      const polled = await adapter.pollCandidateIssues(
        { platform: "github", fullName: repo.full_name },
        repo.trigger_label,
      );
      enriched = polled.find((i) => i.number === issue.number) ?? issue;
    }

    const now = new Date().toISOString();
    const task: TaskRow = {
      id: randomUUID().slice(0, 10),
      repo_id: repo.id,
      source: "issue",
      issue_number: issue.number,
      title: issue.title,
      requirement: issueToRequirement(enriched),
      status: "queued",
      priority: 0,
      instance_id: null,
      kernel_task_id: null,
      branch: null,
      pr_number: null,
      current_node: null,
      loop_state: null,
      pipeline_name: null,
      progress_comment_id: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    this.store.insertTask(task);
    this.hub({ type: "task.updated", payload: task });
    return task;
  }

  async pollGitHub(): Promise<void> {
    for (const repo of this.store.listRepos()) {
      if (repo.platform !== "github") continue;
      const adapter = this.adapterFor(repo);
      if (!adapter) continue;
      try {
        const issues = await adapter.pollCandidateIssues(
          { platform: "github", fullName: repo.full_name },
          repo.trigger_label,
        );
        for (const issue of issues) {
          await this.enqueueIssue(repo, issue);
        }
      } catch (err) {
        console.error(`[poll] ${repo.full_name}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const candidates = this.store.dequeueCandidates(10);
      for (const task of candidates) {
        await this.dispatch(task);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async dispatch(task: TaskRow): Promise<void> {
    const repo = this.store.getRepo(task.repo_id);
    if (!repo) return;

    if (this.store.countActiveByRepo(repo.id) >= repo.max_concurrency) return;
    if (this.store.countActiveInstances() >= this.config.scheduler.globalMaxInstances) {
      // may still reuse idle instance for this repo
      const idle = this.store.findIdleInstance(repo.id);
      if (!idle) return;
    }

    this.store.updateTask(task.id, { status: "preparing" });
    this.hub({ type: "task.updated", payload: this.store.getTask(task.id) });

    let instance: ReturnType<PlatformStore["getInstance"]>;
    try {
      const clonePath = await this.repos.ensureRepo(
        repo.full_name,
        repo.clone_path,
        repo.github_token ?? this.config.github.token,
      );
      if (repo.clone_path !== clonePath) {
        this.store.updateRepo(repo.id, { clone_path: clonePath });
      }

      instance = this.store.findIdleInstance(repo.id);
      let handle = instance ? this.live.get(instance.id) : undefined;

      if (!instance || !handle || (await this.launcher.probe(handle)) === "dead") {
        if (handle) {
          await this.launcher.terminate(handle).catch(() => undefined);
          if (instance) this.store.updateInstance(instance.id, { status: "dead" });
        }
        handle = await this.launcher.launch({
          repoPath: clonePath,
          token: randomUUID().replace(/-/g, "").slice(0, 24),
        });
        const now = new Date().toISOString();
        this.store.insertInstance({
          id: handle.id,
          launcher: "local-process",
          repo_id: repo.id,
          endpoint: handle.endpoint,
          token: handle.token ?? null,
          pid: handle.pid,
          status: "busy",
          started_at: now,
          last_seen_at: now,
        });
        this.live.set(handle.id, handle);
        instance = this.store.getInstance(handle.id)!;
        this.sync.watchInstance(instance.id);
      } else {
        this.store.updateInstance(instance.id, {
          status: "busy",
          last_seen_at: new Date().toISOString(),
        });
      }

      const client = new KernelClient(instance.endpoint, instance.token);
      const created = await client.createTask({
        requirement: task.requirement,
        repoPath: clonePath,
        pipeline: task.pipeline_name ?? undefined,
        configOverrides: { autoApproveGates: false },
      });

      this.store.updateTask(task.id, {
        status: "running",
        instance_id: instance.id,
        kernel_task_id: created.taskId,
        branch: created.branch,
      });
      this.hub({ type: "task.updated", payload: this.store.getTask(task.id) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const bound = this.store.getTask(task.id);
      this.store.updateTask(task.id, { status: "failed", error: message });
      // Free instance even if createTask failed before binding instance_id on the task.
      this.sync.releaseInstance(bound?.instance_id ?? instance?.id);
      this.hub({ type: "task.updated", payload: this.store.getTask(task.id) });
    }
  }

  getLiveHandle(instanceId: string): InstanceHandle | undefined {
    return this.live.get(instanceId);
  }

  registerLive(handle: InstanceHandle): void {
    this.live.set(handle.id, handle);
  }

  async terminateInstance(instanceId: string): Promise<void> {
    const handle = this.live.get(instanceId);
    if (handle) {
      await this.launcher.terminate(handle);
      this.live.delete(instanceId);
    }
    this.store.updateInstance(instanceId, { status: "dead" });
  }

  adapterFor(repo: RepoRow): GitHubAdapter | null {
    const token = repo.github_token ?? this.config.github.token;
    if (!token) return null;
    return new GitHubAdapter(token);
  }

  async handleWebhook(
    headers: Record<string, string>,
    body: unknown,
    rawBody?: Buffer,
  ): Promise<void> {
    // Find matching repo from payload
    const fullName =
      (body as { repository?: { full_name?: string } })?.repository?.full_name ?? "";
    const repo = this.store.getRepoByFullName("github", fullName);
    if (!repo) return;
    const adapter = this.adapterFor(repo);
    if (!adapter) return;

    const event = await adapter.handleWebhook(headers, body, {
      triggerLabel: repo.trigger_label,
      webhookSecret: this.config.github.webhookSecret,
      rawBody,
    });
    if (!event) return;

    if (event.kind === "issue_labeled") {
      await this.enqueueIssue(repo, event.issue);
      return;
    }

    if (event.kind === "codeloop_command") {
      const task = this.store.findOpenTaskByIssue(repo.id, event.issueNumber);
      if (!task?.kernel_task_id || !task.instance_id) return;
      const inst = this.store.getInstance(task.instance_id);
      if (!inst) return;
      const client = new KernelClient(inst.endpoint, inst.token);
      const { command, args } = event;
      if (command === "approve") {
        const snap = (await client.getTask(task.kernel_task_id)) as {
          pendingIntervention?: { requestId: string };
        };
        const reqId = snap.pendingIntervention?.requestId;
        if (reqId) {
          await client.resolveIntervention(task.kernel_task_id, reqId, { action: "approve" });
          this.store.insertIntervention({
            id: randomUUID(),
            task_id: task.id,
            request_id: reqId,
            kind: "gate",
            decision: JSON.stringify({ action: "approve" }),
            decided_by: event.user,
            channel: "platform-comment",
            created_at: new Date().toISOString(),
            decided_at: new Date().toISOString(),
          });
        }
      } else if (command === "reject") {
        const snap = (await client.getTask(task.kernel_task_id)) as {
          pendingIntervention?: { requestId: string };
        };
        const reqId = snap.pendingIntervention?.requestId;
        if (reqId) {
          await client.resolveIntervention(task.kernel_task_id, reqId, {
            action: "reject",
            comments: [
              {
                id: "gh-reject",
                severity: "major",
                comment: args || "Rejected via GitHub comment",
                status: "open",
              },
            ],
          });
        }
      } else if (command === "inject") {
        await client.inject(task.kernel_task_id, args);
      } else if (command === "abort") {
        await client.abort(task.kernel_task_id);
        this.store.updateTask(task.id, { status: "cancelled" });
        this.sync.releaseInstance(task.instance_id);
      } else if (command === "resume") {
        await client.resume(task.kernel_task_id, args || undefined);
      }
    }
  }
}
