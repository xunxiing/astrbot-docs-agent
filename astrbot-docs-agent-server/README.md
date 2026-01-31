# astrbot-docs-agent-server (VPS + Docker)

用 VPS 跑一个常驻服务，**不依赖 GitHub Actions**：

- GitHub App 接收 `pull_request` webhook（来自代码仓库，例如 AstrBot）
- 拉取 PR 详情/描述/diff
- 在文档仓库工作区运行 `opencode` 自动改文档
- 推送分支并创建文档 PR（等待人工审核）
- 回到代码仓库 PR 下评论文档 PR 链接

## 1) 你需要准备

### GitHub App（一次性）

创建 GitHub App，并安装到：
- 代码仓库（AstrBot）
- 文档仓库（你的 docs repo）

建议权限（最小可用集）：

- **Code Repo（AstrBot）**
  - Pull requests: Read
  - Issues: Write（用于 PR 评论）
  - Metadata: Read
- **Docs Repo**
  - Contents: Read & Write（推分支/提交）
  - Pull requests: Read & Write（创建 docs PR）
  - Metadata: Read

Webhook：
- URL：`http(s)://<你的服务器IP或域名>/webhooks/github`
- Secret：自定义一个随机串（用于签名校验）
- 订阅事件：`Pull request`

> 如果你只有 IP 没域名：建议用 HTTP + 在 GitHub webhook 设置里关闭 SSL 校验，或给 VPS 绑一个域名配 HTTPS（推荐）。

---

## 2) 配置环境变量

复制一份：`.env.example` → `.env`

关键变量：

- `GITHUB_APP_ID`：GitHub App ID
- `GITHUB_APP_PRIVATE_KEY`：GitHub App 私钥 PEM 内容（注意换行）
- `GITHUB_WEBHOOK_SECRET`：GitHub App webhook secret
- `CODE_REPO`：代码仓库 `owner/repo`（例如 `AstrBotDevs/AstrBot`）
- `DOCS_REPO`：文档仓库 `owner/repo`
- `OPENCODE_BASE_URL`：第三方 OpenAI-compatible `https://.../v1`
- `MY_API_KEY`：第三方 API key
- `OPENCODE_PROVIDER_ID`：openai-compatible provider id（随便起一个名字，默认 `my-thirdparty`）
- `OPENCODE_MODEL`：模型标识（推荐直接填“模型 ID”，例如 `kimi-k2.5`；也支持 `provider/model`）
- `OPENCODE_API_URL`：（可选）如果你的服务不是标准 OpenAI `/v1`，可直接指定完整的 `.../chat/completions` URL
- `OPENCODE_VARIANT`：OpenCode 变体（默认 `minimal`，用于避免某些服务在 thinking 模式下要求 `reasoning_content` 导致报错）
- `MAX_CONCURRENT_JOBS`：并发处理 PR 的数量（建议 `1`）
- `MAX_QUEUE_SIZE`：队列长度上限（防止短时间 webhook 风暴拖垮 VPS）
- `JOB_TIMEOUT_SECONDS`：单个任务超时（超过会强杀 `opencode`/`git` 子进程）
- `MAX_PATCH_LINES`：发送给 agent 的 patch 最大行数（过大会显著增加 CPU/内存/费用）

### 私钥换行怎么填（建议方式）

推荐把 PEM 私钥保存成服务器上的一个文件，然后通过 `GITHUB_APP_PRIVATE_KEY_FILE` 让服务读取：

1) 把私钥保存为：`./secrets/app.private-key.pem`
2) 在 `.env` 里写：

```bash
GITHUB_APP_PRIVATE_KEY_FILE=/secrets/app.private-key.pem
```

`docker-compose.yml` 已默认把 `./secrets` 只读挂载到容器的 `/secrets`。

---

## 3) Docker 部署

在服务器上：

```bash
cd astrbot-docs-agent-server
cp .env.example .env
docker compose up -d
```

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

队列观察（可选）：

```bash
curl http://127.0.0.1:8787/queue
```

## 5) 反代 / HTTPS（推荐）

GitHub webhook 更推荐 HTTPS。最省心的是给 VPS 绑一个域名，然后用 Caddy / Nginx + Let's Encrypt。

如果你只有 IP：
- 可以先用 HTTP（80 端口）并在 GitHub webhook 设置里关闭 SSL 校验（不推荐长期这样用）
- 或者用隧道（Cloudflare Tunnel / frp）给你一个 HTTPS 入口

---

## 4) 工作方式（服务做了什么）

- 收到 `pull_request` 的 `opened/reopened/synchronize/edited` 事件
- 通过 GitHub App installation token 调用 GitHub API：
  - 获取 PR 信息与文件列表
  - 拉取 PR patch（截断）
- `git clone` 文档仓库默认分支
- 写入 PR 上下文文件 `./.opencode/pr_context.md`
- 运行：
  - `opencode run -f .opencode/pr_context.md "<prompt>"`
- 若仓库有变更：提交、推送分支、创建/复用 docs PR
- 在代码仓库 PR 下评论 docs PR 链接

---

## 安全建议（重要）

- 服务默认只处理 `CODE_REPO` 指定的代码仓库（防止 webhook 被滥用）。
- 不会 checkout PR 代码，也不会执行来自 PR 的任何内容，只使用 API 元数据 + diff。
- 建议把 webhook 入口放在反代后面，并加上基础的限流/防火墙规则。
