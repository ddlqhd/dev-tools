import { randomUUID } from "node:crypto";
import { access, readdir, readFile, rm, stat, symlink, writeFile, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  ArtifactFile,
  InterventionDecision,
  InterventionRequest,
  KernelEvent,
  LoopStackEntry,
  NodeSpec,
  TaskPaths,
} from "@devtools/shared";
import {
  getMissingEngineConfigs,
  loadConfig,
  ensureCodeloopDir,
  type CodeloopConfig,
} from "../config.js";
import {
  loadPipeline,
  snapshotPipeline,
  parsePipelineYaml,
  type LoadedPipeline,
} from "../pipeline/load.js";
import {
  createInplaceWorktree,
  createTaskWorktree,
  openExistingWorktree,
  removeTaskWorktree,
  snapshotWorkingTreeInto,
  workingTreeDirty,
  type GitWorktree,
} from "../git/worktree.js";
import { ArtifactStore, EventLog, KernelStore, type TaskRow } from "../store/index.js";
import {
  PipelineInterpreter,
  type AbortIntent,
  type ResumeState,
} from "../loop/interpreter.js";
import type { RuntimeConfigView } from "../loop/node.js";

export interface CreateTaskOptions {
  requirement: string;
  repoPath: string;
  pipeline?: string;
  /** Ref the task branch starts from; defaults to repo HEAD. */
  baseBranch?: string;
  /** Reuse this existing branch (e.g. a delivered PR branch) instead of a new one. */
  existingBranch?: string;
  autoApproveGates?: boolean;
  /** Run in the repo checkout instead of a dedicated worktree. */
  inplace?: boolean;
  /** Sandbox write-mode engine turns. */
  sandbox?: boolean;
  onEvent?: (event: KernelEvent) => void;
  /**
   * When true, interventions without a handler park until `applyIntervention`
   * (serve / external control). Default false — throws if nobody can answer.
   */
  parkInterventions?: boolean;
}

export interface ApplyInterventionOptions {
  /** Kick off resume when there is no in-memory waiter (default true). */
  resume?: boolean;
  /** Await full resume run instead of kickoff-only (default false). */
  wait?: boolean;
}

export interface ApplyInterventionResult {
  ok: true;
  mode: "live" | "deferred";
  status?: string;
  error?: string;
}

export interface TaskSnapshotView {
  task: TaskRow;
  pipeline?: { name: string; hash: string; rawYaml?: string };
  checkpoint?: ReturnType<KernelStore["getCheckpoint"]>;
  pendingIntervention?: InterventionRequest | null;
  git?: { head: string; status: string };
  /** Deliverables on disk under `tasks/<id>/artifacts/`. */
  artifacts: ArtifactFile[];
  paths: TaskPaths;
}

type PendingIntervention = {
  request: InterventionRequest;
  resolve: (d: InterventionDecision) => void;
  reject: (err: Error) => void;
};

export class TaskHandle {
  private abortIntent: AbortIntent = "none";
  private ac = new AbortController();
  private interpreter: PipelineInterpreter | null = null;
  private runPromise: Promise<{ status: string; error?: string }> | null = null;
  private pending: PendingIntervention | null = null;
  private deferredDecision: InterventionDecision | null = null;
  private parkInterventions = false;
  private externalInstructions: string[] = [];
  private readonly eventListeners = new Set<(e: KernelEvent) => void>();
  private interventionHandler:
    | ((req: InterventionRequest) => Promise<InterventionDecision>)
    | null = null;

  constructor(
    readonly runtime: KernelRuntime,
    readonly taskId: string,
    readonly events: EventLog,
    private worktree: GitWorktree,
    private artifacts: ArtifactStore,
    private pipeline: LoadedPipeline,
    private requirement: string,
    private runtimeConfig: RuntimeConfigView,
  ) {
    this.events.on((e) => {
      for (const l of this.eventListeners) l(e);
      this.runtime.broadcast(e);
    });
  }

