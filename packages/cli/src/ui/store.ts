import { initialState, reduce, type UiAction, type UiMeta, type UiState } from "./reducer.js";

/**
 * Holds UI state outside React and notifies subscribers on a coalescing timer.
 * Engine chunks arrive far faster than the terminal can repaint, so dispatch is
 * cheap and only the flush is throttled.
 */
export class UiStore {
  private state: UiState;
  private readonly listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;
  private readonly intervalMs: number;

  constructor(meta: UiMeta, intervalMs = 60) {
    this.state = initialState(meta);
    this.intervalMs = intervalMs;
  }

  getState = (): UiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispatch(action: UiAction): void {
    const next = reduce(this.state, action);
    if (next === this.state) return;
    this.state = next;
    this.schedule();
  }

  /** Notify immediately — used when the UI must react without latency (approvals). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.listeners.clear();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const listener of this.listeners) listener();
    }, this.intervalMs);
    this.timer.unref?.();
  }
}
