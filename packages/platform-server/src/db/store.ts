import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { PlatformTaskStatus } from "@devtools/shared";

export interface RepoRow {
  id: string;
  platform: string;
  full_name: string;
  clone_path: string;
  trigger_label: string;
  max_concurrency: number;
  github_token: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  repo_id: string;
  source: string;
  issue_number: number | null;
  title: string;
  requirement: string;
  status: PlatformTaskStatus;
  priority: number;
  instance_id: string | null;
  kernel_task_id: string | null;
  branch: string | null;
  pr_number: number | null;
  current_node: string | null;
  loop_state: string | null;
  pipeline_name: string | null;
  progress_comment_id: string | null;
  error: string | null;
  /** Times this task has been auto-requeued after failure. */
  retry_count?: number;
  /** Earliest time the scheduler may pick this task up again (ISO). */
  next_retry_at?: string | null;
  /** For derived tasks (e.g. ci-fix): the task that produced the PR. */
  parent_task_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InstanceRow {
  id: string;
  launcher: string;
  repo_id: string | null;
  endpoint: string;
  token: string | null;
  pid: number | null;
  status: string;
  started_at: string;
  last_seen_at: string;
}

export interface TaskEventRow {
  task_id: string;
  seq: number;
  ts: string;
  type: string;
  payload: string;
}

export class PlatformStore {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir, "platform.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        full_name TEXT NOT NULL,
        clone_path TEXT NOT NULL,
        trigger_label TEXT NOT NULL DEFAULT 'ai-dev',
        max_concurrency INTEGER NOT NULL DEFAULT 1,
        github_token TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(platform, full_name)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id),
        source TEXT NOT NULL,
        issue_number INTEGER,
        title TEXT NOT NULL,
        requirement TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        instance_id TEXT,
        kernel_task_id TEXT,
        branch TEXT,
        pr_number INTEGER,
        current_node TEXT,
        loop_state TEXT,
        pipeline_name TEXT,
        progress_comment_id TEXT,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        parent_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, priority DESC, created_at);
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        launcher TEXT NOT NULL,
        repo_id TEXT REFERENCES repos(id),
        endpoint TEXT NOT NULL,
        token TEXT,
        pid INTEGER,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        task_id TEXT NOT NULL REFERENCES tasks(id),
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (task_id, seq)
      );
      CREATE TABLE IF NOT EXISTS interventions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        decision TEXT,
        decided_by TEXT,
        channel TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS usage_records (
        task_id TEXT NOT NULL REFERENCES tasks(id),
        stage TEXT NOT NULL,
        engine_type TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL,
        ts TEXT NOT NULL
      );
    `);
    this.migrate();
  }

  /** Schema migrations for databases created before the current layout. */
  private migrate(): void {
    const taskCols = new Set(
      (this.db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (!taskCols.has("retry_count")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
    }
    if (!taskCols.has("next_retry_at")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN next_retry_at TEXT`);
    }
    if (!taskCols.has("parent_task_id")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`);
    }

    const repoCols = new Set(
      (this.db.prepare(`PRAGMA table_info(repos)`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    // Kernel config lives in `{clone}/.codeloop/config.yaml`, not the platform DB.
    if (repoCols.has("loop_config")) {
      this.db.exec(`ALTER TABLE repos DROP COLUMN loop_config`);
    }
  }

  close(): void {
    this.db.close();
  }

  // --- repos ---
  insertRepo(row: RepoRow): void {
    this.db
      .prepare(
        `INSERT INTO repos (
          id, platform, full_name, clone_path, trigger_label, max_concurrency,
          github_token, default_branch, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.platform,
        row.full_name,
        row.clone_path,
        row.trigger_label,
        row.max_concurrency,
        row.github_token,
        row.default_branch,
        row.created_at,
        row.updated_at,
      );
  }

  updateRepo(
    id: string,
    patch: Partial<
      Pick<
        RepoRow,
        | "clone_path"
        | "trigger_label"
        | "max_concurrency"
        | "github_token"
        | "default_branch"
      >
    >,
  ): void {
    const cur = this.getRepo(id);
    if (!cur) throw new Error(`repo not found: ${id}`);
    const cleaned = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as typeof patch;
    const next = { ...cur, ...cleaned, updated_at: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE repos SET clone_path=?, trigger_label=?, max_concurrency=?,
         github_token=?, default_branch=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.clone_path,
        next.trigger_label,
        next.max_concurrency,
        next.github_token,
        next.default_branch,
        next.updated_at,
        id,
      );
  }

  getRepo(id: string): RepoRow | undefined {
    return this.db.prepare(`SELECT * FROM repos WHERE id = ?`).get(id) as unknown as
      | RepoRow
      | undefined;
  }

  getRepoByFullName(platform: string, fullName: string): RepoRow | undefined {
    return this.db
      .prepare(`SELECT * FROM repos WHERE platform = ? AND full_name = ?`)
      .get(platform, fullName) as unknown as RepoRow | undefined;
  }

  listRepos(): RepoRow[] {
    return this.db.prepare(`SELECT * FROM repos ORDER BY full_name`).all() as unknown as RepoRow[];
  }

  // --- tasks ---
  insertTask(row: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, repo_id, source, issue_number, title, requirement, status, priority,
          instance_id, kernel_task_id, branch, pr_number, current_node, loop_state,
          pipeline_name, progress_comment_id, error, retry_count, next_retry_at,
          parent_task_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.repo_id,
        row.source,
        row.issue_number,
        row.title,
        row.requirement,
        row.status,
        row.priority,
        row.instance_id,
        row.kernel_task_id,
        row.branch,
        row.pr_number,
        row.current_node,
        row.loop_state,
        row.pipeline_name,
        row.progress_comment_id,
        row.error,
        row.retry_count ?? 0,
        row.next_retry_at ?? null,
        row.parent_task_id ?? null,
        row.created_at,
        row.updated_at,
      );
  }

  updateTask(
    id: string,
    patch: Partial<
      Pick<
        TaskRow,
        | "status"
        | "priority"
        | "instance_id"
        | "kernel_task_id"
        | "branch"
        | "pr_number"
        | "current_node"
        | "loop_state"
        | "pipeline_name"
        | "progress_comment_id"
        | "error"
        | "retry_count"
        | "next_retry_at"
        | "parent_task_id"
      >
    >,
  ): void {
    const cur = this.getTask(id);
    if (!cur) throw new Error(`task not found: ${id}`);
    const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE tasks SET status=?, priority=?, instance_id=?, kernel_task_id=?, branch=?,
         pr_number=?, current_node=?, loop_state=?, pipeline_name=?, progress_comment_id=?,
         error=?, retry_count=?, next_retry_at=?, parent_task_id=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.status,
        next.priority,
        next.instance_id,
        next.kernel_task_id,
        next.branch,
        next.pr_number,
        next.current_node,
        next.loop_state,
        next.pipeline_name,
        next.progress_comment_id,
        next.error,
        next.retry_count ?? 0,
        next.next_retry_at ?? null,
        next.parent_task_id ?? null,
        next.updated_at,
        id,
      );
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as unknown as
      | TaskRow
      | undefined;
  }

  getTaskByKernelId(kernelTaskId: string): TaskRow | undefined {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE kernel_task_id = ?`)
      .get(kernelTaskId) as unknown as TaskRow | undefined;
  }

  listChildTasks(parentId: string): TaskRow[] {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC`)
      .all(parentId) as unknown as TaskRow[];
  }

  deleteTask(id: string): void {
    this.db.prepare(`DELETE FROM task_events WHERE task_id = ?`).run(id);
    this.db.prepare(`DELETE FROM interventions WHERE task_id = ?`).run(id);
    this.db.prepare(`DELETE FROM usage_records WHERE task_id = ?`).run(id);
    this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
  }

  findOpenTaskByIssue(repoId: string, issueNumber: number): TaskRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE repo_id = ? AND issue_number = ?
         AND status NOT IN ('done','failed','cancelled')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repoId, issueNumber) as unknown as TaskRow | undefined;
  }

  listTasks(filter?: { status?: string; repoId?: string }): TaskRow[] {
    let sql = `SELECT * FROM tasks WHERE 1=1`;
    const params: string[] = [];
    if (filter?.status) {
      sql += ` AND status = ?`;
      params.push(filter.status);
    }
    if (filter?.repoId) {
      sql += ` AND repo_id = ?`;
      params.push(filter.repoId);
    }
    sql += ` ORDER BY created_at DESC`;
    return this.db.prepare(sql).all(...params) as unknown as TaskRow[];
  }

  dequeueCandidates(limit: number): TaskRow[] {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'queued'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY priority DESC, COALESCE(next_retry_at, created_at) ASC LIMIT ?`,
      )
      .all(now, limit) as unknown as TaskRow[];
  }

  getTaskByPr(repoId: string, prNumber: number): TaskRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE repo_id = ? AND pr_number = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repoId, prNumber) as unknown as TaskRow | undefined;
  }

  /** Most recent task on a branch regardless of status (excludes ci-fix chains). */
  getLatestTaskByBranch(repoId: string, branch: string): TaskRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE repo_id = ? AND branch = ? AND source != 'ci-fix'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repoId, branch) as unknown as TaskRow | undefined;
  }

  countCiFixTasks(parentTaskId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks
         WHERE parent_task_id = ? AND source = 'ci-fix'
         AND status NOT IN ('cancelled')`,
      )
      .get(parentTaskId) as { c: number };
    return row.c;
  }

  /** A ci-fix already queued/running for this parent — don't stack duplicates. */
  hasOpenCiFixTask(parentTaskId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks
         WHERE parent_task_id = ? AND source = 'ci-fix'
         AND status IN ('queued','preparing','running','paused','waiting_human','delivering')`,
      )
      .get(parentTaskId) as { c: number };
    return row.c > 0;
  }

  countActiveByRepo(repoId: string): number {
    // `waiting_human` / `paused` deliberately excluded: parked tasks must
    // not block fresh work from being scheduled for the same repo.
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks WHERE repo_id = ?
         AND status IN ('preparing','running','delivering')`,
      )
      .get(repoId) as { c: number };
    return row.c;
  }

  countActiveInstances(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM instances WHERE status IN ('starting','idle','busy')`,
      )
      .get() as { c: number };
    return row.c;
  }

  // --- instances ---
  insertInstance(row: InstanceRow): void {
    this.db
      .prepare(
        `INSERT INTO instances (
          id, launcher, repo_id, endpoint, token, pid, status, started_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.launcher,
        row.repo_id,
        row.endpoint,
        row.token,
        row.pid,
        row.status,
        row.started_at,
        row.last_seen_at,
      );
  }

  updateInstance(
    id: string,
    patch: Partial<Pick<InstanceRow, "status" | "pid" | "endpoint" | "token" | "last_seen_at">>,
  ): void {
    const cur = this.getInstance(id);
    if (!cur) throw new Error(`instance not found: ${id}`);
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE instances SET status=?, pid=?, endpoint=?, token=?, last_seen_at=? WHERE id=?`,
      )
      .run(next.status, next.pid, next.endpoint, next.token, next.last_seen_at, id);
  }

  getInstance(id: string): InstanceRow | undefined {
    return this.db.prepare(`SELECT * FROM instances WHERE id = ?`).get(id) as unknown as
      | InstanceRow
      | undefined;
  }

  listInstances(): InstanceRow[] {
    return this.db
      .prepare(`SELECT * FROM instances ORDER BY started_at DESC`)
      .all() as unknown as InstanceRow[];
  }

  /** Kernels that are still up. Dead rows stay in the table for history. */
  listLiveInstances(): InstanceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM instances WHERE status IN ('starting','idle','busy')
         ORDER BY started_at DESC`,
      )
      .all() as unknown as InstanceRow[];
  }

  listTasksOnInstance(instanceId: string): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE instance_id = ?
         AND status IN ('preparing','running','paused','waiting_human','delivering')
         ORDER BY updated_at DESC`,
      )
      .all(instanceId) as unknown as TaskRow[];
  }

  /**
   * Live kernels for this repo. Busy first so a stale idle row cannot hide
   * the process that still holds `.codeloop/kernel.lock`.
   */
  listReusableInstances(repoId: string): InstanceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM instances WHERE repo_id = ? AND status IN ('idle','busy','starting')
         ORDER BY CASE status WHEN 'busy' THEN 0 WHEN 'starting' THEN 1 ELSE 2 END,
                  last_seen_at DESC`,
      )
      .all(repoId) as unknown as InstanceRow[];
  }

  countActiveTasksOnInstance(instanceId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks WHERE instance_id = ?
         AND status IN ('preparing','running','paused','waiting_human','delivering')`,
      )
      .get(instanceId) as { c: number };
    return row.c;
  }

  // --- events ---
  insertEvent(row: TaskEventRow): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO task_events (task_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(row.task_id, row.seq, row.ts, row.type, row.payload);
      return true;
    } catch {
      return false; // duplicate
    }
  }

  listEvents(taskId: string, afterSeq = 0): TaskEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(taskId, afterSeq) as unknown as TaskEventRow[];
  }

  lastEventSeq(taskId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) AS m FROM task_events WHERE task_id = ?`)
      .get(taskId) as { m: number | null };
    return row.m ?? 0;
  }

  insertIntervention(row: {
    id: string;
    task_id: string;
    request_id: string;
    kind: string;
    decision: string | null;
    decided_by: string | null;
    channel: string;
    created_at: string;
    decided_at: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO interventions (
          id, task_id, request_id, kind, decision, decided_by, channel, created_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.task_id,
        row.request_id,
        row.kind,
        row.decision,
        row.decided_by,
        row.channel,
        row.created_at,
        row.decided_at,
      );
  }

  insertUsage(row: {
    task_id: string;
    stage: string;
    engine_type: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    ts: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO usage_records (
          task_id, stage, engine_type, input_tokens, output_tokens, cost_usd, ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.task_id,
        row.stage,
        row.engine_type,
        row.input_tokens,
        row.output_tokens,
        row.cost_usd,
        row.ts,
      );
  }
}
