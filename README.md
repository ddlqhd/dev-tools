# codeloop

自动化 AI 开发内核（L1）：按可编排 pipeline 跑 计划 → 评审 → 编码 → 检视 → 提交。编码引擎默认使用 **Cursor CLI**（启动命令：`agent`）。

## 前置条件

- Node.js ≥ 22
- pnpm
- 已安装并登录 Cursor Agent CLI：`agent`（`agent login`）

## 开发

```bash
pnpm install
pnpm build
node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js pipelines
```

## M2 能力

| 能力 | 说明 |
|---|---|
| 完整 pipeline | 默认 `default-codeloop`；另有 `m1-minimal` / `quick-fix` / `plan-only` / `review-only` |
| 人工审批门 | `run` 交互 Approve/Reject/Edit；或 `approve` / `reject` |
| 指令注入 | `inject <taskId> -m "..."` |
| 暂停/恢复/中止 | `pause` / `resume` / `abort`（需 checkpoint；推荐配合 serve） |
| 守护进程 | `codeloop serve`：HTTP 控制 API + WebSocket 事件流 |

## 常用命令

```bash
# 本地跑完整闭环（遇到 gate 会交互询问）
node packages/cli/dist/index.js run "实现 xxx" --repo /path/to/repo

# 跳过审批门
node packages/cli/dist/index.js run "小改动" --pipeline quick-fix --no-gate

# 守护模式（另一终端控制）
node packages/cli/dist/index.js serve --repo /path/to/repo --port 4700
node packages/cli/dist/index.js run "实现 xxx" --repo /path/to/repo   # 自动转发到 serve
node packages/cli/dist/index.js watch <taskId>
node packages/cli/dist/index.js approve <taskId>
node packages/cli/dist/index.js reject <taskId> -m "改用方案 B"
node packages/cli/dist/index.js inject <taskId> -m "不要动 legacy/"
node packages/cli/dist/index.js pause|resume|abort <taskId>
```

## 控制 API（`codeloop serve`）

默认 `http://127.0.0.1:4700`，锁文件 `.codeloop/kernel.lock`。

- `POST /tasks` — 创建并启动任务
- `GET /tasks/:id` — 快照（含 pending intervention）
- `POST /tasks/:id/pause|resume|abort`
- `POST /tasks/:id/instructions` — `{ text }`
- `POST /tasks/:id/interventions/:reqId` — 审批决定
- `GET /tasks/:id/events?after=seq`
- `WS /tasks/:id/stream` · `WS /stream`

## 配置

仓库下 `.codeloop/config.yaml`（首次运行自动生成）：

```yaml
version: 1
pipeline: default-codeloop
engines:
  default:
    type: cursor
  reviewer:
    type: cursor
```

环境变量：

- `CODELOOP_CURSOR_BIN` — 覆盖 CLI 二进制名（默认 `agent`）

## 演进

- **M1** ✓ 最小闭环 + Cursor Adapter
- **M2** ✓ 完整编排、人工介入、serve 事件流
- **M3** 管理系统（调度 + GitHub + 控制台）