  setParkInterventions(park: boolean): void {
    this.parkInterventions = park;
  }

  onEvent(listener: (e: KernelEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private getAbortIntent = (): AbortIntent => this.abortIntent;

  start(resume?: ResumeState): Promise<{ status: string; error?: string }> {
    if (this.runPromise) {
      throw new Error(`Task ${this.taskId} is already running`);
    }
    this.abortIntent = "none";
    if (this.ac.signal.aborted) {
      this.ac = new AbortController();
    }

    this.interpreter = new PipelineInterpreter({
      taskId: this.taskId,
      requirement: this.requirement,
      pipeline: this.pipeline,
      worktree: this.worktree,
      store: this.runtime.store,
      events: this.events,
      artifacts: this.artifacts,
      config: this.runtimeConfig,
      signal: this.ac.signal,
      getAbortIntent: this.getAbortIntent,
      resume,
      pullInstructions: () => this.externalInstructions.splice(0, this.externalInstructions.length),
      requestIntervention: (req) => this.waitForIntervention(req),
    });

    this.runPromise = this.interpreter.run().finally(async () => {
      await this.events.flush().catch(() => undefined);
      this.runPromise = null;
      this.interpreter = null;
    });

    return this.runPromise;
  }

  setInterventionHandler(
    handler: (req: InterventionRequest) => Promise<InterventionDecision>,
  ): void {
    this.interventionHandler = handler;
  }

  private deferredDecisionPath(): string {
    return join(this.runtime.store.taskDir(this.taskId), "deferred-decision.json");
  }

  private async writeDeferredDecision(decision: InterventionDecision): Promise<void> {
    this.deferredDecision = decision;
    await writeFile(this.deferredDecisionPath(), JSON.stringify(decision), "utf8");
  }

  private async consumeDeferredDecision(): Promise<InterventionDecision | null> {
    if (this.deferredDecision) {
      const d = this.deferredDecision;
      this.deferredDecision = null;
      await unlink(this.deferredDecisionPath()).catch(() => undefined);
      return d;
    }
    try {
      const raw = await readFile(this.deferredDecisionPath(), "utf8");
      await unlink(this.deferredDecisionPath()).catch(() => undefined);
      return JSON.parse(raw) as InterventionDecision;
    } catch {
      return null;
    }
  }

  private async waitForIntervention(req: InterventionRequest): Promise<InterventionDecision> {
    if (this.runtimeConfig.autoApproveGates && req.kind === "gate") {
      return { action: "approve" };
    }
    const waitPromise = this.waitForInterventionParked(req);
    if (!req.timeoutMs || !(req.timeoutMs > 0)) {
      return waitPromise;
    }
    const policy = req.timeoutPolicy ?? "reject";
    const timeoutDecision: InterventionDecision =
      policy === "approve"
        ? { action: "approve", auto: true }
        : {
            action: "reject",
            comments: [
              {
                id: `gate-timeout-${req.requestId.slice(0, 8)}`,
                severity: "major",
                comment: `Gate timed out after ${Math.round(req.timeoutMs / 1000)}s without a decision`,
                status: "open",
              },
            ],
            auto: true,
          };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<InterventionDecision>((resolve) => {
      timer = setTimeout(() => {
        // Drop the parked waiter so a late human resolution fails cleanly
        // instead of feeding a pipeline that has already moved on.
        if (this.pending?.request.requestId === req.requestId) {
          this.pending = null;
          this.runtime.clearIntervention(this.taskId);
          this.clearCheckpointIntervention();
        }
        resolve(timeoutDecision);
      }, req.timeoutMs);
    });

    // If the timer already won, a later pause()/abort() may still reject the
    // parked waiter — absorb that rejection so it can't crash the process.
    waitPromise.catch(() => undefined);
    return Promise.race([waitPromise, timeoutPromise]).finally(() => clearTimeout(timer));
  }

  private async waitForInterventionParked(
    req: InterventionRequest,
  ): Promise<InterventionDecision> {
    const deferred = await this.consumeDeferredDecision();
    if (deferred) return deferred;
    if (this.interventionHandler) {
      return this.interventionHandler(req);
    }
    if (!this.parkInterventions) {
      throw new Error(
        `Intervention required (${req.kind}) but no handler provided: ${req.summary}`,
      );
    }
    // A pause/abort racing the request must not leave a waiter nobody can answer:
    // check the intent before parking so pause()/abort() can never strand the task.
    if (this.abortIntent !== "none" || this.ac.signal.aborted) {
      throw new Error(this.abortIntent === "pause" ? "paused" : "aborted");
    }
    return new Promise<InterventionDecision>((resolve, reject) => {
      this.pending = { request: req, resolve, reject };
      this.runtime.noteIntervention(this.taskId, req);
    });
  }

  /** Live-only resolve; prefer `applyIntervention` for API / CLI. */
  resolveIntervention(decision: InterventionDecision): void {
    if (!this.pending) {
      throw new Error(`No pending intervention for task ${this.taskId}`);
    }
    const { resolve } = this.pending;
    this.pending = null;
    this.runtime.clearIntervention(this.taskId);
    resolve(decision);
  }

  /**
   * Resolve a pending intervention. If the in-process waiter is gone (daemon
   * restart / offline CLI), persist the decision and resume so the gate re-runs.
   */
  async applyIntervention(
    requestId: string,
    decision: InterventionDecision,
    opts: ApplyInterventionOptions = {},
  ): Promise<ApplyInterventionResult> {
    const shouldResume = opts.resume !== false;
    const wait = opts.wait === true;

    if (this.pending) {
      if (this.pending.request.requestId !== requestId) {
        throw new Error(
          `Intervention mismatch: pending=${this.pending.request.requestId}, got=${requestId}`,
        );
      }
      this.resolveIntervention(decision);
      return { ok: true, mode: "live" };
    }

    const checkpointPending =
      this.readCheckpointIntervention() ?? (await this.events.findUnresolvedIntervention());
    if (!checkpointPending || checkpointPending.requestId !== requestId) {
      throw new Error(`No pending intervention ${requestId} for task ${this.taskId}`);
    }

    await this.writeDeferredDecision(decision);
    this.clearCheckpointIntervention();
    this.runtime.clearIntervention(this.taskId);

    if (shouldResume && !this.runPromise) {
      if (wait) {
        const result = await this.resume();
        return {
          ok: true,
          mode: "deferred",
          status: result.status,
          error: result.error,
        };
      }
      await this.kickoffResume();
      return { ok: true, mode: "deferred", status: "running" };
    }

    return { ok: true, mode: "deferred" };
  }

  private readCheckpointIntervention(): InterventionRequest | null {
    const cp = this.runtime.store.getCheckpoint(this.taskId);
    if (!cp?.pending_intervention) return null;
    try {
      return JSON.parse(cp.pending_intervention) as InterventionRequest;
    } catch {
      return null;
    }
  }

  private clearCheckpointIntervention(): void {
    const cp = this.runtime.store.getCheckpoint(this.taskId);
    if (!cp) return;
    this.runtime.store.saveCheckpoint({
      ...cp,
      pending_intervention: null,
      updated_at: new Date().toISOString(),
    });
  }

  getPendingIntervention(): InterventionRequest | null {
    return this.pending?.request ?? this.readCheckpointIntervention();
  }

  async inject(text: string): Promise<void> {
    this.externalInstructions.push(text);
    this.interpreter?.injectInstruction(text);
    await this.events.emit("instruction.injected", { text, by: "operator" });
  }

  async pause(): Promise<void> {
    const task = this.runtime.store.getTask(this.taskId);
    if (!task) throw new Error(`Task not found: ${this.taskId}`);
    // "suspended" may mean either "paused by operator" or "awaiting an
    // intervention" (the interpreter marks it suspended before asking). The
    // latter must still be interruptible, or pause() would silently no-op and
    // strand the task with an unanswered waiter.
    const awaitingIntervention =
      this.pending !== null || this.readCheckpointIntervention() !== null;
    if (task.status === "suspended" && !awaitingIntervention) return;
    if (task.status !== "running" && !awaitingIntervention) {
      throw new Error(`Cannot pause task in status ${task.status}`);
    }
    this.abortIntent = "pause";
    if (this.pending) {
      const { reject } = this.pending;
      this.pending = null;
      this.runtime.clearIntervention(this.taskId);
      this.clearCheckpointIntervention();
      reject(new Error("paused"));
    }
    this.ac.abort();
    if (this.runPromise) await this.runPromise.catch(() => undefined);
  }

  async abort(): Promise<void> {
    this.abortIntent = "abort";
    if (this.pending) {
      const { reject } = this.pending;
      this.pending = null;
      this.runtime.clearIntervention(this.taskId);
      this.clearCheckpointIntervention();
      reject(new Error("aborted"));
    }
    this.ac.abort();
    if (this.runPromise) await this.runPromise.catch(() => undefined);
    this.runtime.store.updateTask(this.taskId, { status: "aborted" });
  }

  /** Validate + start resume without awaiting completion. */
  async kickoffResume(instruction?: string): Promise<void> {
    const task = this.runtime.store.getTask(this.taskId);
    if (!task) throw new Error(`Task not found: ${this.taskId}`);
    // "running" allowed when no in-process runner (daemon crash recovery)
    const resumable =
      task.status === "suspended" ||
      task.status === "failed" ||
      (task.status === "running" && !this.runPromise);
    if (!resumable) {
      throw new Error(`Cannot resume task in status ${task.status}`);
    }
    if (this.runPromise) throw new Error("Task already running");

    if (instruction) await this.inject(instruction);

    const cp = this.runtime.store.getCheckpoint(this.taskId);
    if (!cp) throw new Error(`No checkpoint for task ${this.taskId}`);

    try {
      await this.worktree.resetHard(cp.head_commit);
    } catch {
      // continue
    }

    const flowCursor = JSON.parse(cp.flow_cursor || '{"flowIndex":0}') as { flowIndex: number };
    const loopStack = JSON.parse(cp.loop_stack || "[]") as LoopStackEntry[];
    const nodeOutcomes = JSON.parse(cp.node_outcomes || "{}") as Record<
      string,
      Record<string, unknown>
    >;
    const instructions = JSON.parse(cp.instructions || "[]") as string[];

    this.start({
      flowIndex: flowCursor.flowIndex ?? 0,
      loopStack,
      nodeOutcomes,
      resumeNodeId: cp.node_id,
      instructions: [...instructions, ...this.externalInstructions.splice(0)],
    });
  }

  async resume(instruction?: string): Promise<{ status: string; error?: string }> {
    await this.kickoffResume(instruction);
    return this.runPromise!;
  }

  isRunning(): boolean {
    return this.runPromise !== null;
  }

  async wait(): Promise<{ status: string; error?: string }> {
    if (this.runPromise) return this.runPromise;
    const task = this.runtime.store.getTask(this.taskId);
    return { status: task?.status ?? "unknown" };
  }

  getWorktreePath(): string {
    return this.worktree.worktreePath;
  }

  getBranch(): string {
    return this.worktree.branch;
  }
}

export class KernelRuntime {
  readonly store: KernelStore;
  readonly repoPath: string;
  readonly codeloopRoot: string;
  /** When true, new/attached handles park interventions for external resolve (serve). */
  parkInterventionsByDefault = false;
  private readonly handles = new Map<string, TaskHandle>();
  private readonly globalListeners = new Set<(e: KernelEvent) => void>();
  private readonly interventions = new Map<string, InterventionRequest>();

  private constructor(repoPath: string, codeloopRoot: string, store: KernelStore) {
    this.repoPath = repoPath;
    this.codeloopRoot = codeloopRoot;
    this.store = store;
  }

  static async open(repoPath: string): Promise<KernelRuntime> {
    const root = await ensureCodeloopDir(repoPath);
    return new KernelRuntime(repoPath, root, new KernelStore(root));
  }

  /** Write any in-memory thinking/text buffers so a shutdown does not drop them. */
  async flushEventLogs(): Promise<void> {
    await Promise.all([...this.handles.values()].map((handle) => handle.events.flush()));
  }

  close(): void {
    this.store.close();
  }

  onEvent(listener: (e: KernelEvent) => void): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  broadcast(event: KernelEvent): void {
    for (const l of this.globalListeners) l(event);
  }

  noteIntervention(taskId: string, req: InterventionRequest): void {
    this.interventions.set(taskId, req);
  }

  clearIntervention(taskId: string): void {
    this.interventions.delete(taskId);
  }

  getHandle(taskId: string): TaskHandle | undefined {
    return this.handles.get(taskId);
  }

  listTasks(): TaskRow[] {
    return this.store.listTasks();
  }

  /**
   * Permanently remove a task: abort if running, drop worktree/branch (when
   * self-created), clear `.codeloop/tasks/<id>`, and delete DB rows.
   */
  async deleteTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) return;

    const handle = this.handles.get(taskId);
    if (handle) {
      await handle.abort().catch(() => {});
      this.handles.delete(taskId);
      this.clearIntervention(taskId);
    }

    const config = await loadConfig(task.repo_path);
    await removeTaskWorktree({
      repoPath: task.repo_path,
      worktreePath: task.worktree_path,
      branch: task.branch,
      branchPrefix: config.git.branchPrefix,
      taskId,
    });

    await rm(this.store.taskDir(taskId), { recursive: true, force: true });
    this.store.deleteTask(taskId);
  }

