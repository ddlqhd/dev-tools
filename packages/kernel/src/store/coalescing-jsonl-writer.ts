import { appendFile } from "node:fs/promises";
import type { EngineChunkPayload, KernelEvent } from "@devtools/shared";

export type AppendLine = (path: string, data: string, encoding: BufferEncoding) => Promise<void>;

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
 * thinking/text tokens stay in memory until kind/node changes or a
 * non-mergeable event arrives — idle time does not start a new record.
 */
export class CoalescingJsonlWriter {
  private pending: PendingTextChunk | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private lastWriteError: Error | null = null;

  constructor(
    private readonly path: string,
    private readonly append: AppendLine = appendFile,
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
        return this.writeChain;
      }
      const prev = this.pending;
      this.pending = {
        ...piece,
        ts: event.ts,
        lastSeq: event.seq,
        taskId: event.taskId,
      };
      return prev ? this.writeMerged(prev) : this.writeChain;
    }
    return this.flushPending().then(() => this.writeEvent(event));
  }

  /** In-memory merged chunk not yet on disk. */
  peekPending(): KernelEvent | null {
    const chunk = this.pending;
    if (!chunk) return null;
    return {
      seq: chunk.lastSeq,
      taskId: chunk.taskId,
      ts: chunk.ts,
      type: "engine.chunk",
      payload: {
        nodeId: chunk.nodeId,
        chunk: { kind: chunk.kind, text: chunk.text },
      },
    };
  }

  async flush(): Promise<void> {
    await this.flushPending();
    await this.throwIfWriteFailed();
  }

  /** Wait for queued appends without forcing the current thinking/text buffer to disk. */
  async waitForWrites(): Promise<void> {
    await this.throwIfWriteFailed();
  }

  private async throwIfWriteFailed(): Promise<void> {
    await this.writeChain;
    if (!this.lastWriteError) return;
    const err = this.lastWriteError;
    this.lastWriteError = null;
    throw err;
  }

  private async flushPending(): Promise<void> {
    const prev = this.pending;
    this.pending = null;
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
    const write = this.writeChain.then(() => this.append(this.path, line, "utf8"));
    this.writeChain = write.then(
      () => {
        this.lastWriteError = null;
      },
      (err: unknown) => {
        this.lastWriteError = err instanceof Error ? err : new Error(String(err));
      },
    );
    return write;
  }
}

function mergeableText(event: KernelEvent): { nodeId: string; kind: MergeableKind; text: string } | null {
  if (event.type !== "engine.chunk") return null;
  const { nodeId, chunk } = (event.payload ?? {}) as Partial<EngineChunkPayload>;
  if (!chunk || (chunk.kind !== "text" && chunk.kind !== "thinking")) return null;
  return { nodeId: nodeId ?? "", kind: chunk.kind, text: chunk.text ?? "" };
}
