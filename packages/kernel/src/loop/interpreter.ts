import {
  resolveNodeEngineKey,
  type FlowStep,
  type InterventionDecision,
  type InterventionRequest,
  type LoopStackEntry,
  type NodeSpec,
  type ReviewComment,
} from "@devtools/shared";
import { SuspendedError, type EngineAdapter, type EngineSession } from "../engines/adapter.js";
import { getEngineAdapter, resolveEngineType } from "../engines/registry.js";
import type { ArtifactStore, CheckpointRow, EventLog, KernelStore } from "../store/index.js";
import type { GitWorktree } from "../git/worktree.js";
import { evaluateExpression } from "./expressions.js";
import type { NodeContext, NodeRunner, RuntimeConfigView, TaskSnapshot } from "./node.js";
import { AgentNodeRunner } from "./runners/agent.js";
import { ReviewNodeRunner } from "./runners/review.js";
import { GateNodeRunner } from "./runners/gate.js";
import { CommandNodeRunner } from "./runners/command.js";
import { VerifyNodeRunner } from "./runners/verify.js";
import { CommitNodeRunner } from "./runners/commit.js";
import type { LoadedPipeline } from "../pipeline/load.js";

const runners: Record<string, NodeRunner> = {
  agent: new AgentNodeRunner(),
  review: new ReviewNodeRunner(),
  gate: new GateNodeRunner(),
  command: new CommandNodeRunner(),
  verify: new VerifyNodeRunner(),
  commit: new CommitNodeRunner(),
};


export type AbortIntent = "none" | "pause" | "abort";

export interface ResumeState {
  flowIndex: number;
  loopStack: LoopStackEntry[];
  nodeOutcomes: Record<string, Record<string, unknown>>;
  /** Re-run this node (and continue); for loop bodies, loopStack already set. */
  resumeNodeId: string;
  instructions: string[];
}

export interface InterpreterOptions {
  taskId: string;
  requirement: string;
  pipeline: LoadedPipeline;
  worktree: GitWorktree;
  store: KernelStore;
  events: EventLog;
  artifacts: ArtifactStore;
  config: RuntimeConfigView;
  requestIntervention: (req: InterventionRequest) => Promise<InterventionDecision>;
  signal: AbortSignal;
  /** Shared mutable abort intent (set by TaskHandle before aborting signal). */
  getAbortIntent: () => AbortIntent;
  resume?: ResumeState;
  /** Called whenever instruction queue should be drained from external source. */
  pullInstructions?: () => string[];
}

export class PipelineInterpreter {
  private loopStack: LoopStackEntry[] = [];
  private nodeOutcomes: Record<string, Record<string, unknown>> = {};
  private engineCalls = 0;
  private sessions = new Map<string, EngineSession>();
  private instructionQueue: string[] = [];
  private flowIndex = 0;
  /** When set, next runFlow iteration should start by running this node inside current step. */
  private resumeNodeId: string | null = null;

  constructor(private readonly opts: InterpreterOptions) {
    if (opts.resume) {
      this.flowIndex = opts.resume.flowIndex;
      this.loopStack = [...opts.resume.loopStack];
      this.nodeOutcomes = { ...opts.resume.nodeOutcomes };
      this.instructionQueue = [...opts.resume.instructions];
      this.resumeNodeId = opts.resume.resumeNodeId;
    }
  }

  injectInstruction(text: string): void {
    this.instructionQueue.push(text);
  }

  async run(): Promise<{
    status: "completed" | "failed" | "aborted" | "suspended";
    error?: string;
  }> {
    const { events, store, taskId, pipeline } = this.opts;

    if (!this.opts.resume) {
      await events.emit("task.started", {});
    } else {
      await events.emit("task.resumed", {
        nodeId: this.opts.resume.resumeNodeId,
        flowIndex: this.opts.resume.flowIndex,
      });
    }
    store.updateTask(taskId, { status: "running" });

    try {
      await this.runFlow(pipeline.flow);
      await events.emit("task.completed", {
        branch: this.opts.worktree.branch,
      });
      store.updateTask(taskId, { status: "completed", current_node: null });
      return { status: "completed" };
    } catch (err) {
      if (err instanceof SuspendedError) {
        await events.emit("task.suspended", { reason: err.message });
        return { status: "suspended", error: err.message };
      }
      if (this.opts.getAbortIntent() === "abort" || this.opts.signal.aborted) {
        await events.emit("task.aborted", {});
        store.updateTask(taskId, { status: "aborted" });
        return { status: "aborted" };
      }
      const message = err instanceof Error ? err.message : String(err);
      await events.emit("task.failed", { error: message });
      store.updateTask(taskId, { status: "failed", error: message });
      return { status: "failed", error: message };
    } finally {
      for (const session of this.sessions.values()) {
        await session.dispose().catch(() => undefined);
      }
    }
  }

