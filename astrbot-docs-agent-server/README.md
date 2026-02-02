# astrbot-docs-agent-server (GitHub App webhook + LangChain)

This service runs on your VPS (or anywhere with Docker) and does **not** rely on GitHub Actions for running the agent.

Flow:
1. Receive `pull_request` webhooks from your **code repo** (e.g. `AstrBotDevs/AstrBot`)
2. Fetch PR metadata + patch via GitHub API (installation token)
3. Clone the **docs repo** (e.g. `AstrBotDevs/AstrBot-docs`)
4. Run a LangChain-based agent that edits/creates docs files in the docs repo worktree
5. Commit + push a branch and open/update a docs PR
6. Comment the docs PR link back to the code PR

## Requirements

- A GitHub App installed on BOTH repos:
  - Code repo permissions: Pull requests (Read), Issues (Write), Metadata (Read)
  - Docs repo permissions: Contents (Read & Write), Pull requests (Read & Write), Metadata (Read)
- Docker (recommended) or Node.js 20+

## Configure

Copy `.env.example` to `.env` and fill:
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_FILE`
- `GITHUB_WEBHOOK_SECRET`
- `CODE_REPO` (or `CODE_REPOS`)
- `DOCS_REPO`
- LLM settings:
  - OpenAI-compatible: `LLM_PROVIDER=openai-compatible`, `LLM_API_KEY`, `LLM_MODEL`, `OPENAI_BASE_URL`
  - Gemini: `LLM_PROVIDER=gemini`, `GEMINI_API_KEY`, `GEMINI_MODEL`

## Run with Docker

```bash
cd astrbot-docs-agent-server
docker compose up -d
```

Healthcheck:
```bash
curl http://127.0.0.1:8787/healthz
```

Queue status:
```bash
curl http://127.0.0.1:8787/queue
```

## Webhook URL

Set your GitHub App webhook URL to:
`http(s)://<your-domain-or-ip>/webhooks/github`

## Notes

- The agent is restricted: it can only write `*.md/*.mdx` and VitePress config under `.vitepress/`, and it cannot touch `.github/`.
- For safety, the server never checks out PR code or executes anything from the code PR; it only uses PR metadata + patch.

