# Techunter / 科技猎人

> AI 驱动的任务分发与协作平台。CLI 与 Web/Electron 是两个并列应用，共用同一套 Agent、仓库读取和任务约定。

- [`apps/cli`](apps/cli)：终端 REPL 与 MCP 服务
- [`apps/api`](apps/api)：Railway 中央控制面，连接 Supabase、Conexus 与 GitHub
- [`apps/desktop`](apps/desktop/README.md)：企业内部 Web + Electron 本机 Agent
- [`packages/core`](packages/core)：两个应用复用的 Agent 与领域核心

```
    ╔═══════════════╗
◆═══╬   TECHUNTER   ╬═══▶
    ╚═══════════════╝
```

<!-- demo GIF goes here -->

---

## Why Techunter?

Most teams manage tasks in GitHub Issues but switch between multiple tools to actually act on them. Techunter closes that gap:

| Without Techunter | With Techunter |
|---|---|
| Manually write Issue descriptions | `/new` → AI scans your codebase and generates a full implementation guide |
| Browse Issues in the browser, create branches by hand | `/pick` → select a task, branch is created and pushed automatically |
| Write PR descriptions, update labels manually | `/submit` → AI reviews your changes against acceptance criteria, then commits and opens the PR |
| Back-and-forth review comments | `/accept` or `/reject` with AI-generated feedback |

---

## Installation

```bash
npm install -g techunter
```

**Install from source:**

```bash
git clone https://github.com/Zhang-Dongfang/Techunter.git
cd Techunter
npm install
npm run build
npm link ./apps/cli
```

---

## Quick Start

Run the one-time setup wizard inside any directory with a GitHub remote:

```bash
tch init
```

The wizard will prompt for:
1. **GitHub auth** — Browser OAuth (recommended) or a Personal Access Token (`repo` + `read:user` scopes)
2. **AI provider** — Conexus account mode (per-user usage and logs), OpenRouter, or another OpenAI-compatible endpoint
3. **Repository** — auto-detected from your git remote

Then start the REPL:

```bash
tch
```

---

## Workflow

### 1. Create a task

```
You › /new
? Task title: Add email verification on signup

⠋ Scanning project and generating guide…

  ## Goal
  Send a verification email after user registration.

  ## Acceptance Criteria
  - [ ] POST /auth/register sends a verification email
  - [ ] Email contains a signed token with 24h expiry
  - [ ] GET /auth/verify/:token activates the account
  - [ ] Unverified users cannot access protected routes

  ## Implementation Notes
  - Use nodemailer (already in package.json)
  - See existing token pattern in src/lib/auth.ts
  - Add `verified` boolean column to users table

? Create this task?  ❯ Yes, create task
```

### 2. Claim a task

```
You › /pick

? Select a task:
  #14   available   Add email verification on signup
❯ #11   available   Fix login redirect bug

  #11  Fix login redirect bug         available
  After OAuth login, users are redirected to /home
  instead of their original destination URL.

? Action:  ❯ Claim this task

✔ Claimed! Branch: worker-johndoe  (base: a3f92c1)

? Open Claude Code for this task?  ❯ Yes, start coding now
```

### 3. Submit when done

```
You › /submit

⠋ Reviewing changes against acceptance criteria…

  ✅ Return URL stored in session before redirect
  ✅ Redirects to return URL after successful login
  ✅ Falls back to /dashboard when no return URL
  ⚠️  Consider validating return URL to prevent open redirect

? Submit task #11?  ❯ Yes, submit

✔ Committed and pushed
✔ PR created: https://github.com/myorg/my-project/pull/8
✔ Marked as in-review
```

### 4. Review and accept

```
You › /review     # see all in-review PRs
You › /accept     # merge PR, close issue, release branch
```

---

## Commands

| Command | Alias | Description |
|---|---|---|
| `/help` | `/h` | Show all commands |
| `/new` | `/n` | Create a task — AI generates an implementation guide |
| `/pick` | `/p` | Browse tasks and claim one |
| `/submit` | `/s` | AI-review changes, commit, push, open PR |
| `/review` | `/rv` | List tasks waiting for your approval |
| `/accept` | `/ac` | Merge PR and close issue |
| `/status` | `/me` | Show tasks assigned to you |
| `/edit` | `/e` | Edit a task title or description |
| `/close` | `/d` | Close (delete) a task |
| `/refresh` | `/r` | Reload the task list |
| `/code` | `/c` | Open Claude Code for the current task branch |
| `/wiki` | `/w` | Generate or refresh `TECHUNTER.md` project overview |
| `/config` | `/cfg` | Change settings (repo, API keys, model) |
| `/init` | | Re-run the setup wizard |

Any other input is sent to the AI agent:

```
You › what tasks are available?
You › claim the task about login redirect
You › create a task to add pagination to the user list
```

---

## Task Lifecycle

Issues carry exactly one `techunter:*` label at a time:

```
techunter:available  →  techunter:claimed  →  techunter:in-review
                                                      ↓  (if rejected)
                                           techunter:changes-needed
```

Labels are created automatically in your repository during `tch init`.

---

## Branch Naming

Each user has a persistent **worker branch** created when they first claim a task:

```
worker-{github-username}
```

Task branches submitted as PRs follow:

```
task-{issue_number}-{first-five-words-of-title}
```

---

## MCP Server

Techunter ships a Model Context Protocol server that exposes all tools to any MCP-compatible client (e.g. Claude Desktop):

```bash
tch-mcp
```

---

## Development

首次启动共享控制面前：

```powershell
Copy-Item .env.example .env
npm install
npm run dev          # 启动 API、Web 和 Electron 桌面端
npm run dev:cli      # 在当前仓库启动 CLI
npm run typecheck    # 检查全部 workspace
npm test             # 运行中央 API 与本机 Agent 测试
npm run build        # 构建 core、CLI、Railway API 和 desktop
```

还需要先应用 `infra/supabase` 迁移；完整顺序见 [`apps/api/README.md`](apps/api/README.md)。

To verify end-to-end: build and run `tch init` in a directory with a GitHub remote.

---

## Architecture

```
packages/core
  ├─ Agent runtime / prompts
  ├─ repository tools
  └─ task and GitHub conventions
       ↑                         ↑
apps/cli                 apps/api                    apps/desktop
  ├─ terminal + MCP        ├─ Railway Fastify API      ├─ React Web UI
  └─ CLI workflows         ├─ Supabase.techunter       └─ Electron 本机 Agent
                           └─ GitHub / Conexus
```

CLI 工具位于 `apps/cli/src/tools/{name}/index.ts`；桌面端说明见 [apps/desktop/README.md](apps/desktop/README.md)，完整开发约定见 [CLAUDE.md](CLAUDE.md)。

---

## License

[MIT](LICENSE)
