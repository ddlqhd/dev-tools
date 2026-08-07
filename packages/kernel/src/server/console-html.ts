/** Minimal live console served at GET / by `codeloop serve`. */
export function renderConsoleHtml(opts: { token?: string; repoPath: string }): string {
  const tokenJson = JSON.stringify(opts.token ?? "");
  const repoJson = JSON.stringify(opts.repoPath);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>codeloop console</title>
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
      font: 14px/1.45 var(--sans);
      min-height: 100vh; display: grid;
      grid-template-rows: auto 1fr;
    }
    header {
      display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
      padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
    }
    header h1 { font-size: 16px; margin: 0; letter-spacing: 0.02em; }
    header .meta { color: var(--muted); font-size: 12px; }
    .pill {
      font-size: 12px; padding: 2px 8px; border-radius: 999px;
      border: 1px solid var(--line); color: var(--muted);
    }
    .pill.on { color: var(--ok); border-color: #2a6b4f; background: #143528; }
    .pill.off { color: var(--bad); border-color: #6b2a32; background: #351418; }
    main {
      display: grid; grid-template-columns: 280px 1fr; min-height: 0;
    }
    @media (max-width: 800px) {
      main { grid-template-columns: 1fr; }
    }
    aside, section {
      min-height: 0; overflow: auto; border-right: 1px solid var(--line);
    }
    section { border-right: 0; display: flex; flex-direction: column; }
    h2 {
      margin: 0; padding: 10px 14px; font-size: 12px; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--muted); border-bottom: 1px solid var(--line);
      position: sticky; top: 0; background: var(--bg); z-index: 1;
    }
    .task {
      padding: 10px 14px; border-bottom: 1px solid var(--line); cursor: pointer;
    }
    .task:hover, .task.active { background: #1e2a3c; }
    .task .id { font-family: var(--mono); font-size: 12px; color: var(--accent); }
    .task .status { font-size: 12px; color: var(--muted); }
    .task .status.suspended { color: var(--warn); }
    .task .status.completed { color: var(--ok); }
    .task .status.failed, .task .status.aborted { color: var(--bad); }
    .task .req { margin-top: 4px; color: var(--text); font-size: 13px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    #log {
      flex: 1; overflow: auto; padding: 8px 0; font-family: var(--mono); font-size: 12px;
    }
    .ev { padding: 3px 14px; border-left: 2px solid transparent; white-space: pre-wrap; word-break: break-word; }
    .ev:hover { background: #152030; }
    .ev .ts { color: var(--muted); margin-right: 8px; }
    .ev .type { color: var(--accent); margin-right: 8px; }
    .ev.intervene { border-left-color: var(--warn); background: #2a2410; }
    .ev.node { border-left-color: #355a7a; }
    .ev.ok { border-left-color: var(--ok); }
    .ev.bad { border-left-color: var(--bad); }
    #intervene {
      display: none; padding: 12px 14px; border-top: 1px solid var(--line); background: #2a2410;
    }
    #intervene.show { display: block; }
    #intervene h3 { margin: 0 0 8px; font-size: 14px; color: var(--warn); }
    #intervene .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    button, textarea {
      font: inherit; border-radius: 6px; border: 1px solid var(--line); background: #0f1419; color: var(--text);
    }
    button { padding: 6px 12px; cursor: pointer; }
    button.primary { background: #1f5f3a; border-color: #2a8f57; }
    button.warn { background: #5f3a1f; border-color: #8f572a; }
    button.danger { background: #5f1f27; border-color: #8f2a38; }
    textarea { width: 100%; min-height: 56px; padding: 8px; resize: vertical; }
    .empty { padding: 24px 14px; color: var(--muted); }
  </style>
</head>
<body>
  <header>
    <h1>codeloop console</h1>
    <span class="pill" id="wsPill">ws: connecting</span>
    <span class="meta" id="repoMeta"></span>
    <span class="meta">事件来自 WebSocket <code>/stream</code>；人工介入用下方按钮或 CLI</span>
  </header>
  <main>
    <aside>
      <h2>Tasks</h2>
      <div id="tasks"><div class="empty">加载中…</div></div>
    </aside>
    <section>
      <h2>Live events <span id="filterLabel" style="text-transform:none;letter-spacing:0;font-weight:400"></span></h2>
      <div id="log"><div class="empty">等待事件…创建任务后这里会滚动输出。</div></div>
      <div id="intervene">
        <h3>需要人工介入</h3>
        <div id="interveneSummary"></div>
        <textarea id="rejectMsg" placeholder="reject 意见（可选）"></textarea>
        <div class="actions">
          <button class="primary" id="btnApprove">Approve</button>
          <button class="warn" id="btnReject">Reject</button>
          <button id="btnInject">Inject instruction</button>
          <button class="danger" id="btnAbort">Abort</button>
        </div>
      </div>
    </section>
  </main>
  <script>
    const TOKEN = ${tokenJson};
    const REPO = ${repoJson};
    const authHeaders = TOKEN ? { Authorization: "Bearer " + TOKEN } : {};
    document.getElementById("repoMeta").textContent = REPO;

    let filterTaskId = null;
    let pending = null; // { taskId, requestId, ... }

    async function apiJson(path, opts = {}) {
      let url = path;
      if (TOKEN) url += (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
      const res = await fetch(url, {
        ...opts,
        headers: { "content-type": "application/json", ...authHeaders, ...(opts.headers || {}) },
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!res.ok) throw new Error((body && body.error) || text || String(res.status));
      return body;
    }

    function fmtEvent(e) {
      const p = e.payload || {};
      switch (e.type) {
        case "task.created": return "created pipeline=" + (p.pipeline && p.pipeline.name);
        case "task.started": return "started";
        case "task.completed": return "completed";
        case "task.failed": return "failed: " + p.error;
        case "task.suspended": return "suspended: " + (p.reason || "");
        case "task.resumed": return "resumed @ " + p.nodeId;
        case "task.aborted": return "aborted";
        case "node.started": return "▶ " + p.nodeId + " (" + p.primitive + ")";
        case "node.completed": return "✓ " + p.nodeId;
        case "loop.iteration": return "loop " + p.loopId + " " + p.iteration + "/" + p.maxIterations;
        case "engine.chunk": {
          const c = p.chunk || {};
          if (c.kind === "toolUse") return "  ⚙ " + c.tool + " " + (c.summary || "");
          if (c.kind === "fileChange") return "  ✎ " + c.path;
          return "";
        }
        case "git.commit": return "commit " + String(p.sha || "").slice(0, 8) + " — " + String(p.message || "").split("\\n")[0];
        case "review.completed": return "review passed=" + p.passed + " comments=" + ((p.comments && p.comments.length) || 0);
        case "intervention.required": return "intervene " + p.kind + ": " + p.summary + " (" + p.requestId + ")";
        case "intervention.resolved": return "intervene resolved " + ((p.decision && p.decision.action) || "");
        case "instruction.injected": return "inject " + p.text;
        case "artifact.created": return "artifact " + p.key;
        case "log": return "log " + p.message;
        default: return e.type;
      }
    }

    function appendEvent(e) {
      if (filterTaskId && e.taskId !== filterTaskId) return;
      const line = fmtEvent(e);
      if (!line) return;
      const log = document.getElementById("log");
      if (log.querySelector(".empty")) log.innerHTML = "";
      const div = document.createElement("div");
      div.className = "ev";
      if (e.type.startsWith("intervention")) div.classList.add("intervene");
      else if (e.type === "node.started") div.classList.add("node");
      else if (e.type === "task.completed" || e.type === "node.completed") div.classList.add("ok");
      else if (e.type === "task.failed" || e.type === "task.aborted") div.classList.add("bad");
      const ts = (e.ts || "").slice(11, 19);
      div.innerHTML = '<span class="ts">' + ts + '</span><span class="type">' + e.type + '</span>' +
        '<span class="taskid" style="color:#8b9bb4;margin-right:8px">' + e.taskId + '</span>' +
        escapeHtml(line);
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;

      if (e.type === "intervention.required") {
        pending = { taskId: e.taskId, ...e.payload };
        showIntervene();
      }
      if (e.type === "intervention.resolved" && pending && pending.requestId === (e.payload && e.payload.requestId)) {
        pending = null;
        hideIntervene();
      }
      if (e.type.startsWith("task.") || e.type === "node.started" || e.type === "intervention.required") {
        void refreshTasks();
      }
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function showIntervene() {
      const box = document.getElementById("intervene");
      box.classList.add("show");
      document.getElementById("interveneSummary").textContent =
        (pending.kind || "") + " @ " + (pending.nodeId || "") + " — " + (pending.summary || "") +
        "\\nrequestId=" + (pending.requestId || "") + " task=" + (pending.taskId || "");
    }
    function hideIntervene() {
      document.getElementById("intervene").classList.remove("show");
    }

    async function refreshTasks() {
      try {
        const data = await apiJson("/tasks");
        const tasks = data.tasks || [];
        const root = document.getElementById("tasks");
        if (!tasks.length) {
          root.innerHTML = '<div class="empty">暂无任务。用 CLI：<br><code>codeloop run "..." --repo …</code></div>';
          return;
        }
        root.innerHTML = "";
        for (const t of tasks) {
          const el = document.createElement("div");
          el.className = "task" + (filterTaskId === t.id ? " active" : "");
          el.innerHTML =
            '<div class="id">' + t.id + '</div>' +
            '<div class="status ' + t.status + '">' + t.status +
              (t.current_node ? " · " + t.current_node : "") + "</div>" +
            '<div class="req">' + escapeHtml(t.requirement || "") + "</div>";
          el.onclick = () => {
            const next = filterTaskId === t.id ? null : t.id;
            filterTaskId = next;
            document.getElementById("filterLabel").textContent = filterTaskId ? ("· " + filterTaskId) : "";
            void refreshTasks();
            if (next) {
              void loadPending(next);
              void replayTaskEvents(next);
            }
          };
          root.appendChild(el);
        }
        // auto-surface first suspended intervention
        const sus = tasks.find((t) => t.status === "suspended");
        if (sus) void loadPending(sus.id);
      } catch (err) {
        document.getElementById("tasks").innerHTML = '<div class="empty">加载失败: ' + escapeHtml(err.message) + "</div>";
      }
    }

    async function loadPending(taskId) {
      try {
        const snap = await apiJson("/tasks/" + taskId);
        if (snap.pendingIntervention) {
          pending = { taskId, ...snap.pendingIntervention };
          showIntervene();
        }
      } catch { /* ignore */ }
    }

    async function replayTaskEvents(taskId) {
      try {
        const data = await apiJson("/tasks/" + taskId + "/events?after=0");
        const log = document.getElementById("log");
        log.innerHTML = "";
        const prev = filterTaskId;
        filterTaskId = null; // allow append during replay
        for (const e of (data.events || [])) appendEvent(e);
        filterTaskId = prev;
        if (!log.children.length) {
          log.innerHTML = '<div class="empty">该任务暂无事件记录</div>';
        }
      } catch (err) {
        document.getElementById("log").innerHTML =
          '<div class="empty">拉取历史失败: ' + escapeHtml(err.message) + "</div>";
      }
    }

    document.getElementById("btnApprove").onclick = async () => {
      if (!pending) return;
      await apiJson("/tasks/" + pending.taskId + "/interventions/" + pending.requestId, {
        method: "POST", body: JSON.stringify({ action: "approve" }),
      });
    };
    document.getElementById("btnReject").onclick = async () => {
      if (!pending) return;
      const msg = document.getElementById("rejectMsg").value || "Rejected";
      await apiJson("/tasks/" + pending.taskId + "/interventions/" + pending.requestId, {
        method: "POST",
        body: JSON.stringify({
          action: "reject",
          comments: [{ id: "ui-reject", severity: "major", comment: msg, status: "open" }],
        }),
      });
    };
    document.getElementById("btnInject").onclick = async () => {
      const taskId = (pending && pending.taskId) || filterTaskId;
      if (!taskId) { alert("先选一个任务"); return; }
      const text = prompt("注入指令");
      if (!text) return;
      await apiJson("/tasks/" + taskId + "/instructions", {
        method: "POST", body: JSON.stringify({ text }),
      });
    };
    document.getElementById("btnAbort").onclick = async () => {
      const taskId = (pending && pending.taskId) || filterTaskId;
      if (!taskId) return;
      await apiJson("/tasks/" + taskId + "/abort", { method: "POST", body: "{}" });
    };

    function connectWs() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      let url = proto + "//" + location.host + "/stream?verbose=true";
      if (TOKEN) url += "&token=" + encodeURIComponent(TOKEN);
      const ws = new WebSocket(url);
      const pill = document.getElementById("wsPill");
      ws.onopen = () => { pill.textContent = "ws: connected"; pill.className = "pill on"; };
      ws.onclose = () => {
        pill.textContent = "ws: disconnected (reconnect 2s)";
        pill.className = "pill off";
        setTimeout(connectWs, 2000);
      };
      ws.onerror = () => { pill.textContent = "ws: error"; pill.className = "pill off"; };
      ws.onmessage = (msg) => {
        try { appendEvent(JSON.parse(msg.data)); } catch { /* ignore */ }
      };
    }

    void refreshTasks();
    connectWs();
    setInterval(() => void refreshTasks(), 5000);
  </script>
</body>
</html>`;
}