  /** An unfinished task whose working tree is the repo checkout itself. */
  private findActiveInplaceTask(repoPath: string): TaskRow | undefined {
    const unfinished = new Set(["created", "running", "suspended"]);
    return this.store
      .listTasks()
      .find(
        (t) =>
          t.repo_path === repoPath &&
          t.worktree_path === repoPath &&
          unfinished.has(t.status),
      );
  }

  async createTask(opts: CreateTaskOptions): Promise<TaskHandle> {
    const config = await loadConfig(opts.repoPath);
    if (opts.autoApproveGates !== undefined) {
      config.autoApproveGates = opts.autoApproveGates;
    }
    if (opts.inplace !== undefined) {
      config.inplace = opts.inplace;
    }
    if (opts.sandbox !== undefined) {
      config.sandbox = opts.sandbox;
    }

    const pipelineName = opts.pipeline ?? config.pipeline;
    let pipeline = await loadPipeline(pipelineName, opts.repoPath);
    pipeline = applyPipelineOverrides(pipeline, config.pipelineOverrides);
    const missingEngines = getMissingEngineConfigs(pipeline.nodes, config.engines);
    if (missingEngines.length > 0) {
      const known = Object.keys(config.engines).join(", ") || "(none)";
      throw new Error(
        `Missing engine config for: ${missingEngines.join(", ")}. Known engines: ${known}. ` +
          `Add them under engines in .codeloop/config.yaml.`,
      );
    }

    // ci-fix-style tasks must run on their own worktree: inplace mode would
    // silently drop the existingBranch and commit onto the repo checkout.
    // review-only on a dirty checkout also isolates: review needs those files
    // snapshotted into a linked worktree (inplace resetHard is a no-op).
    const reviewSnapshot = pipelineReviewsWorkingTree(pipeline);
    const isolateDirtyReview =
      reviewSnapshot && !opts.existingBranch && (await workingTreeDirty(opts.repoPath));
    const useInplace = config.inplace && !opts.existingBranch && !isolateDirtyReview;
    if (useInplace) {
      const active = this.findActiveInplaceTask(opts.repoPath);
      if (active) {
        throw new Error(
          `Task ${active.id} is already running inplace in ${opts.repoPath} (status ${active.status}). ` +
            `Finish or abort it before starting another inplace task.`,
        );
      }
    }

    const taskId = randomUUID().slice(0, 8);
    const dirs = await this.store.ensureTaskDirs(taskId);
    await snapshotPipeline(pipeline, dirs.taskDir);

    let worktree: GitWorktree;
    if (useInplace) {
      worktree = await createInplaceWorktree(opts.repoPath);
    } else {
      const worktreeRoot = join(opts.repoPath, config.git.worktreeRoot);
      worktree = await createTaskWorktree({
        repoPath: opts.repoPath,
        worktreeRoot,
        branchPrefix: config.git.branchPrefix,
        taskId,
        baseRef: opts.baseBranch,
        existingBranch: opts.existingBranch,
      });
      if (reviewSnapshot) {
        await snapshotWorkingTreeInto(opts.repoPath, worktree);
      }
      // Link after snapshot so the absolute node_modules symlink cannot be staged.
      await linkRepoNodeModules(opts.repoPath, worktree.worktreePath);
    }

    const now = new Date().toISOString();
    this.store.insertTask({
      id: taskId,
      requirement: opts.requirement,
      repo_path: opts.repoPath,
      worktree_path: worktree.worktreePath,
      branch: worktree.branch,
      base_commit: worktree.baseCommit,
      pipeline_name: pipeline.name,
      pipeline_hash: pipeline.hash,
      status: "created",
      current_node: null,
      loop_state: null,
      error: null,
      created_at: now,
      updated_at: now,
    });

    const events = await EventLog.open(taskId, dirs.taskDir);
    if (opts.onEvent) events.on(opts.onEvent);

    await events.emit("task.created", {
      requirement: opts.requirement,
      pipeline: { name: pipeline.name, hash: pipeline.hash },
      repoPath: opts.repoPath,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      inplace: useInplace,
    });

    const handle = new TaskHandle(
      this,
      taskId,
      events,
      worktree,
      new ArtifactStore(dirs.artifactsDir),
      pipeline,
      opts.requirement,
      toRuntimeConfig(config),
    );
    if (opts.parkInterventions ?? this.parkInterventionsByDefault) {
      handle.setParkInterventions(true);
    }
    this.handles.set(taskId, handle);
    return handle;
  }

