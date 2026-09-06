export type TaskStreamEvent = { seq: number; ts: string; type: string; payload: unknown };

export type TaskStreamSocket = {
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onopen: (() => void) | null;
  close: () => void;
};

export type ConnectTaskStreamOptions = {
  url?: string;
  openSocket?: (url: string) => TaskStreamSocket;
  schedule?: (fn: () => void, ms: number) => () => void;
};

const TASK_STREAM_RETRY_START_MS = 500;
const TASK_STREAM_RETRY_MAX_MS = 8_000;

export function nextTaskStreamRetryMs(delayMs: number): number {
  return Math.min(delayMs * 2, TASK_STREAM_RETRY_MAX_MS);
}

export function connectTaskStreamAtUrl(
  url: string,
  onEvent: (event: TaskStreamEvent) => void,
  opts: Omit<ConnectTaskStreamOptions, "url"> = {},
): () => void {
  const openSocket = opts.openSocket ?? ((target) => new WebSocket(target) as unknown as TaskStreamSocket);
  const schedule =
    opts.schedule ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  let closed = false;
  let delayMs = TASK_STREAM_RETRY_START_MS;
  let socket: TaskStreamSocket | undefined;
  let cancelRetry: (() => void) | undefined;

  const attach = () => {
    if (closed) return;
    const ws = openSocket(url);
    socket = ws;
    ws.onopen = () => {
      delayMs = TASK_STREAM_RETRY_START_MS;
    };
    ws.onmessage = (ev) => {
      let event: { seq?: number; ts?: string; type?: string; payload?: unknown };
      try {
        event = JSON.parse(String(ev.data)) as {
          seq?: number;
          ts?: string;
          type?: string;
          payload?: unknown;
        };
      } catch {
        return;
      }
      if (event.seq == null || !event.type) return;
      onEvent({
        seq: event.seq,
        ts: event.ts ?? new Date().toISOString(),
        type: event.type,
        payload: event.payload,
      });
    };
    ws.onclose = () => {
      if (closed || socket !== ws) return;
      socket = undefined;
      cancelRetry = schedule(attach, delayMs);
      delayMs = nextTaskStreamRetryMs(delayMs);
    };
  };

  attach();
  return () => {
    closed = true;
    cancelRetry?.();
    cancelRetry = undefined;
    const ws = socket;
    socket = undefined;
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onopen = null;
      ws.close();
    }
  };
}
