import WebSocket from "ws";
import { platformStatusAfterSuspended, type KernelEvent, type ProgressReport } from "@devtools/shared";
import type { PlatformConfig } from "./config.js";
import type { PlatformStore } from "./db/store.js";
import { GitHubAdapter } from "./github/adapter.js";
import { KernelClient } from "./kernel-client.js";
import type { RepoManager } from "./repo-manager.js";
import type { HubEmit } from "./scheduler.js";

export class EventSync {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly lastProgressAt = new Map<string, number>();
  private readonly delivering = new Set<string>();

  constructor(
    private readonly store: PlatformStore,
    private readonly config: PlatformConfig,
    private readonly repos: RepoManager,
    private readonly hub: HubEmit,
    private readonly getToken: (repoId: string) => string | undefined,
  ) {}

  watchInstance(instanceId: string): void {
    if (this.sockets.has(instanceId)) return;
    const inst = this.store.getInstance(instanceId);
    if (!inst) return;

    const url = new URL(inst.endpoint);
    const tokenQ = inst.token ? `?token=${encodeURIComponent(inst.token)}&verbose=false` : "?verbose=false";
    const wsUrl = `ws://${url.host}/stream${tokenQ}`;

    const ws = new WebSocket(wsUrl);
    this.sockets.set(instanceId, ws);

    ws.on("open", () => {
      for (const task of this.store.listTasks()) {
        if (
          task.instance_id === instanceId &&
          ["preparing", "running", "waiting_human", "paused", "delivering"].includes(task.status)
        ) {
          void this.catchUp(instanceId, task.id);
        }
      }
    });

    ws.on("message", (data) => {
      try {
        const event = JSON.parse(String(data)) as KernelEvent;
        void this.ingest(instanceId, event);
      } catch {
        // ignore
      }
    });

    ws.on("close", () => {
      this.sockets.delete(instanceId);
      // reconnect if still busy/idle
      const current = this.store.getInstance(instanceId);
      if (current && (current.status === "busy" || current.status === "idle")) {
        setTimeout(() => this.watchInstance(instanceId), 2000);
      }
    });

    ws.on("error", () => {
      // close handler will reconnect
    });

    this.store.updateInstance(instanceId, { last_seen_at: new Date().toISOString() });
  }

  /**
   * Terminal-fail a task, or requeue it with exponential backoff while the
   * retry budget allows. Dispatch/pre-start failures (no kernel task yet) and
   * clearly-permanent errors skip the queue.
   */
  handleTaskFailure(taskId: string, message: string): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    // Never started: spawn / createTask errors are not transient.
    const neverStarted = task.kernel_task_id == null;
    // Only clearly-permanent errors skip the queue; transient lookalikes are
    // better absorbed by the retry budget (bounded) than lost forever.
    const nonRetryable =
      neverStarted ||
      /budget exceeded|invalid duration|missing engine config|requirement required/i.test(
        message,
      );
    const count = task.retry_count ?? 0;
    const { maxRetries, baseDelayMs } = this.config.scheduler.retry;

    if (!nonRetryable && count < maxRetries) {
      const delayMs = baseDelayMs * Math.pow(5, count);
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      this.store.updateTask(taskId, {
        status: "queued",
        error: `${message} — auto retry ${count + 1}/${maxRetries} at ${nextRetryAt}`,
        retry_count: count + 1,
        next_retry_at: nextRetryAt,
        instance_id: null,
        kernel_task_id: null,
        // ci-fix must keep running against the PR branch; fresh tasks get a
        // new branch from the kernel (the old one may still be checked out).
        branch: task.source === "ci-fix" ? task.branch : null,
      });
      return;
    }