  async attachTask(taskId: string): Promise<TaskHandle> {
    const existing = this.handles.get(taskId);
    if (existing) {
      if (this.parkInterventionsByDefault) existing.setParkInterventions(true);
      return existing;
    }

    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const config = await loadConfig(task.repo_path);
    const rawYaml = await readFile(
      join(this.store.taskDir(taskId), "pipeline.snapshot.yaml"),
      "utf8",
    );
    const pipeline = parsePipelineYaml(rawYaml);
    const worktree = await openExistingWorktree(
      task.repo_path,
      task.worktree_path,
      task.branch,
      task.base_commit || "HEAD",
    );
    const dirs = await this.store.ensureTaskDirs(taskId);
    const events = await EventLog.open(taskId, dirs.taskDir);

    const handle = new TaskHandle(
      this,
      taskId,
      events,
      worktree,
      new ArtifactStore(dirs.artifactsDir),
      pipeline,
      task.requirement,
      toRuntimeConfig(config),
    );
    if (this.parkInterventionsByDefault) handle.setParkInterventions(true);
    this.handles.set(taskId, handle);
    return handle;
  }

  async getSnapshot(taskId: string): Promise<TaskSnapshotView> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const checkpoint = this.store.getCheckpoint(taskId);

    let pendingIntervention: InterventionRequest | null =
      this.interventions.get(taskId) ??
      this.handles.get(taskId)?.getPendingIntervention() ??
      null;
    if (!pendingIntervention && checkpoint?.pending_intervention) {
      try {
        pendingIntervention = JSON.parse(checkpoint.pending_intervention) as InterventionRequest;
      } catch {
        pendingIntervention = null;
      }
    }
    if (!pendingIntervention && task.status === "suspended") {
      const log = new EventLog(taskId, this.store.taskDir(taskId));
      pendingIntervention = await log.findUnresolvedIntervention();
    }

