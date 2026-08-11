/** Per-task trace page served at GET /tasks/:id/view by `codeloop serve`. */
export function renderTaskHtml(opts: { token?: string; taskId: string }): string {
  const tokenJson = JSON.stringify(opts.token ?? "");
  const taskIdJson = JSON.stringify(opts.taskId);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>codeloop task ${escapeHtmlAttr(opts.taskId)}</title>
  <style>
    :root {
      --bg: #0f1419;
      --panel: #1a2332;
      --line: #2d3a4d;
      --text: #e7ecf3;
      --muted: #8b9bb4;
      --accent: #3d9cf0;
      --ok: #3ecf8e;
      --warn: #f0b429;
      --bad: #f07178;
      --mono: "SF Mono", "Menlo", "Consolas", monospace;
      --sans: "Segoe UI", system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--text);
      font: 14px/1.5 var(--sans);
    }
    a { color: var(--accent); }
    header {
      display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap;
      padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
      position: sticky; top: 0; z-index: 5;
    }
    header h1 { font-size: 16px; margin: 0; }
    header h1 code { font-family: var(--mono); color: var(--accent); }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 20px; }
    .muted { color: var(--muted); }
    .mono { font-family: var(--mono); }
    .pill {
      font-size: 12px; padding: 2px 8px; border-radius: 999px;
      border: 1px solid var(--line); color: var(--muted); white-space: nowrap;
    }
    .pill.running { color: var(--accent); border-color: #26557d; background: #12283b; }
    .pill.waiting { color: var(--warn); border-color: #6b5a2a; background: #2a2410; }
    .pill.completed { color: var(--ok); border-color: #2a6b4f; background: #143528; }
    .pill.failed, .pill.aborted { color: var(--bad); border-color: #6b2a32; background: #351418; }
    .pill.suspended { color: var(--warn); border-color: #6b5a2a; background: #2a2410; }
    .pill.created { color: var(--muted); }
    section.box {
      border: 1px solid var(--line); border-radius: 8px; background: var(--panel);
      margin-bottom: 16px; overflow: hidden;
    }
    section.box > h2 {
      margin: 0; padding: 10px 14px; font-size: 12px; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--muted); border-bottom: 1px solid var(--line);
    }
    section.box > .body { padding: 14px; }
    dl.meta {
      display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0;
    }
    dl.meta dt { color: var(--muted); font-size: 12px; }
    dl.meta dd { margin: 0; font-family: var(--mono); font-size: 12px; word-break: break-all; }
    pre.text {
      margin: 0; padding: 10px 12px; background: #0f1419; border: 1px solid var(--line);
      border-radius: 6px; white-space: pre-wrap; word-break: break-word;
      font-family: var(--mono); font-size: 12px; max-height: 420px; overflow: auto;
    }
    .stage {
      border: 1px solid var(--line); border-radius: 8px; margin-bottom: 10px; background: #16202e;
    }
    .stage.failed { border-color: #6b2a32; }
    .stage.waiting { border-color: #6b5a2a; }
    .stage > .head {
      display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
      padding: 10px 12px; cursor: pointer;
    }
    .stage > .head:hover { background: #1e2a3c; }
    .stage .idx {
      font-family: var(--mono); color: var(--muted); font-size: 12px; min-width: 22px;
    }
    .stage .node { font-weight: 600; }
    .stage .tag {
      font-size: 11px; padding: 1px 6px; border-radius: 4px;
      border: 1px solid var(--line); color: var(--muted);
    }
    .stage .grow { flex: 1; }
    .stage > .detail { padding: 0 12px 12px; border-top: 1px solid var(--line); }
    .kv { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 0; align-items: baseline; }
    .kv > .k { color: var(--muted); font-size: 12px; min-width: 64px; }
    .kv > .v { flex: 1; font-size: 12px; font-family: var(--mono); word-break: break-word; }
    .chip {
      display: inline-block; font-size: 12px; padding: 2px 8px; margin: 0 6px 4px 0;
      border-radius: 4px; border: 1px solid var(--line); background: #0f1419;
      font-family: var(--mono); text-decoration: none;
    }
    a.chip:hover { border-color: var(--accent); }
    button {
      font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px;
      border: 1px solid var(--line); background: #0f1419; color: var(--text); cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    table.files { width: 100%; border-collapse: collapse; font-size: 12px; }
    table.files th, table.files td {
      text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line);
    }
    table.files th { color: var(--muted); font-weight: 400; text-transform: uppercase; font-size: 11px; }
    table.files td.mono { font-family: var(--mono); }
    .trace { margin-top: 10px; }
    .trace .ev {
      padding: 2px 0; font-family: var(--mono); font-size: 12px;
      white-space: pre-wrap; word-break: break-word;
    }
    .trace .ev .ts { color: var(--muted); margin-right: 8px; }
    .trace .ev .type { color: var(--accent); margin-right: 8px; }
    .trace .ev.thinking, .trace .ev.thinking .type { color: var(--muted); }
    .empty { color: var(--muted); font-size: 13px; }
    .error { color: var(--bad); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
    .actions input {
      font: inherit; font-size: 12px; padding: 5px 8px; flex: 1; min-width: 180px;
      border-radius: 6px; border: 1px solid var(--line); background: #0f1419; color: var(--text);
    }
  </style>
</head>
<body>
  <header>
    <h1>codeloop task <code id="hTask"></code></h1>
    <span class="pill" id="hStatus">…</span>
    <span class="muted" id="hNode"></span>
    <span style="flex:1"></span>
    <span class="muted" id="hRefresh"></span>
    <button id="btnReload" type="button">刷新</button>
    <a href="/console">← 控制台</a>
  </header>
  <div class="wrap">
    <p id="pageError" class="error"></p>

    <section class="box">
      <h2>概览</h2>
      <div class="body">
        <dl class="meta" id="meta"></dl>
      </div>
    </section>

    <section class="box">
      <h2>需求</h2>
      <div class="body"><pre class="text" id="requirement"></pre></div>
    </section>

    <section class="box" id="pendingBox" hidden>
      <h2>待处理介入</h2>
      <div class="body" id="pending"></div>
    </section>

    <section class="box">
      <h2>阶段时间线</h2>
      <div class="body" id="stages"><p class="empty">加载中…</p></div>
    </section>

    <section class="box">
      <h2>交付件</h2>
      <div class="body" id="artifacts"><p class="empty">加载中…</p></div>
    </section>

    <section class="box">
      <h2>提交</h2>
      <div class="body" id="commits"><p class="empty">加载中…</p></div>
    </section>

    <section class="box">
      <h2>介入记录</h2>
      <div class="body" id="interventions"><p class="empty">加载中…</p></div>
    </section>

    <p class="muted" id="rawLinks"></p>
  </div>
  <script>
    const TOKEN = ${tokenJson};
    const TASK_ID = ${taskIdJson};

    function withToken(path) {
      if (!TOKEN) return path;
      return path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
    }

    async function apiJson(path) {
      const res = await fetch(withToken(path), {
        headers: TOKEN ? { Authorization: "Bearer " + TOKEN } : {},
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!res.ok) throw new Error((body && body.error) || text || String(res.status));
      return body;
    }

    async function apiPost(path, body) {
      const res = await fetch(withToken(path), {
        method: "POST",
        headers: Object.assign({ "content-type": "application/json" },
          TOKEN ? { Authorization: "Bearer " + TOKEN } : {}),
        body: JSON.stringify(body || {}),
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      if (!res.ok) throw new Error((parsed && parsed.error) || text || String(res.status));
      return parsed;
    }

    async function apiText(path) {
      const res = await fetch(withToken(path), {
        headers: TOKEN ? { Authorization: "Bearer " + TOKEN } : {},
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || String(res.status));
      return text;
    }

    function escapeHtml(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function artifactUrl(key) {
      return withToken("/tasks/" + TASK_ID + "/artifacts/" + encodeURIComponent(key));
    }

    function fmtDuration(ms) {
      if (ms == null) return "—";
      if (ms < 1000) return ms + "ms";
      const s = Math.round(ms / 1000);
      if (s < 60) return s + "s";
      const m = Math.floor(s / 60);
      const rem = s % 60;
      if (m < 60) return m + "m" + (rem ? " " + rem + "s" : "");
      return Math.floor(m / 60) + "h " + (m % 60) + "m";
    }

    function fmtBytes(n) {
      if (n == null) return "—";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / 1024 / 1024).toFixed(1) + " MB";
    }

    function fmtTime(iso) {
      if (!iso) return "—";
      return String(iso).replace("T", " ").replace(/\\.\\d+Z?$/, "");
    }

    function fmtClock(iso) {
      return iso ? String(iso).slice(11, 19) : "";
    }

    let detail = null;
    let eventsCache = null;
    let eventsSeq = 0;
    const expanded = new Set();
    let timer = null;

    async function loadDetail() {
      detail = await apiJson("/tasks/" + TASK_ID + "/detail");
      render();
      scheduleReload();
    }

    function isLive() {
      const s = detail && detail.status;
      return s === "running" || s === "created" || s === "suspended";
    }

    function scheduleReload() {
      if (timer) clearTimeout(timer);
      document.getElementById("hRefresh").textContent = isLive() ? "5s 自动刷新" : "已结束";
      if (!isLive()) return;
      timer = setTimeout(() => { void reload(); }, 5000);
    }

    async function reload() {
      try {
        document.getElementById("pageError").textContent = "";
        await loadDetail();
      } catch (err) {
        document.getElementById("pageError").textContent = "加载失败: " + err.message;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { void reload(); }, 5000);
      }
    }

    function render() {
      renderHeader();
      renderMeta();
      renderPending();
      renderStages();
      renderArtifacts();
      renderCommits();
      renderInterventions();
      document.getElementById("rawLinks").innerHTML =
        '原始数据: <a href="' + withToken("/tasks/" + TASK_ID + "/detail") + '" target="_blank">detail JSON</a>' +
        ' · <a href="' + withToken("/tasks/" + TASK_ID + "/events?after=0") + '" target="_blank">events JSONL</a>' +
        ' · <a href="' + withToken("/tasks/" + TASK_ID) + '" target="_blank">snapshot</a>';
    }

    function renderHeader() {
      document.getElementById("hTask").textContent = detail.taskId;
      const pill = document.getElementById("hStatus");
      pill.textContent = detail.status;
      pill.className = "pill " + detail.status;
      document.getElementById("hNode").textContent = detail.currentNode
        ? "当前节点 " + detail.currentNode
        : "";
      document.getElementById("requirement").textContent = detail.requirement || "";
    }

    function metaRow(label, valueHtml) {
      return "<dt>" + escapeHtml(label) + "</dt><dd>" + valueHtml + "</dd>";
    }

    function renderMeta() {
      const g = detail.git || {};
      const u = detail.usage || {};
      let html = "";
      html += metaRow("pipeline", escapeHtml(detail.pipeline.name) +
        ' <span class="muted">' + escapeHtml(String(detail.pipeline.hash).slice(0, 12)) + "</span>");
      html += metaRow("分支", escapeHtml(g.branch || "—"));
      html += metaRow("仓库", escapeHtml(g.repoPath || "—"));
      html += metaRow("worktree", escapeHtml(g.worktreePath || "—"));
      html += metaRow("commit", escapeHtml(String(g.baseCommit || "").slice(0, 8) || "—") + " → " +
        escapeHtml(String(g.head || "").slice(0, 8) || "—") +
        (g.dirty ? ' <span class="pill waiting">worktree 有未提交改动</span>' : ""));
      html += metaRow("创建", escapeHtml(fmtTime(detail.createdAt)));
      html += metaRow("更新", escapeHtml(fmtTime(detail.updatedAt)));
      html += metaRow("耗时", escapeHtml(fmtDuration(detail.durationMs)) +
        ' <span class="muted">' + escapeHtml(fmtTime(detail.startedAt)) + " → " +
        escapeHtml(detail.endedAt ? fmtTime(detail.endedAt) : "进行中") + "</span>");
      html += metaRow("阶段", detail.stages.length + " 个");
      html += metaRow("引擎用量", (u.turns || 0) + " turns · in " + (u.inputTokens || 0) +
        " / out " + (u.outputTokens || 0) + " tokens" +
        (u.costUsd != null ? " · $" + u.costUsd.toFixed(4) : ""));
      html += metaRow("事件", detail.eventCount + " 条 (seq ≤ " + detail.lastSeq + ")");
      if (detail.error) {
        html += metaRow("错误", '<span class="error">' + escapeHtml(detail.error) + "</span>");
      }
      document.getElementById("meta").innerHTML = html;
    }

    function renderPending() {
      const box = document.getElementById("pendingBox");
      const p = detail.pendingIntervention;
      const suspended = detail.status === "suspended";
      if (!p && !suspended) { box.hidden = true; return; }
      box.hidden = false;

      let html = "";
      if (p) {
        html += '<div class="kv"><span class="k">kind</span><span class="v">' + escapeHtml(p.kind) + "</span></div>";
        html += '<div class="kv"><span class="k">节点</span><span class="v">' + escapeHtml(p.nodeId) + "</span></div>";
        html += '<div class="kv"><span class="k">说明</span><span class="v">' + escapeHtml(p.summary) + "</span></div>";
        html += '<div class="kv"><span class="k">requestId</span><span class="v">' + escapeHtml(p.requestId) + "</span></div>";
      } else {
        html += '<p class="muted">任务已挂起，但没有待处理的介入请求，可直接继续或终止。</p>';
      }
      html += '<div class="actions">';
      if (p) {
        html += '<input id="rejectMsg" placeholder="驳回意见（可选）" />';
        html += '<button id="btnApprove" type="button">Approve</button>';
        html += '<button id="btnReject" type="button">Reject</button>';
      }
      html += '<button id="btnResume" type="button">Resume</button>';
      html += '<button id="btnInject" type="button">Inject</button>';
      html += '<button id="btnAbort" type="button">Abort</button>';
      html += "</div>";
      html += '<p id="actionMsg" class="muted"></p>';
      document.getElementById("pending").innerHTML = html;

      const bind = (id, label, fn) => {
        const el = document.getElementById(id);
        if (el) el.onclick = () => void act(label, fn);
      };
      if (p) {
        bind("btnApprove", "Approve", () =>
          apiPost("/tasks/" + TASK_ID + "/interventions/" + encodeURIComponent(p.requestId),
            { action: "approve" }));
        bind("btnReject", "Reject", () => {
          const msg = document.getElementById("rejectMsg").value || "Rejected";
          return apiPost("/tasks/" + TASK_ID + "/interventions/" + encodeURIComponent(p.requestId), {
            action: "reject",
            comments: [{ id: "ui-reject", severity: "major", comment: msg, status: "open" }],
          });
        });
      }
      bind("btnResume", "Resume", () => apiPost("/tasks/" + TASK_ID + "/resume", {}));
      bind("btnAbort", "Abort", () => apiPost("/tasks/" + TASK_ID + "/abort", {}));
      bind("btnInject", "Inject", () => {
        const text = prompt("注入指令");
        if (!text) return Promise.resolve();
        return apiPost("/tasks/" + TASK_ID + "/instructions", { text });
      });
    }

    /** Surfaces failures — a silent button is indistinguishable from a dead one. */
    async function act(label, fn) {
      const box = document.getElementById("actionMsg");
      box.className = "muted";
      box.textContent = label + "…";
      try {
        await fn();
        box.textContent = label + " 已提交";
        await reload();
      } catch (err) {
        box.className = "error";
        box.textContent = label + " 失败: " + err.message;
      }
    }

    /** Compact one-line digest of a node outcome. */
    function outcomeSummary(outcome) {
      if (!outcome) return "";
      const parts = [];
      if (outcome.passed != null) parts.push("passed=" + outcome.passed);
      if (outcome.commentCount != null) parts.push("comments=" + outcome.commentCount);
      if (outcome.approved != null) parts.push("approved=" + outcome.approved);
      if (outcome.rejected) parts.push("rejected");
      if (outcome.skipped) parts.push("skipped");
      if (outcome.sha) parts.push("sha=" + String(outcome.sha).slice(0, 8));
      if (Array.isArray(outcome.checksRun) && outcome.checksRun.length) {
        parts.push("checks=" + outcome.checksRun.join(","));
      }
      if (Array.isArray(outcome.filesChanged)) parts.push("files=" + outcome.filesChanged.length);
      if (Array.isArray(outcome.failures) && outcome.failures.length) {
        parts.push("failures=" + outcome.failures.length);
      }
      if (outcome.summary) parts.push(String(outcome.summary));
      return parts.join(" · ");
    }

    function renderStages() {
      const root = document.getElementById("stages");
      if (!detail.stages.length) {
        root.innerHTML = '<p class="empty">尚无阶段记录。</p>';
        return;
      }
      root.innerHTML = "";
      for (const stage of detail.stages) {
        root.appendChild(stageCard(stage));
      }
    }

    function stageCard(stage) {
      const wrap = document.createElement("div");
      wrap.className = "stage " + stage.status;
      wrap.id = "stage-" + stage.index;

      const head = document.createElement("div");
      head.className = "head";
      let headHtml = '<span class="idx">#' + stage.index + "</span>";
      headHtml += '<span class="node">' + escapeHtml(stage.nodeId) + "</span>";
      headHtml += '<span class="tag">' + escapeHtml(stage.primitive) + "</span>";
      if (stage.loopLabel) headHtml += '<span class="tag">' + escapeHtml(stage.loopLabel) + "</span>";
      if (stage.nodeRun > 1) headHtml += '<span class="tag">第 ' + stage.nodeRun + " 次</span>";
      if (stage.engine) {
        headHtml += '<span class="muted">' + escapeHtml(stage.engine) +
          (stage.model ? " / " + escapeHtml(stage.model) : "") + "</span>";
      }
      headHtml += '<span class="grow"></span>';
      if (stage.artifacts.length) {
        headHtml += '<span class="muted">' + stage.artifacts.length + " 交付件</span>";
      }
      headHtml += '<span class="muted">' + escapeHtml(fmtClock(stage.startedAt)) + " · " +
        escapeHtml(fmtDuration(stage.durationMs)) + "</span>";
      headHtml += '<span class="pill ' + stage.status + '">' + stage.status + "</span>";
      head.innerHTML = headHtml;

      const body = document.createElement("div");
      body.className = "detail";
      body.hidden = !expanded.has(stage.index);
      head.onclick = () => {
        if (expanded.has(stage.index)) {
          expanded.delete(stage.index);
          body.hidden = true;
        } else {
          expanded.add(stage.index);
          body.hidden = false;
          void fillTrace(stage, body.querySelector(".trace"));
        }
      };

      body.innerHTML = stageBodyHtml(stage);
      wrap.appendChild(head);
      wrap.appendChild(body);
      if (!body.hidden) void fillTrace(stage, body.querySelector(".trace"));
      return wrap;
    }

    function stageBodyHtml(stage) {
      let html = "";
      const row = (k, v) => '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>";

      if (stage.error) html += row("错误", '<span class="error">' + escapeHtml(stage.error) + "</span>");
      const summary = outcomeSummary(stage.outcome);
      if (summary) html += row("结果", escapeHtml(summary));

      if (stage.artifacts.length) {
        let links = "";
        for (const a of stage.artifacts) {
          links += '<a class="chip" href="' + artifactUrl(a.key) + '" target="_blank">' +
            escapeHtml(a.key) + (a.ext ? "." + escapeHtml(a.ext) : ' <span class="muted">(缺失)</span>') +
            "</a>";
        }
        html += row("交付件", links);
      }

      if (stage.commits.length) {
        let commits = "";
        for (const c of stage.commits) {
          commits += '<div>' + escapeHtml(String(c.sha).slice(0, 8)) + " — " +
            escapeHtml(String(c.message).split("\\n")[0]) + "</div>";
        }
        html += row("提交", commits);
      }

      if (stage.interventions.length) {
        let items = "";
        for (const i of stage.interventions) {
          items += "<div>" + escapeHtml(i.kind) + ": " + escapeHtml(i.summary) +
            " → " + escapeHtml((i.decision && i.decision.action) || "待处理") +
            (i.waitedMs != null ? ' <span class="muted">等待 ' + escapeHtml(fmtDuration(i.waitedMs)) + "</span>" : "") +
            "</div>";
        }
        html += row("介入", items);
      }

      if (stage.retries.length) {
        let items = "";
        for (const r of stage.retries) {
          items += "<div>attempt " + r.attempt + ": " + escapeHtml(r.error) + "</div>";
        }
        html += row("重试", items);
      }

      if (stage.filesChanged.length) {
        html += row("改动文件", stage.filesChanged.map((f) => escapeHtml(f)).join("<br>"));
      }

      const bits = [];
      if (stage.usage) {
        bits.push(stage.usage.turns + " turns");
        bits.push("in " + stage.usage.inputTokens + " / out " + stage.usage.outputTokens);
      }
      if (stage.toolUseCount) bits.push(stage.toolUseCount + " 次工具调用");
      bits.push("seq " + stage.eventRange.from + "–" + stage.eventRange.to);
      html += row("统计", escapeHtml(bits.join(" · ")));

      if (stage.outcome && Object.keys(stage.outcome).length) {
        html += "<details style=\\"margin-top:10px\\"><summary class=\\"muted\\">outcome JSON</summary>" +
          '<pre class="text">' + escapeHtml(JSON.stringify(stage.outcome, null, 2)) + "</pre></details>";
      }

      html += '<div class="trace"><p class="empty">加载过程日志…</p></div>';
      return html;
    }

    /** Cached and topped up incrementally — the full log can be megabytes. */
    async function allEvents() {
      if (!eventsCache) { eventsCache = []; eventsSeq = 0; }
      if (eventsSeq < detail.lastSeq) {
        const data = await apiJson("/tasks/" + TASK_ID + "/events?after=" + eventsSeq);
        const fresh = data.events || [];
        if (fresh.length) {
          eventsCache = eventsCache.concat(fresh);
          eventsSeq = fresh[fresh.length - 1].seq;
        }
      }
      return eventsCache;
    }

    async function fillTrace(stage, root) {
      if (!root || root.dataset.filled === String(stage.eventRange.to)) return;
      try {
        const events = await allEvents();
        const slice = events.filter(
          (e) => e.seq >= stage.eventRange.from && e.seq <= stage.eventRange.to,
        );
        root.dataset.filled = String(stage.eventRange.to);
        root.innerHTML = "";
        if (!slice.length) {
          root.innerHTML = '<p class="empty">该阶段无事件。</p>';
          return;
        }
        let openBlock = null;
        for (const e of slice) {
          if (e.type === "engine.chunk") {
            const c = (e.payload && e.payload.chunk) || {};
            if (c.kind === "text" || c.kind === "thinking") {
              if (!openBlock || openBlock.kind !== c.kind) {
                const div = document.createElement("div");
                div.className = "ev " + c.kind;
                div.innerHTML = '<span class="ts">' + escapeHtml(fmtClock(e.ts)) + "</span>" +
                  '<span class="type">' + (c.kind === "thinking" ? "thinking" : "assistant") +
                  '</span><span class="body"></span>';
                root.appendChild(div);
                openBlock = { kind: c.kind, body: div.querySelector(".body") };
              }
              openBlock.body.textContent += c.text || "";
              continue;
            }
          }
          openBlock = null;
          const line = fmtEvent(e);
          if (!line) continue;
          const div = document.createElement("div");
          div.className = "ev";
          div.innerHTML = '<span class="ts">' + escapeHtml(fmtClock(e.ts)) + "</span>" +
            '<span class="type">' + escapeHtml(e.type) + "</span>" + escapeHtml(line);
          root.appendChild(div);
        }
      } catch (err) {
        root.innerHTML = '<p class="error">过程日志加载失败: ' + escapeHtml(err.message) + "</p>";
      }
    }

    function fmtEvent(e) {
      const p = e.payload || {};
      switch (e.type) {
        case "node.started": {
          const meta = [p.engine, p.model].filter(Boolean).join("/");
          return "▶ " + p.nodeId + " (" + p.primitive + (meta ? ", " + meta : "") + ")";
        }
        case "node.completed": return "✓ " + p.nodeId;
        case "node.retrying": return "retry " + p.attempt + ": " + p.error;
        case "loop.iteration": return "loop " + p.loopId + " " + p.iteration + "/" + p.maxIterations;
        case "engine.chunk": {
          const c = p.chunk || {};
          if (c.kind === "toolUse") return "  ⚙ " + c.tool + " " + (c.summary || "");
          if (c.kind === "fileChange") return "  ✎ " + c.path;
          return "";
        }
        case "engine.turn.completed": {
          const u = p.usage || {};
          return "turn done in=" + (u.inputTokens || 0) + " out=" + (u.outputTokens || 0);
        }
        case "artifact.created": return "artifact " + p.key;
        case "git.commit":
          return "commit " + String(p.sha || "").slice(0, 8) + " — " +
            String(p.message || "").split("\\n")[0];
        case "review.completed":
          return "review passed=" + p.passed + " comments=" + ((p.comments && p.comments.length) || 0);
        case "intervention.required": return "intervene " + p.kind + ": " + p.summary;
        case "intervention.resolved":
          return "intervene resolved " + ((p.decision && p.decision.action) || "");
        case "instruction.injected": return "inject " + p.text;
        case "task.failed": return "failed: " + p.error;
        case "task.suspended": return "suspended: " + (p.reason || "");
        case "log": return "[" + (p.level || "info") + "] " + p.message;
        default: return e.type;
      }
    }

    function renderArtifacts() {
      const root = document.getElementById("artifacts");
      if (!detail.artifacts.length) {
        root.innerHTML = '<p class="empty">暂无交付件。</p>';
        return;
      }
      let html = '<table class="files"><thead><tr><th>交付件</th><th>产出节点</th>' +
        "<th>大小</th><th>更新时间</th><th></th></tr></thead><tbody>";
      for (const a of detail.artifacts) {
        html += "<tr><td class=\\"mono\\"><a href=\\"" + artifactUrl(a.key) + "\\" target=\\"_blank\\">" +
          escapeHtml(a.key) + "." + escapeHtml(a.ext) + "</a></td>" +
          "<td>" + escapeHtml(a.producedByNodeId || "—") + "</td>" +
          "<td>" + escapeHtml(fmtBytes(a.size)) + "</td>" +
          "<td class=\\"mono\\">" + escapeHtml(fmtTime(a.mtime)) + "</td>" +
          '<td><button type="button" data-preview="' + escapeHtml(a.key) + '">预览</button></td></tr>';
      }
      html += "</tbody></table><div id=\\"preview\\"></div>";
      root.innerHTML = html;
      for (const btn of root.querySelectorAll("button[data-preview]")) {
        btn.onclick = () => void preview(btn.getAttribute("data-preview"));
      }
    }

    async function preview(key) {
      const box = document.getElementById("preview");
      box.innerHTML = '<p class="empty">加载 ' + escapeHtml(key) + "…</p>";
      try {
        const text = await apiText("/tasks/" + TASK_ID + "/artifacts/" + encodeURIComponent(key));
        let shown = text;
        try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not json */ }
        box.innerHTML = '<p class="muted" style="margin:12px 0 6px">' + escapeHtml(key) + "</p>" +
          '<pre class="text">' + escapeHtml(shown) + "</pre>";
      } catch (err) {
        box.innerHTML = '<p class="error">读取失败: ' + escapeHtml(err.message) + "</p>";
      }
    }

    function renderCommits() {
      const root = document.getElementById("commits");
      if (!detail.commits.length) {
        root.innerHTML = '<p class="empty">暂无提交。</p>';
        return;
      }
      let html = '<table class="files"><thead><tr><th>sha</th><th>节点</th>' +
        "<th>时间</th><th>message</th></tr></thead><tbody>";
      for (const c of detail.commits) {
        html += '<tr><td class="mono">' + escapeHtml(String(c.sha).slice(0, 8)) + "</td>" +
          "<td>" + escapeHtml(c.nodeId || "—") + "</td>" +
          '<td class="mono">' + escapeHtml(fmtClock(c.at)) + "</td>" +
          "<td>" + escapeHtml(String(c.message).split("\\n")[0]) + "</td></tr>";
      }
      html += "</tbody></table>";
      root.innerHTML = html;
    }

    function renderInterventions() {
      const root = document.getElementById("interventions");
      if (!detail.interventions.length) {
        root.innerHTML = '<p class="empty">全程无人工介入。</p>';
        return;
      }
      let html = '<table class="files"><thead><tr><th>kind</th><th>节点</th><th>说明</th>' +
        "<th>决定</th><th>等待</th></tr></thead><tbody>";
      for (const i of detail.interventions) {
        const decision = i.decision
          ? i.decision.action + (i.decision.note ? " (" + i.decision.note + ")" : "")
          : "待处理";
        html += "<tr><td>" + escapeHtml(i.kind) + "</td>" +
          "<td>" + escapeHtml(i.nodeId) + "</td>" +
          "<td>" + escapeHtml(i.summary) + "</td>" +
          "<td>" + escapeHtml(decision) + "</td>" +
          "<td>" + escapeHtml(i.waitedMs != null ? fmtDuration(i.waitedMs) : "—") + "</td></tr>";
      }
      html += "</tbody></table>";
      root.innerHTML = html;
    }

    document.getElementById("btnReload").onclick = () => void reload();

    // #stage-3 opens that stage directly, so a trace can be shared as a link.
    const hashStage = /^#stage-(\\d+)$/.exec(location.hash || "");
    if (hashStage) expanded.add(Number(hashStage[1]));

    void reload().then(() => {
      if (!hashStage) return;
      const el = document.getElementById("stage-" + hashStage[1]);
      if (el) el.scrollIntoView();
    });
  </script>
</body>
</html>`;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
