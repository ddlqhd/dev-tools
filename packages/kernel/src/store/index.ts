import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KernelEvent, KernelEventType } from "@devtools/shared";

export type TaskStatus =
  | "created"
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "aborted";

export interface TaskRow {
  id: string;
  requirement: string;
  repo_path: string;
  worktree_path: string;
  branch: string;
  base_commit: string;
  pipeline_name: string;
  pipeline_hash: string;
  status: TaskStatus;
  current_node: string | null;
  loop_state: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CheckpointRow {
  task_id: string;
  node_id: string;
  loop_stack: string;
  head_commit: string;
  engine_session_id: string | null;
  instructions: string;
  /** JSON: { flowIndex: number } — position in top-level flow */
  flow_cursor: string;
  /** JSON: Record<nodeId, outcome> */
  node_outcomes: string;
  /** JSON: InterventionRequest | null */
  pending_intervention: string | null;
  updated_at: string;
}

export class KernelStore {
  readonly db: DatabaseSync;
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.db = new DatabaseSync(join(rootDir, "kernel.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        requirement TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_commit TEXT NOT NULL DEFAULT '',
        pipeline_name TEXT NOT NULL,
        pipeline_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        current_node TEXT,
        loop_state TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        task_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        loop_stack TEXT NOT NULL,
        head_commit TEXT NOT NULL,
        engine_session_id TEXT,
        instructions TEXT NOT NULL,
        flow_cursor TEXT NOT NULL DEFAULT '{"flowIndex":0}',
        node_outcomes TEXT NOT NULL DEFAULT '{}',
        pending_intervention TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        engine_type TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        ts TEXT NOT NULL
      );
    `);
    this.migrateSchema();
  }

  private migrateSchema(): void {
    const taskCols = this.db
      .prepare(`PRAGMA table_info(tasks)`)
      .all() as unknown as Array<{ name: string }>;
    const taskNames = new Set(taskCols.map((c) => c.name));
    if (!taskNames.has("base_commit")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN base_commit TEXT NOT NULL DEFAULT ''`);
    }

    const cols = this.db
      .prepare(`PRAGMA table_info(checkpoints)`)
      .all() as unknown as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("flow_cursor")) {
      this.db.exec(
        `ALTER TABLE checkpoints ADD COLUMN flow_cursor TEXT NOT NULL DEFAULT '{"flowIndex":0}'`,
      );
    }
    if (!names.has("node_outcomes")) {
      this.db.exec(
        `ALTER TABLE checkpoints ADD COLUMN node_outcomes TEXT NOT NULL DEFAULT '{}'`,
      );
    }
    if (!names.has("pending_intervention")) {
      this.db.exec(`ALTER TABLE checkpoints ADD COLUMN pending_intervention TEXT`);
    }
  }

  close(): void {
    this.db.close();
  }

  insertTask(row: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, requirement, repo_path, worktree_path, branch, base_commit,
          pipeline_name, pipeline_hash, status, current_node, loop_state,
          error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.requirement,
        row.repo_path,
        row.worktree_path,
        row.branch,
        row.base_commit,
        row.pipeline_name,
        row.pipeline_hash,
        row.status,
        row.current_node,
        row.loop_state,
        row.error,
        row.created_at,
        row.updated_at,
      );
  }

  updateTask(
    id: string,
    patch: Partial<Pick<TaskRow, "status" | "current_node" | "loop_state" | "error">>,
  ): void {
    const current = this.getTask(id);
    if (!current) throw new Error(`Task not found: ${id}`);
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE tasks SET status=?, current_node=?, loop_state=?, error=?, updated_at=? WHERE id=?`,
      )
      .run(next.status, next.current_node, next.loop_state, next.error, next.updated_at, id);
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as unknown as
      | TaskRow
      | undefined;
  }

  listTasks(): TaskRow[] {
    return this.db
      .prepare(`SELECT * FROM tasks ORDER BY created_at DESC`)
      .all() as unknown as TaskRow[];
  }

  saveCheckpoint(row: CheckpointRow): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (
          task_id, node_id, loop_stack, head_commit, engine_session_id, instructions,
          flow_cursor, node_outcomes, pending_intervention, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          node_id=excluded.node_id,
          loop_stack=excluded.loop_stack,
          head_commit=excluded.head_commit,
          engine_session_id=excluded.engine_session_id,
          instructions=excluded.instructions,
          flow_cursor=excluded.flow_cursor,
          node_outcomes=excluded.node_outcomes,
          pending_intervention=excluded.pending_intervention,
          updated_at=excluded.updated_at`,
      )
      .run(
        row.task_id,
        row.node_id,
        row.loop_stack,
        row.head_commit,
        row.engine_session_id,
        row.instructions,
        row.flow_cursor,
        row.node_outcomes,
        row.pending_intervention,
        row.updated_at,
      );
  }

  getCheckpoint(taskId: string): CheckpointRow | undefined {
    return this.db
      .prepare(`SELECT * FROM checkpoints WHERE task_id = ?`)
      .get(taskId) as unknown as CheckpointRow | undefined;
  }

  taskDir(taskId: string): string {
    return join(this.rootDir, "tasks", taskId);
  }

  async ensureTaskDirs(taskId: string): Promise<{ taskDir: string; artifactsDir: string; logsDir: string }> {
    const taskDir = this.taskDir(taskId);
    const artifactsDir = join(taskDir, "artifacts");
    const logsDir = join(taskDir, "engine-logs");
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    return { taskDir, artifactsDir, logsDir };
  }
}

export class EventLog {
  private seq = 0;
  private readonly path: string;
  private readonly listeners = new Set<(e: KernelEvent) => void>();

  constructor(
    private readonly taskId: string,
    taskDir: string,
    startSeq = 0,
  ) {
    this.path = join(taskDir, "events.jsonl");
    this.seq = startSeq;
  }

  static async open(taskId: string, taskDir: string): Promise<EventLog> {
    let startSeq = 0;
    try {
      const raw = await readFile(join(taskDir, "events.jsonl"), "utf8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]!) as KernelEvent;
        startSeq = last.seq;
      }
    } catch {
      // new file
    }
    return new EventLog(taskId, taskDir, startSeq);
  }

  on(listener: (e: KernelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit<T>(type: KernelEventType, payload: T): Promise<KernelEvent<T>> {
    this.seq += 1;
    const event: KernelEvent<T> = {
      seq: this.seq,
      taskId: this.taskId,
      ts: new Date().toISOString(),
      type,
      payload,
    };
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    for (const listener of this.listeners) listener(event as KernelEvent);
    return event;
  }

  async readAfter(afterSeq: number): Promise<KernelEvent[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as KernelEvent)
        .filter((e) => e.seq > afterSeq);
    } catch {
      return [];
    }
  }
}

export class ArtifactStore {
  constructor(private readonly artifactsDir: string) {}

  pathFor(key: string, ext = "md"): string {
    return join(this.artifactsDir, `${key}.${ext}`);
  }

  async writeText(key: string, content: string, ext = "md"): Promise<string> {
    const path = this.pathFor(key, ext);
    await writeFile(path, content, "utf8");
    return path;
  }

  async writeJson(key: string, value: unknown): Promise<string> {
    const path = this.pathFor(key, "json");
    await writeFile(path, JSON.stringify(value, null, 2), "utf8");
    return path;
  }

  async readText(key: string, ext = "md"): Promise<string | null> {
    try {
      return await readFile(this.pathFor(key, ext), "utf8");
    } catch {
      return null;
    }
  }

  async readJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await readFile(this.pathFor(key, "json"), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