    let git: TaskSnapshotView["git"];
    try {
      const wt = await openExistingWorktree(
        task.repo_path,
        task.worktree_path,
        task.branch,
        task.base_commit || "HEAD",
      );
      git = { head: await wt.head(), status: await wt.statusPorcelain() };
    } catch {
      git = undefined;
    }

    let pipeline: TaskSnapshotView["pipeline"];
    try {
      const rawYaml = await readFile(
        join(this.store.taskDir(taskId), "pipeline.snapshot.yaml"),
        "utf8",
      );
      pipeline = { name: task.pipeline_name, hash: task.pipeline_hash, rawYaml };
    } catch {
      pipeline = { name: task.pipeline_name, hash: task.pipeline_hash };
    }

    const artifacts = await this.listArtifacts(taskId);
    const taskDir = this.store.taskDir(taskId);
    const paths: TaskPaths = {
      taskDir,
      artifactsDir: join(taskDir, "artifacts"),
      eventsPath: join(taskDir, "events.jsonl"),
      worktreePath: task.worktree_path,
      pipelineSnapshot: join(taskDir, "pipeline.snapshot.yaml"),
    };

    return { task, pipeline, checkpoint, pendingIntervention, git, artifacts, paths };
  }

  async listArtifacts(taskId: string): Promise<ArtifactFile[]> {
    const dir = join(this.store.taskDir(taskId), "artifacts");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const files: ArtifactFile[] = [];
    for (const name of names.sort()) {
      const ext = extname(name).replace(/^\./, "");
      if (!ext) continue;
      try {
        const info = await stat(join(dir, name));
        if (!info.isFile()) continue;
        files.push({
          key: name.slice(0, name.length - ext.length - 1),
          ext,
          size: info.size,
          mtime: info.mtime.toISOString(),
          path: join(dir, name),
        });
      } catch {
        // disappeared mid-listing
      }
    }
    return files;
  }
}