  private throwIfAborted(): void {
    if (!this.opts.signal.aborted) return;
    const intent = this.opts.getAbortIntent();
    if (intent === "pause") {
      this.opts.store.updateTask(this.opts.taskId, { status: "suspended" });
      throw new SuspendedError("paused");
    }
    throw new Error("aborted");
  }

  private async runFlow(flow: FlowStep[]): Promise<void> {
    let i = this.flowIndex;
    while (i < flow.length) {
      this.throwIfAborted();
      this.flowIndex = i;
      const step = flow[i]!;

      if (step.kind === "loop") {
        await this.runLoop(step, i);
        this.resumeNodeId = null;
        i += 1;
        continue;
      }

      // Gate / single node
      if (this.resumeNodeId && this.resumeNodeId !== step.nodeId) {
        // Resume pointed at a different node — ignore and run current
        this.resumeNodeId = null;
      }
      this.resumeNodeId = null;

      const result = await this.runNode(step.nodeId, i);

      const checkFailed =
        result.outcome.passed === false && Array.isArray(result.outcome.failures);

      const onFail =
        step.onFail ?? this.opts.pipeline.nodes[step.nodeId]?.onFail ?? undefined;

      if (checkFailed && onFail) {
        const targetIndex = flow.findIndex(
          (s) => s.kind === "loop" && s.id === onFail.goto,
        );
        if (targetIndex < 0) throw new Error(`onFail target not found: ${onFail.goto}`);
        const targetLoop = flow[targetIndex] as Extract<FlowStep, { kind: "loop" }>;
        if (onFail.asComment) {
          const failures = (result.outcome.failures as unknown[]) ?? [];
          const reviewNodeId =
            targetLoop.body.find(
              (id) => this.opts.pipeline.nodes[id]?.type === "review",
            ) ?? targetLoop.body[0]!;
          const reviewOut =
            (this.opts.pipeline.nodes[reviewNodeId]?.outputs ?? ["reviewComments"])[0] ??
            "reviewComments";
          const summary =
            typeof result.outcome.summary === "string"
              ? result.outcome.summary
              : `${step.nodeId} failed`;
          await this.opts.artifacts.writeJson(reviewOut, {
            passed: false,
            summary,
            comments: failures.map((f, idx) => ({
              id: `${step.nodeId}-${idx}`,
              severity: onFail.asComment,
              comment: describeFailure(f),
              status: "open",
            })),
          });
          this.nodeOutcomes[reviewNodeId] = { passed: false };
        }
        i = targetIndex;
        continue;
      }

      if (checkFailed) {
        const failures = result.outcome.failures as unknown[];
        throw new Error(
          `Node ${step.nodeId} failed with no onFail handler: ${JSON.stringify(failures)}`,
        );
      }

      // Gate reject → re-enter nearest preceding loop (usually planLoop)
      if (result.outcome.rejected === true) {
        const comments = (result.outcome.comments as ReviewComment[] | undefined) ?? [];
        const targetIndex = findPrecedingLoopIndex(flow, i);
        if (targetIndex < 0) {
          throw new Error("Gate rejected and no preceding loop to re-enter");
        }
        const targetLoop = flow[targetIndex] as Extract<FlowStep, { kind: "loop" }>;
        const reviewNodeId =
          targetLoop.body.find((id) => this.opts.pipeline.nodes[id]?.type === "review") ??
          targetLoop.body[targetLoop.body.length - 1]!;
        const outKey =
          (this.opts.pipeline.nodes[reviewNodeId]?.outputs ?? ["planComments"])[0] ??
          "planComments";
        await this.opts.artifacts.writeJson(outKey, {
          passed: false,
          summary: "Rejected at gate",
          comments: comments.length
            ? comments
            : [
                {
                  id: "gate-reject",
                  severity: "major",
                  comment: "Plan rejected at approval gate",
                  status: "open",
                },
              ],
        });
        this.nodeOutcomes[reviewNodeId] = { passed: false };
        // Feed reject comments into instruction queue for next plan turn
        if (comments.length) {
          this.instructionQueue.push(
            `Gate rejected with comments:\n${comments.map((c) => `- [${c.severity}] ${c.comment}`).join("\n")}`,
          );
        }
        i = targetIndex;
        continue;
      }

      i += 1;
    }
  }

