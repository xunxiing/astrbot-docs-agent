# GitHub App: Auto Documentation Agent Plan

## 1. 概览 (Overview)
本方案将构建一个独立的 GitHub 仓库，利用 GitHub Actions 定时监控上游代码仓库 (`AstrBot`) 的 Pull Request。当发现新的 PR 时，自动调用 `opencode` 生成对应的文档更新，并提交到文档仓库。

## 2. 架构设计 (Architecture)

### 2.1 触发机制
由于无法修改上游代码仓库，我们将采用 **Polling (轮询)** 机制：
- **Schedule**: 每 15 分钟运行一次 Workflow。
- **Filter**: 检查代码仓库中**所有 Open 状态的 PR**。
- **State Check**: 检查 PR 下是否已有本 Bot 发送的 "文档正在生成中" 或 "文档 PR 已提交" 的评论。如果没有，则视为新 PR 进行处理。

### 2.2 工作流逻辑
```mermaid
graph TD
    A[Start: Schedule / Manual] --> B[Authenticate GitHub App]
    B --> C[List Open PRs from AstrBot]
    C --> D{Iterate PRs}
    D -->|No more PRs| End[End Workflow]
    D -->|Next PR| E{Processed?}
    E -->|Yes (Bot Comment Found)| D
    E -->|No| F[Fetch PR Details\n(Title, Body, Diff)]
    F --> G[Checkout Docs Repo]
    G --> H[Generate opencode.json\n(Inject API Key)]
    H --> I[Run OpenCode Agent\n(Input: PR Context)]
    I --> J{Changes Generated?}
    J -->|No| K[Log: No updates needed]
    J -->|Yes| L[Commit & Push Branch\nto Docs Repo]
    L --> M[Create PR in Docs Repo]
    M --> N[Comment on AstrBot PR\n(Link to Doc PR)]
    N --> D
```

## 3. 详细实施步骤 (Implementation Steps)

### 3.1 仓库初始化
- 创建 `package.json`: 包含依赖 `@actions/core`, `@actions/github`, `simple-git`, `@ai-sdk/openai-compatible` 以及 `opencode` (假设为 CLI 工具).
- 创建 `tsconfig.json`: TypeScript 配置.

### 3.2 核心脚本 (`src/index.ts`)
该脚本将作为 Action 的核心执行体，负责：
1.  **认证**: 使用 App ID + Private Key 获取 Installation Token。
2.  **获取 PR**: 调用 GitHub API 获取 AstrBot 的 PR 列表。
3.  **生成上下文**: 将 PR 的 Title, Body, 和 Diff 也就是代码变更内容保存为 context 文件 (例如 `pr_context.md`)。
4.  **配置 OpenCode**: 动态生成 `opencode.json`，填入 API BaseURL 和 Key。
5.  **执行 OpenCode**: 调用 `npx opencode` (或其他调用方式)，指定 context 文件和文档目录。
6.  **提交更改**: 使用 `git` 操作提交生成的文档变更。
7.  **反馈**: 调用 GitHub API 在原 PR 下评论。

### 3.3 GitHub Workflow (`.github/workflows/auto-doc.yml`)
- **Triggers**:
  - `schedule`: `cron: '*/15 * * * *'`
  - `workflow_dispatch`: 允许手动测试 (输入 PR ID).
- **Steps**:
  - Checkout Agent Repo.
  - Checkout Docs Repo (path: `docs-repo`).
  - Setup Node.js.
  - Install Dependencies.
  - Run `src/index.ts`.

## 4. 需要的用户配置 (Secrets)
您需要在本仓库配置以下 Secrets:
- `APP_ID`: GitHub App 的 ID.
- `APP_PRIVATE_KEY`: GitHub App 的私钥.
- `APP_INSTALLATION_ID`: (可选，或脚本自动获取) App 安装 ID.
- `OPENAI_API_KEY`: 第三方 LLM 服务的 API Key.
- `API_BASE_URL`: (可选) 第三方 API 地址，如果固定可在代码中硬编码.

## 5. 待确认事项
- `opencode` 的具体 CLI 命令是否为 `opencode run` 或其他？请你确认
- 确认 GitHub App 拥有read Code Repo和**Write** (Pull Requests) 的权利
