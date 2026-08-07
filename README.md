# codeloop

自动化 AI 开发内核（L1）：需求 → 计划 → 编码 → 提交。编码引擎默认使用 **Cursor CLI**（启动命令：`agent`）。

## 前置条件

- Node.js ≥ 22
- pnpm
- 已安装并登录 Cursor Agent CLI：`agent`（`agent login`）

## 开发

```bash
pnpm install
pnpm build
pnpm --filter @devtools/cli exec codeloop doctor
```

在任意 git 仓库中运行：

```bash
# 链接 CLI（可选）
pnpm --filter @devtools/cli exec codeloop run "添加 README 中的 Hello 段落" --repo /path/to/repo --no-gate

# 或直接
node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js run "实现 xxx" --pipeline m1-minimal --no-gate
```

## M1 范围

- 引擎：仅 Cursor（`agent -p --output-format stream-json`）
- 默认 pipeline：`m1-minimal`（plan → code → commit）
- 内置完整模板 `default-codeloop` / `quick-fix`（含评审环，可选用）
- 本地 `.codeloop/`：SQLite + JSONL + worktree
- 尚无：`codeloop serve`、管理系统（L2）、多引擎

## 配置

仓库下 `.codeloop/config.yaml`（首次运行自动生成）：

```yaml
version: 1
pipeline: m1-minimal
engines:
  default:
    type: cursor
    # model: sonnet   # 可选，传给 agent --model
```

环境变量：

- `CODELOOP_CURSOR_BIN` — 覆盖 CLI 二进制名（默认 `agent`）
