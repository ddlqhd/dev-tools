# codeloop

自动化 AI 开发工具：L1 内核（`codeloop`）+ L2 管理系统（platform）。编码引擎默认使用 **Cursor CLI**（`agent`）。

## 前置条件

- Node.js ≥ 22
- pnpm
- 已安装并登录 Cursor Agent CLI：`agent login`

## 开发

```bash
pnpm install
pnpm build
node packages/cli/dist/index.js doctor
```

## M3 管理系统

```bash
# 构建前端 + 后端
pnpm platform:build

# 启动平台（默认 http://127.0.0.1:4800）
pnpm platform:server

# 开发时热更新前端（代理到 :4800）
pnpm platform:web
```

配置见根目录 [`platform.config.yaml`](platform.config.yaml)：

- `GITHUB_TOKEN` — 可选；用于 poll issue / 推分支 / 开 PR
- `GITHUB_WEBHOOK_SECRET` — 生产环境建议设置；验签使用原始请求体
- `PLATFORM_TOKEN` — 可选；设置后 `/api/*` 需 Bearer（控制台：`localStorage.platformToken` 或构建时 `VITE_PLATFORM_TOKEN`；WebSocket 用 `?token=`）
- `codeloopBin` — 拉起内核的命令（默认指向本仓 CLI）

典型流程：

1. 打开控制台 →「仓库」接入（本地可填 Clone Path 指向已有 git 目录）
2. 「看板」手工创建任务，或给 GitHub issue 打 `ai-dev` 标签
3. 调度器拉起 `codeloop serve`，进度同步到看板；`waiting_human` 时可在详情页 Approve/Reject

Webhook：`POST /webhooks/github`（未配置 `GITHUB_WEBHOOK_SECRET` 时仅适合本地调试）

## L1 内核（M1/M2）

```bash
node packages/cli/dist/index.js run "实现 xxx" --repo /path/to/repo --no-gate
node packages/cli/dist/index.js serve --repo /path/to/repo --port 4700
```

详见 CLI `--help`。预置 pipeline：`default-codeloop` / `m1-minimal` / `quick-fix` / `plan-only` / `review-only`。

## 演进

- **M1** ✓ 最小闭环 + Cursor Adapter
- **M2** ✓ 完整编排、人工介入、serve 事件流
- **M3** ✓ 管理系统（调度 + GitHub PAT + 控制台）
- **M4** 多引擎 / 容器 Launcher / GitLab·Gitee