function pipelineReviewsWorkingTree(pipeline: LoadedPipeline): boolean {
  const nodes = Object.values(pipeline.nodes);
  return nodes.length > 0 && nodes.every((n) => n.type === "review");
}

function toRuntimeConfig(config: CodeloopConfig): RuntimeConfigView {
  return {
    autoApproveGates: config.autoApproveGates,
    skipVerifyIfMissing: config.skipVerifyIfMissing,
    sandbox: config.sandbox,
    budget: config.budget,
    engines: config.engines,
  };
}

export function applyPipelineOverrides(
  pipeline: LoadedPipeline,
  overrides: CodeloopConfig["pipelineOverrides"],
): LoadedPipeline {
  if (!overrides) return pipeline;
  for (const [nodeId, patch] of Object.entries(overrides)) {
    const node = pipeline.nodes[nodeId];
    if (!node || !patch || typeof patch !== "object") continue;
    pipeline.nodes[nodeId] = { ...node, ...(patch as Partial<NodeSpec>) };
  }
  for (const step of pipeline.flow) {
    if (step.kind !== "node") continue;
    const nodeOnFail = pipeline.nodes[step.nodeId]?.onFail;
    if (nodeOnFail) step.onFail = nodeOnFail;
  }
  return pipeline;
}

async function linkRepoNodeModules(repoPath: string, worktreePath: string): Promise<void> {
  const src = join(repoPath, "node_modules");
  const dest = join(worktreePath, "node_modules");
  try {
    await access(src);
  } catch {
    return;
  }
  try {
    await access(dest);
    return;
  } catch {
    // missing
  }
  try {
    await symlink(src, dest, "dir");
  } catch {
    // ignore
  }
}