    this.store.updateTask(taskId, {
      status: "failed",
      error: message,
      next_retry_at: null,
    });
  }

  /** Mark kernel instance idle when no other task is still bound to it. */
  releaseInstance(instanceId: string | null | undefined): void {
    if (!instanceId) return;
    const inst = this.store.getInstance(instanceId);
    if (!inst) return;
    if (this.store.countActiveTasksOnInstance(instanceId) > 0) return;
    if (inst.status === "busy" || inst.status === "starting") {
      this.store.updateInstance(instanceId, {
        status: "idle",
        last_seen_at: new Date().toISOString(),
      });
      this.hub({ type: "instance.updated", payload: this.store.getInstance(instanceId) });
    }
  }

  stopAll(): void {
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
  }

  private async ingest(instanceId: string, event: KernelEvent): Promise<void> {
    this.store.updateInstance(instanceId, { last_seen_at: new Date().toISOString() });

    const task = this.store.getTaskByKernelId(event.taskId);
    if (!task) return;

    const inserted = this.store.insertEvent({
      task_id: task.id,
      seq: event.seq,
      ts: event.ts,
      type: event.type,
      payload: JSON.stringify(event.payload),
    });
    if (!inserted) return;

    const payload = event.payload as Record<string, unknown>;

    if (event.type === "node.started") {
      this.store.updateTask(task.id, { current_node: String(payload.nodeId ?? "") });
      if (task.status === "waiting_human" || task.status === "paused") {
        this.store.updateTask(task.id, { status: "running" });
      }
    }

    if (event.type === "loop.iteration") {
      const prev = task.loop_state ? (JSON.parse(task.loop_state) as Record<string, number>) : {};
      prev[String(payload.loopId)] = Number(payload.iteration);
      this.store.updateTask(task.id, { loop_state: JSON.stringify(prev) });
    }

    if (event.type === "intervention.required") {
      this.store.updateTask(task.id, { status: "waiting_human" });
      this.hub({
        type: "intervention.required",
        payload: { taskId: task.id, ...payload },
      });
      await this.reportProgress(task.id, true);
    }

    if (event.type === "intervention.resolved" || event.type === "task.resumed") {
      this.store.updateTask(task.id, { status: "running", error: null });
    }

    if (event.type === "task.suspended") {
      this.store.updateTask(task.id, {
        status: platformStatusAfterSuspended(String(payload.reason ?? "")),
      });
    }

    if (event.type === "task.completed") {
      await this.deliver(task.id);
    }

    if (event.type === "task.failed") {
      this.handleTaskFailure(task.id, String(payload.error ?? "failed"));
      this.releaseInstance(task.instance_id);
      await this.reportProgress(task.id, true);
    }

    if (event.type === "task.aborted") {
      this.store.updateTask(task.id, { status: "cancelled" });
      this.releaseInstance(task.instance_id);
    }

    if (event.type === "engine.turn.completed") {
      const usage = payload.usage as
        | { inputTokens?: number; outputTokens?: number; costUsd?: number }
        | undefined;
      if (usage) {
        this.store.insertUsage({
          task_id: task.id,
          stage: String(payload.nodeId ?? "unknown"),
          engine_type: String(payload.engineType ?? "cursor"),
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          cost_usd: usage.costUsd ?? null,
          ts: event.ts,
        });
      }
    }

    this.hub({ type: "task.event", payload: { taskId: task.id, event } });
    const updated = this.store.getTask(task.id);
    this.hub({ type: "task.updated", payload: updated });

    // Throttled progress for non-urgent events
    if (
      event.type === "node.completed" ||
      event.type === "task.started" ||
      event.type === "review.completed"
    ) {
      await this.reportProgress(task.id, false);
    }
  }

  private async reportProgress(taskId: string, force: boolean): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task?.issue_number) return;
    const repo = this.store.getRepo(task.repo_id);
    if (!repo || repo.platform !== "github") return;
    const token = this.getToken(repo.id);
    if (!token) return;

    const last = this.lastProgressAt.get(taskId) ?? 0;
    if (!force && Date.now() - last < 30_000) return;
    this.lastProgressAt.set(taskId, Date.now());

    const adapter = new GitHubAdapter(token);
    const consoleUrl = `${this.config.consoleBaseUrl ?? `http://${this.config.listen.host}:${this.config.listen.port}`}/tasks/${task.id}`;
    const report: ProgressReport = {
      summary: `Task \`${task.id}\` · ${task.status}`,
      status: task.status,
      currentNode: task.current_node ?? undefined,
      branch: task.branch ?? undefined,
      consoleUrl,
    };
    try {
      await adapter.postProgress(
        { repo: { platform: "github", fullName: repo.full_name }, number: task.issue_number },
        report,
      );
    } catch (err) {
      console.error(`[progress] ${task.id}:`, err instanceof Error ? err.message : err);
    }
  }

  private async deliver(taskId: string): Promise<void> {
    if (this.delivering.has(taskId)) return;
    this.delivering.add(taskId);
    try {
      this.store.updateTask(taskId, { status: "delivering" });
      const task = this.store.getTask(taskId)!;
      const repo = this.store.getRepo(task.repo_id)!;
      const token = this.getToken(repo.id);

      // Push/PR only when we have a platform token (local manual tasks keep the branch in place).
      if (task.branch && token) {
        try {
          await this.repos.pushBranch(repo.clone_path, task.branch, token);
        } catch (err) {
          this.handleTaskFailure(
            taskId,
            `push failed: ${err instanceof Error ? err.message : err}`,
          );
          this.releaseInstance(task.instance_id);
          this.hub({ type: "task.updated", payload: this.store.getTask(taskId) });
          return;
        }
      }

      // ci-fix pushes onto the existing PR branch — the PR updates itself; no new PR.
      if (task.issue_number && token && task.branch && task.source !== "ci-fix") {
        try {
          const adapter = new GitHubAdapter(token);
          const base = repo.default_branch || this.config.defaultBaseBranch;
          const pr = await adapter.createPullRequest({
            repo: { platform: "github", fullName: repo.full_name },
            title: task.title,
            body: [
              `Automated by codeloop.`,
              "",
              task.requirement.slice(0, 2000),
              "",
              `Closes #${task.issue_number}`,
            ].join("\n"),
            head: task.branch,
            base,
            issueNumber: task.issue_number,
          });
          this.store.updateTask(taskId, { pr_number: pr.number, status: "done" });
          await this.reportProgress(taskId, true);
        } catch (err) {
          this.handleTaskFailure(
            taskId,
            `PR failed: ${err instanceof Error ? err.message : err}`,
          );
          this.releaseInstance(task.instance_id);
          this.hub({ type: "task.updated", payload: this.store.getTask(taskId) });
          return;
        }
      } else {
        if (token && task.source === "ci-fix") {
          const parent = task.parent_task_id
            ? this.store.getTask(task.parent_task_id)
            : undefined;
          if (parent?.issue_number) {
            try {
              await new GitHubAdapter(token).postProgress(
                {
                  repo: { platform: "github", fullName: repo.full_name },
                  number: parent.issue_number,
                },
                {
                  summary: `CI fix pushed to \`${task.branch}\` by task \`${task.id}\` — waiting for checks.`,
                  status: "running",
                  branch: task.branch ?? undefined,
                },
              );
            } catch {
              // best effort
            }
          }
        }
        this.store.updateTask(taskId, { status: "done" });
      }

      this.releaseInstance(task.instance_id);
      this.hub({ type: "task.updated", payload: this.store.getTask(taskId) });
    } finally {
      this.delivering.delete(taskId);
    }
  }

  /** Catch-up historical events after reconnect. */
  async catchUp(instanceId: string, taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    const inst = this.store.getInstance(instanceId);
    if (!task?.kernel_task_id || !inst) return;
    const client = new KernelClient(inst.endpoint, inst.token);
    const after = this.store.lastEventSeq(task.id);
    const events = await client.events(task.kernel_task_id, after);
    for (const e of events) {
      await this.ingest(instanceId, e);
    }
  }
}
