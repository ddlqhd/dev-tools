import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectTaskStreamAtUrl,
  nextTaskStreamRetryMs,
  type TaskStreamSocket,
} from "./task-stream.ts";

class FakeSocket implements TaskStreamSocket {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

test("nextTaskStreamRetryMs: doubles up to 8s", () => {
  assert.equal(nextTaskStreamRetryMs(500), 1000);
  assert.equal(nextTaskStreamRetryMs(4000), 8000);
  assert.equal(nextTaskStreamRetryMs(8000), 8000);
});

test("connectTaskStreamAtUrl: reconnects after close and stops when torn down", () => {
  const sockets: FakeSocket[] = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const off = connectTaskStreamAtUrl("ws://test/tasks/t1/stream", () => undefined, {
    openSocket: () => {
      const ws = new FakeSocket();
      sockets.push(ws);
      return ws;
    },
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return () => undefined;
    },
  });

  assert.equal(sockets.length, 1);
  sockets[0]!.onopen?.();
  sockets[0]!.close();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.ms, 500);

  scheduled[0]!.fn();
  assert.equal(sockets.length, 2);

  off();
  sockets[1]!.close();
  assert.equal(scheduled.length, 1);
  assert.equal(sockets[1]!.closed, true);
});
