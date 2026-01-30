# AstrBot Docs Agent (GitHub App + Actions + OpenCode)

这个仓库提供一套**基于 GitHub Actions + GitHub App** 的自动化工作流：当 **AstrBot（代码仓库）** 出现新的 PR（或手动触发测试）时，自动拉取 PR 详情与描述，调用 **opencode（code agent）** 在 **文档仓库** 的最新提交基础上生成/更新文档，并在文档仓库创建一个等待人工审核的 PR；随后会回到代码仓库对应 PR 下自动回复“文档 PR 链接”。

## 你将得到什么

- 触发方式：
  - `workflow_dispatch`：手动输入“代码仓库 / 文档仓库 / PR 编号”用于测试。
  - 代码仓库 PR 触发：通过“调用本仓库的可复用工作流（reusable workflow）”实现。
- 工作流能力：
  - 使用 `npm` 安装 `opencode`
  - 写入 `opencode.json`，使用 `@ai-sdk/openai-compatible` 接入任何兼容 OpenAI REST 的第三方服务（`baseURL` + `apiKey` 来自 secrets）
  - 获取代码仓库 PR 的 title/body/files/diff 等上下文，发送给 code agent
  - 在文档仓库创建/更新分支并提交变更，创建文档 PR 等待人工审核
  - 在代码仓库 PR 下评论并附上文档 PR 链接

---

## 1) 创建 GitHub App（一次性）

建议权限（最小可用集）：

- **Code Repo（AstrBot）**
  - Repository permissions:
    - Pull requests: Read
    - Issues: Write（用于在 PR 下评论）
    - Metadata: Read
- **Docs Repo（文档仓库）**
  - Repository permissions:
    - Contents: Read & Write（推分支/提交）
    - Pull requests: Read & Write（创建文档 PR）
    - Metadata: Read

安装 GitHub App 到：代码仓库 + 文档仓库（都需要安装）。

---

## 2) 在“代码仓库”配置一个最小 Caller Workflow（自动触发）

在 AstrBot（代码仓库）里新增文件：

` .github/workflows/astrbot-docs-agent-caller.yml `

内容可直接复制本仓库的：`templates/code-repo-caller.yml`

然后把其中的 `uses: <OWNER>/<THIS_REPO>/.github/workflows/astrbot-docs-agent.yml@main` 改为你实际的仓库地址与分支/tag。

---

## 3) 配置 Secrets（在代码仓库里配置）

Caller workflow 会把 secrets 透传给可复用工作流。

### GitHub App 相关

- `GH_APP_ID`：GitHub App 的 App ID
- `GH_APP_PRIVATE_KEY`：GitHub App 的 Private Key（PEM）

### OpenCode 第三方模型提供商（openai-compatible）

- `OPENCODE_BASE_URL`：第三方 OpenAI-Compatible 的 `https://.../v1`
- `MY_API_KEY`：第三方的 API Key
- （可选）`OPENCODE_MODEL`：模型 ID（例如 `my-thirdparty/my-model`）。不填则使用 workflow 里的默认值。

仓库内也提供了参考配置：`opencode.json.example`

---

## 4) 手动测试（workflow_dispatch）

你可以在本仓库直接运行 `AstrBot Docs Agent` 工作流，输入：

- `code_repo`：如 `AstrBotDevs/AstrBot`
- `docs_repo`：如 `YourOrg/astrbot-docs`
- `pr_number`：如 `123`

---

## 常见注意事项

- **PR 来自 fork**：如果你用的是代码仓库的 `pull_request` 触发，并且 PR 来自 fork，仓库 secrets 可能不可用。此时建议把 Caller workflow 的触发改为 `pull_request_target`。可参考：`templates/code-repo-caller-pull_request_target.yml`
- **大 diff**：工作流会把 diff 截断到固定行数，避免上下文过大导致 agent 失败或成本过高。
