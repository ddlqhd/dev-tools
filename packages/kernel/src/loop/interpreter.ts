import type {
  FlowStep,
  InterventionDecision,
  InterventionRequest,
  KernelEvent,
  LoopStackEntry,
  NodeSpec,
} from "@devtools/shared";
import type { EngineAdapter, EngineSession } from "../engines/adapter.js";
import { getEngineAdapter, resolveEngineType } from "../engines/registry.js";
import type { ArtifactStore, EventLog, KernelStore } from "../store/index.js";
import type { GitWorktree } from "../git/worktree.js";
import { evaluateExpression } from "./expressions.js";
import type { NodeContext, NodeRunner, RuntimeConfigView, TaskSnapshot } from "./node.js";
import { AgentNodeRunner } from "./runners/agent.js";
import { ReviewNodeRunner } from "./runners/review.js";
import { GateNodeRunner } from "./runners/gate.js";
import { CommandNodeRunner } from "./runners/command.js";
import { CommitNodeRunner } from "./runners/commit.js";
import type { LoadedPipeline } from "../pipeline/load.js";

const runners: Record<string, NodeRunner> = {
  agent: new AgentNodeRunner(),
  review: new ReviewNodeRunner(),
  gate: new GateNodeRunner(),
  command: new CommandNodeRunner(),
  commit: new CommitNodeRunner(),
};

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
  onEvent?: (event: KernelEvent) => void;
}

export class PipelineInterpreter {
  private loopStack: LoopStackEntry[] = [];
  private nodeOutcomes: Record<string, Record<string, unknown>> = {};
  private engineCalls = 0;
  private sessions = new Map<string, EngineSession>();
  private instructionQueue: string[] = [];

  constructor(private readonly opts: InterpreterOptions) {}

  injectInstruction(text: string): void {
    this.instructionQueue.push(text);
  }

  async run(): Promise<{ status: "completed" | "failed" | "aborted"; error?: string }> {
    const { events, store, taskId, pipeline } = this.opts;

    await events.emit("task.started", {});
    store.updateTask(taskId, { status: "running" });

    try {
      await this.runFlow(pipeline.flow);
      await events.emit("task.completed", {
        branch: this.opts.worktree.branch,
      });
      store.updateTask(taskId, { status: "completed", current_node: null });
      return { status: "completed" };
    } catch (err) {
      if (this.opts.signal.aborted) {
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

  private async runFlow(flow: FlowStep[]): Promise<void> {
    let i = 0;
    while (i < flow.length) {
      if (this.opts.signal.aborted) throw new Error("aborted");
      const step = flow[i]!;

      if (step.kind === "loop") {
        await this.runLoop(step);
        i += 1;
        continue;
      }

      const result = await this.runNode(step.nodeId);
      if (step.onFail && result.outcome.passed === false) {
        // Controlled jump back into a named loop — re-execute from that loop step
        const targetIndex = flow.findIndex(
          (s) => s.kind === "loop" && s.id === step.onFail!.goto,
        );
        if (targetIndex < 0) throw new Error(`onFail target not found: ${step.onFail.goto}`);
        // Inject failure as review comment artifact for fix cycle
        if (step.onFail.asComment) {
          const failures = (result.outcome.failures as unknown[]) ?? [];
          await this.opts.artifacts.writeJson("reviewComments", {
            passed: false,
            summary: "verify failed",
            comments: failures.map((f, idx) => ({
              id: `verify-${idx}`,
              severity: step.onFail!.asComment,
              comment: JSON.stringify(f),
              status: "open",
            })),
          });
          this.nodeOutcomes.codeReview = { passed: false };
        }
        i = targetIndex;
        continue;
      }

      // Gate reject: stop with failure for M1 (full re-entry in M2)
      if (result.outcome.rejected === true) {
        throw new Error("Gate rejected by human");
      }

      i += 1;
    }
  }

  private async runLoop(step: Extract<FlowStep, { kind: "loop" }>): Promise<void> {
    for (let iteration = 1; iteration <= step.maxIterations; iteration++) {
      this.loopStack.push({ loopId: step.id, iteration });
      await this.opts.events.emit("loop.iteration", {
        loopId: step.id,
        iteration,
        maxIterations: step.maxIterations,
      });
      this.opts.store.updateTask(this.opts.taskId, {
        loop_state: JSON.stringify(Object.fromEntries(this.loopStack.map((e) => [e.loopId, e.iteration]))),
      });

      for (const nodeId of step.body) {
        await this.runNode(nodeId);
      }

      this.loopStack.pop();

      const passed = evaluateExpression(step.until, this.nodeOutcomes);
      if (passed) return;
    }

    await this.opts.events.emit("intervention.required", {
      requestId: `limit-${step.id}`,
      nodeId: step.id,
      kind: "limit",
      summary: `Loop ${step.id} reached maxIterations=${step.maxIterations}`,
    });
    this.opts.store.updateTask(this.opts.taskId, { status: "suspended" });
    throw new Error(`Loop ${step.id} exceeded maxIterations`);
  }

  private async runNode(nodeId: string) {
    const spec = this.opts.pipeline.nodes[nodeId];
    if (!spec) throw new Error(`Unknown node: ${nodeId}`);

    const runner = runners[spec.type];
    if (!runner) throw new Error(`No runner for primitive: ${spec.type}`);

    this.opts.store.updateTask(this.opts.taskId, { current_node: nodeId });
    await this.opts.events.emit("node.started", {
      nodeId,
      primitive: spec.type,
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
      updated_at: new Date().toISOString(),
    });

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
        const e = await this.opts.events.emit(event.type, event.payload);
        this.opts.onEvent?.(e);
      },
      requestIntervention: async (req) => {
        await this.opts.events.emit("intervention.required", req);
        this.opts.store.updateTask(this.opts.taskId, { status: "suspended" });
        const decision = await this.opts.requestIntervention(req);
        this.opts.store.updateTask(this.opts.taskId, { status: "running" });
        return decision;
      },
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (spec.type === "agent" || spec.type === "review") {
          this.engineCalls += 1;
          if (this.engineCalls > this.opts.config.budget.maxEngineCalls) {
            await this.opts.events.emit("budget.exceeded", { engineCalls: this.engineCalls });
            throw new Error("Budget exceeded: maxEngineCalls");
          }
        }

        const result = await runner.run(spec, ctx);
        this.nodeOutcomes[nodeId] = result.outcome;
        await this.opts.events.emit("node.completed", {
          nodeId,
          outcome: result.outcome,
          artifactIds: Object.keys(result.outputs),
        });
        return result;
      } catch (err) {
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
    if (spec.type === "command" || spec.type === "commit" || spec.type === "gate") {
      return undefined;
    }
    const engineKey = spec.engine ?? "default";
    const engineConf = this.opts.config.engines[engineKey] ?? this.opts.config.engines.default;
    if (!engineConf) throw new Error(`No engine config for: ${engineKey}`);

    const type = resolveEngineType(engineConf.type);
    const cacheKey = `${engineKey}:${type}:${spec.readonly ? "ro" : "rw"}`;
    const existing = this.sessions.get(cacheKey);
    if (existing) return existing;

    const adapter: EngineAdapter = getEngineAdapter(type);
    const session = await adapter.createSession({
      cwd: this.opts.worktree.worktreePath,
      model: engineConf.model,
      readonly: spec.readonly ?? spec.type === "review",
      nodeTimeoutMs: this.opts.config.budget.nodeTimeoutMinutes * 60_000,
    });
    this.sessions.set(cacheKey, session);
    return session;
  }
}