  private async runLoop(
    step: Extract<FlowStep, { kind: "loop" }>,
    flowIndex: number,
  ): Promise<void> {
    // If resuming inside this loop, restore iteration from stack
    let startIteration = 1;
    if (this.resumeNodeId && this.loopStack.some((e) => e.loopId === step.id)) {
      const entry = this.loopStack.find((e) => e.loopId === step.id)!;
      startIteration = entry.iteration;
      // Remove from stack; will re-push below
      this.loopStack = this.loopStack.filter((e) => e.loopId !== step.id);
    } else if (this.resumeNodeId && !this.loopStack.some((e) => e.loopId === step.id)) {
      // Resuming into this loop fresh at current resume node
      startIteration = 1;
    }

    for (let iteration = startIteration; iteration <= step.maxIterations; iteration++) {
      this.loopStack.push({ loopId: step.id, iteration });
      await this.opts.events.emit("loop.iteration", {
        loopId: step.id,
        iteration,
        maxIterations: step.maxIterations,
      });
      this.opts.store.updateTask(this.opts.taskId, {
        loop_state: JSON.stringify(
          Object.fromEntries(this.loopStack.map((e) => [e.loopId, e.iteration])),
        ),
      });

      let bodyStart = 0;
      if (this.resumeNodeId) {
        const idx = step.body.indexOf(this.resumeNodeId);
        if (idx >= 0) {
          bodyStart = idx;
          this.resumeNodeId = null;
        }
      }

      for (let b = bodyStart; b < step.body.length; b++) {
        const nodeId = step.body[b]!;
        await this.runNode(nodeId, flowIndex);
        if (evaluateExpression(step.until, this.nodeOutcomes)) break;
      }

      this.loopStack.pop();

      const passed = evaluateExpression(step.until, this.nodeOutcomes);
      if (passed) return;
    }

    const summary = `Loop ${step.id} reached maxIterations=${step.maxIterations}`;
    try {
      await this.askForIntervention({
        requestId: `limit-${step.id}`,
        nodeId: step.id,
        kind: "limit",
        summary,
      });
    } catch {
      // No handler / rejected — remain suspended.
    }
    throw new SuspendedError(summary);
  }

  /**
   * Emit, persist and await one intervention. The checkpoint copy is what lets
   * serve / CLI answer a request after the daemon that raised it is gone.
   */
  private async askForIntervention(req: InterventionRequest): Promise<InterventionDecision> {
    await this.opts.events.emit("intervention.required", req);
    this.opts.store.updateTask(this.opts.taskId, { status: "suspended" });
    this.patchCheckpoint({ pending_intervention: JSON.stringify(req) });
    try {
      const decision = await this.opts.requestIntervention(req);
      this.opts.store.updateTask(this.opts.taskId, { status: "running" });
      this.patchCheckpoint({ pending_intervention: null });
      return decision;
    } catch (err) {
      if (this.opts.getAbortIntent() === "pause") {
        throw new SuspendedError("paused while waiting for intervention");
      }
      throw err;
    }
  }

  private patchCheckpoint(patch: Partial<CheckpointRow>): void {
    const cp = this.opts.store.getCheckpoint(this.opts.taskId);
    if (!cp) return;
    this.opts.store.saveCheckpoint({ ...cp, ...patch, updated_at: new Date().toISOString() });
  }

