import { render, type Instance } from "ink";
import type {
  InterventionDecision,
  InterventionRequest,
  KernelEvent,
} from "@devtools/shared";
import { App } from "./App.js";
import type { TaskUiStatus, UiMeta } from "./reducer.js";
import { UiStore } from "./store.js";

export interface TuiSessionOptions {
  meta: UiMeta;
  quiet?: boolean;
  onDecision?: (
    request: InterventionRequest,
    decision: InterventionDecision,
  ) => void | Promise<void>;
  onInject?: (text: string) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

export class TuiSession {
  readonly store: UiStore;
  private readonly options: TuiSessionOptions;
  private instance: Instance | undefined;
  private stopping: Promise<void> | undefined;

  constructor(options: TuiSessionOptions) {
    this.options = options;
    this.store = new UiStore(options.meta);
  }

  start(): void {
    if (this.instance) return;
    this.store.dispatch({ type: "header" });
    this.instance = render(
      <App
        store={this.store}
        onDecision={this.options.onDecision}
        onInject={this.options.onInject}
        onCancel={this.options.onCancel}
      />,
      {
        exitOnCtrlC: false,
        maxFps: 20,
      },
    );
  }

  event(event: KernelEvent): void {
    if (this.options.quiet && event.type === "engine.chunk") return;
    this.store.dispatch({ type: "event", event });
    if (event.type === "intervention.required") this.store.flush();
  }

  pending(request: InterventionRequest): void {
    this.store.dispatch({ type: "pending", request });
    this.store.flush();
  }

  hydrate(
    status: TaskUiStatus,
    options: { startedAt?: number; currentNode?: string; error?: string } = {},
  ): void {
    this.store.dispatch({ type: "hydrate", status, ...options });
  }

  notice(level: "info" | "warn" | "error", text: string): void {
    this.store.dispatch({ type: "notice", level, text });
  }

  finish(status: TaskUiStatus, error?: string): void {
    this.store.dispatch({ type: "finish", status, error });
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopInner();
    return this.stopping;
  }

  private async stopInner(): Promise<void> {
    const instance = this.instance;
    if (!instance) {
      this.store.dispose();
      return;
    }

    this.store.flush();
    // Ink 6 renders legacy roots synchronously; yield once so React effects
    // triggered by the final store notification can commit before unmount.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const exited = instance.waitUntilExit();
    instance.unmount();
    await exited;
    this.instance = undefined;
    this.store.dispose();
  }
}

export function isTerminalEvent(event: KernelEvent): boolean {
  return (
    event.type === "task.completed" ||
    event.type === "task.failed" ||
    event.type === "task.aborted"
  );
}
