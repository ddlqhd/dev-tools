import { useEffect, useState } from "react";
import { getPlatformToken } from "./api-token";

export type HubMessage = { type: string; payload: unknown };

/** `online` means the socket is open; `offline` covers both "never connected" and "retrying". */
export type HubStatus = "connecting" | "online" | "offline";

const messageListeners = new Set<(msg: HubMessage) => void>();
const statusListeners = new Set<(status: HubStatus) => void>();

let socket: WebSocket | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let delayMs = 500;
let status: HubStatus = "offline";
/** Bumped on every successful open so consumers can tell a reconnect from a re-render. */
let generation = 0;

function setStatus(next: HubStatus) {
  if (status === next) return;
  status = next;
  for (const listener of [...statusListeners]) listener(next);
}

function attach() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const token = getPlatformToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const ws = new WebSocket(`${proto}://${location.host}/api/stream${query}`);
  socket = ws;
  setStatus("connecting");

  ws.onmessage = (ev) => {
    let msg: HubMessage;
    try {
      msg = JSON.parse(String(ev.data)) as HubMessage;
    } catch {
      return;
    }
    for (const listener of [...messageListeners]) listener(msg);
  };

  ws.onopen = () => {
    delayMs = 500;
    generation += 1;
    setStatus("online");
  };

  ws.onclose = () => {
    if (socket !== ws) return;
    socket = undefined;
    setStatus("offline");
    if (messageListeners.size === 0 && statusListeners.size === 0) return;
    retry = setTimeout(() => {
      retry = undefined;
      attach();
    }, delayMs);
    delayMs = Math.min(delayMs * 2, 8_000);
  };
}

function ensureConnected() {
  if (socket || retry) return;
  attach();
}

function teardownIfIdle() {
  if (messageListeners.size > 0 || statusListeners.size > 0) return;
  if (retry) {
    clearTimeout(retry);
    retry = undefined;
  }
  const ws = socket;
  socket = undefined;
  ws?.close();
  setStatus("offline");
}

/** Verbose kernel stream: token-level engine.chunk for the open task. */
export function connectTaskStream(
  taskId: string,
  onEvent: (event: { seq: number; ts: string; type: string; payload: unknown }) => void,
): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const token = getPlatformToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const ws = new WebSocket(
    `${proto}://${location.host}/api/tasks/${encodeURIComponent(taskId)}/stream${query}`,
  );
  ws.onmessage = (ev) => {
    let event: { seq?: number; ts?: string; type?: string; payload?: unknown };
    try {
      event = JSON.parse(String(ev.data)) as { seq?: number; ts?: string; type?: string; payload?: unknown };
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
  return () => {
    ws.onmessage = null;
    ws.close();
  };
}

export function connectHub(onMessage: (msg: HubMessage) => void): () => void {
  messageListeners.add(onMessage);
  ensureConnected();
  return () => {
    messageListeners.delete(onMessage);
    teardownIfIdle();
  };
}

export function subscribeHubStatus(onStatus: (status: HubStatus) => void): () => void {
  statusListeners.add(onStatus);
  ensureConnected();
  return () => {
    statusListeners.delete(onStatus);
    teardownIfIdle();
  };
}

export function useHubStatus(): HubStatus {
  const [value, setValue] = useState<HubStatus>(status);
  useEffect(() => subscribeHubStatus(setValue), []);
  return value;
}

/**
 * Live data plus a reconciliation signal: `generation` changes on every (re)connect,
 * so callers can refetch a full snapshot after the socket was down.
 */
export function useHubSync(): { status: HubStatus; generation: number } {
  const [value, setValue] = useState({ status, generation });
  useEffect(() => subscribeHubStatus((next) => setValue({ status: next, generation })), []);
  return value;
}