  private async runNode(nodeId: string, flowIndex: number) {
    const spec = this.opts.pipeline.nodes[nodeId];
    if (!spec) throw new Error(`Unknown node: ${nodeId}`);

    const runner = runners[spec.type];
    if (!runner) throw new Error(`No runner for primitive: ${spec.type}`);

    this.throwIfAborted();

    this.opts.store.updateTask(this.opts.taskId, { current_node: nodeId });
    const engineKey = resolveNodeEngineKey(spec);
    const engineConf = engineKey ? this.opts.config.engines[engineKey] : undefined;
    const resolvedModel = engineKey ? (spec.model ?? engineConf?.model) : undefined;
    await this.opts.events.emit("node.started", {
      nodeId,
      primitive: spec.type,
      engine: engineKey,
      model: resolvedModel,
      loopStack: [...this.loopStack],
    });

    const head = await this.opts.worktree.head();
    this.opts.store.saveCheckpoint({
      task_id: this.opts.taskId,
      node_id: nodeId,
      loop_stack: JSON.stringify(this.loopStack),
      head_commit: head,
      engine_session_id: null,
      instructions: JSON.stringify(this.instructionQueue),
      flow_cursor: JSON.stringify({ flowIndex }),
      node_outcomes: JSON.stringify(this.nodeOutcomes),
      pending_intervention: null,
      updated_at: new Date().toISOString(),
    });

    if (this.opts.pullInstructions) {
      for (const text of this.opts.pullInstructions()) {
        this.instructionQueue.push(text);
      }
    }
    const instructions = this.instructionQueue.splice(0, this.instructionQueue.length);
    const engine = await this.maybeSession(spec);

    const task: TaskSnapshot = {
      id: this.opts.taskId,
      requirement: this.opts.requirement,
      pipelineName: this.opts.pipeline.name,
      pipelineHash: this.opts.pipeline.hash,
      loopStack: [...this.loopStack],
      nodeOutcomes: this.nodeOutcomes,
    };

    const ctx: NodeContext & { _nodeId: string } = {
      _nodeId: nodeId,
      task,
      worktree: this.opts.worktree,
      artifacts: this.opts.artifacts,
      engine,
      instructions,
      config: this.opts.config,
      signal: this.opts.signal,
      emit: async (event) => {
        await this.opts.events.emit(event.type, event.payload);
      },
      requestIntervention: (req) => this.askForIntervention(req),
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        this.throwIfAborted();

        if (engineKey) {
          this.engineCalls += 1;
          if (this.engineCalls > this.opts.config.budget.maxEngineCalls) {
            await this.opts.events.emit("budget.exceeded", { engineCalls: this.engineCalls });
            throw new Error("Budget exceeded: maxEngineCalls");
          }
        }

        const result = await runner.run(spec, ctx);
        this.throwIfAborted();
        this.nodeOutcomes[nodeId] = result.outcome;
        await this.opts.events.emit("node.completed", {
          nodeId,
          outcome: result.outcome,
          artifactIds: Object.keys(result.outputs),
        });
        return result;
      } catch (err) {
        if (err instanceof SuspendedError) throw err;
        if (this.opts.getAbortIntent() === "pause") {
          // Roll back worktree to checkpoint on pause
          try {
            await this.opts.worktree.resetHard(head);
          } catch {
            // best effort
          }
          this.opts.store.updateTask(this.opts.taskId, { status: "suspended" });
          throw new SuspendedError("paused");
        }
        if (this.opts.signal.aborted) {
          // External abort without a pause intent: surface as aborted, not suspended.
          throw new Error("aborted");
        }
        lastError = err;
        if (attempt < 2) {
          await this.opts.events.emit("node.retrying", {
            nodeId,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async maybeSession(spec: NodeSpec): Promise<EngineSession | undefined> {
    const engineKey = resolveNodeEngineKey(spec);
    if (!engineKey) return undefined;
    const engineConf = this.opts.config.engines[engineKey];
    if (!engineConf) {
      const known = Object.keys(this.opts.config.engines).join(", ") || "(none)";
      throw new Error(
        `No engine config for "${engineKey}". Known engines: ${known}. ` +
          `Add it under engines in .codeloop/config.yaml.`,
      );
    }

    const type = resolveEngineType(engineConf.type);
    const model = spec.model ?? engineConf.model;
    // Verify and commit drive real tooling (test runners, git), which reaches
    // outside the workspace; they also must not inherit the coder's conversation.
    const drivesTooling = spec.type === "verify" || spec.type === "commit";
    // Plan turns run the engine's native read-only planning mode; the plan comes
    // back through the stream, so they need no write access at all.
    const planMode =
      !drivesTooling &&
      spec.type === "agent" &&
      (spec.promptTemplate === "plan" || (spec.outputs ?? []).includes("planDoc"));
    const artifactWriteOnly = !drivesTooling && spec.type === "review";
    const readonly = drivesTooling
      ? false
      : planMode || artifactWriteOnly || (spec.readonly ?? false);
    const mode = drivesTooling
      ? spec.type
      : planMode
        ? "plan"
        : artifactWriteOnly
          ? "artifact"
          : readonly
            ? "ro"
            : "rw";
    const cacheKey = `${type}:${model ?? "-"}:${mode}`;
    const existing = this.sessions.get(cacheKey);
    if (existing) return existing;

    const adapter: EngineAdapter = getEngineAdapter(type);
    const session = await adapter.createSession({
      cwd: this.opts.worktree.worktreePath,
      model,
      readonly,
      planMode,
      artifactWriteOnly,
      sandbox: !drivesTooling && this.opts.config.sandbox ? "enabled" : "disabled",
      nodeTimeoutMs: this.opts.config.budget.nodeTimeoutMinutes * 60_000,
      signal: this.opts.signal,
    });
    this.sessions.set(cacheKey, session);
    return session;
  }
}

/** Render a verify/command failure as review-comment prose. */
function describeFailure(failure: unknown): string {
  if (failure && typeof failure === "object") {
    const f = failure as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const head = [str(f.check), str(f.command)].filter(Boolean).join(" — ");
    const detail = str(f.detail) ?? str(f.stderr);
    const rendered = [head, detail].filter(Boolean).join("\n");
    if (rendered) return rendered;
  }
  return JSON.stringify(failure);
}

function findPrecedingLoopIndex(flow: FlowStep[], fromIndex: number): number {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (flow[i]!.kind === "loop") return i;
  }
  return -1;
}
