import { appendFile } from "node:fs/promises";
import type { EngineChunkPayload, KernelEvent } from "@devtools/shared";

/** Pause after the last mergeable token before the buffered chunk is written. */
export const EVENT_CHUNK_COALESCE_IDLE_MS = 200;

type MergeableKind = "text" | "thinking";

interface PendingTextChunk {
  nodeId: string;
  kind: MergeableKind;
  text: string;
  ts: string;
  lastSeq: number;
  taskId: string;
}

/**
 * Persist receiver: every live event is delivered here. Adjacent same-node
 * thinking/text tokens are concatenated; other kinds are written as-is.
 */
export class CoalescingJsonlWriter {
  private pending: PendingTextChunk | null = null;
  private idleFlush: ReturnType<typeof setTimeout> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly coalesceIdleMs = EVENT_CHUNK_COALESCE_IDLE_MS,
  ) {}

  accept(event: KernelEvent): Promise<void> {
    const piece = mergeableText(event);
    if (piece) {
      if (
        this.pending &&
        this.pending.taskId === event.taskId &&
        this.pending.nodeId === piece.nodeId &&
        this.pending.kind === piece.kind
      ) {
        this.pending.text += piece.text;
        this.pending.lastSeq = event.seq;
        this.scheduleIdleFlush();
        return this.writeChain;
      }
      const prev = this.pending;
      this.pending = {
        ...piece,
        ts: event.ts,
        lastSeq: event.seq,
        taskId: event.taskId,
      };
      this.scheduleIdleFlush();
      return prev ? this.writeMerged(prev) : this.writeChain;
    }
    const flushed = this.flushPending();
    return flushed.then(() => this.writeEvent(event));
  }

  async flush(): Promise<void> {
    await this.flushPending();
    await this.writeChain;
  }

  private scheduleIdleFlush(): void {
    if (this.idleFlush) clearTimeout(this.idleFlush);
    if (this.coalesceIdleMs < 0) return;
    this.idleFlush = setTimeout(() => {
      this.idleFlush = undefined;
      void this.flushPending();
    }, this.coalesceIdleMs);
    this.idleFlush.unref?.();
  }

  private clearIdleFlush(): void {
    if (!this.idleFlush) return;
    clearTimeout(this.idleFlush);
    this.idleFlush = undefined;
  }

  private async flushPending(): Promise<void> {
    const prev = this.pending;
    this.pending = null;
    this.clearIdleFlush();
    if (prev) await this.writeMerged(prev);
  }

  private writeMerged(chunk: PendingTextChunk): Promise<void> {
    return this.writeEvent({
      seq: chunk.lastSeq,
      taskId: chunk.taskId,
      ts: chunk.ts,
      type: "engine.chunk",
      payload: {
        nodeId: chunk.nodeId,
        chunk: { kind: chunk.kind, text: chunk.text },
      },
    });
  }

  private writeEvent(event: KernelEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const write = this.writeChain.then(() => appendFile(this.path, line, "utf8"));
    this.writeChain = write.catch(() => {});
    return write;
  }
}

function mergeableText(event: KernelEvent): { nodeId: string; kind: MergeableKind; text: string } | null {
  if (event.type !== "engine.chunk") return null;
  const { nodeId, chunk } = (event.payload ?? {}) as Partial<EngineChunkPayload>;
  if (!chunk || (chunk.kind !== "text" && chunk.kind !== "thinking")) return null;
  return { nodeId: nodeId ?? "", kind: chunk.kind, text: chunk.text ?? "" };
}
