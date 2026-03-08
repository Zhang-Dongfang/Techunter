# Techunter

> An AI-powered task distribution CLI for development teams. Manage GitHub Issues through a conversational terminal interface.

```
   ▗▄▄▄▄▖     Techunter v0.1.1
◆──▐████▌══▶  GLM-5 · zai-org
   ▝▀▀▀▀▘     owner/repo
```

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Setup](#setup)
- [Usage](#usage)
- [Task Lifecycle](#task-lifecycle)
- [Branch Naming](#branch-naming)
- [AI Agent Tools](#ai-agent-tools)
- [Development](#development)
- [Architecture](#architecture)
- [License](#license)

---

## Features

- **Conversational REPL** — Describe what you need in plain English; the Agent calls the right tools automatically
- **GitHub Issues integration** — Create, claim, submit, and close tasks; labels and assignees stay in sync
- **Automatic branch management** — Claiming a task creates and pushes the corresponding Git branch
- **Smart task guides** — Before you start, the Agent scans your codebase and posts a detailed implementation guide as an Issue comment
- **One-command delivery** — `/submit` lets the Agent review your changes against acceptance criteria, then commits and pushes; `/deliver` opens a PR and marks it as in-review
- **Slash commands** — Common actions don't need a description: just `/pick`, `/new`, `/submit`
- **Persistent conversation history** — Full context is retained across turns in the same REPL session

---

## Requirements

- Node.js ≥ 18
- A GitHub repository with Issues enabled
- GitHub Personal Access Token or OAuth Device Flow authorization
- [ppio.com](https://ppio.com) API Key (uses the GLM-5 model)

---

## Installation

```bash
npm install -g techunter
```

**Install from source (for development):**

```bash
git clone https://github.com/Zhang-Dongfang/Techunter.git
cd Techunter
npm install
npm run build
npm link          # registers the tch / techunter commands globally
```

---

## Setup

Run the one-time setup wizard inside any directory that has a GitHub remote:

```bash
tch init
```

The wizard will ask for:

1. **GitHub authentication** — A Personal Access Token is recommended
   - Create one at https://github.com/settings/tokens/new with `repo` and `read:user` scopes
2. **PPIO API Key** — Get yours from the [ppio.com](https://ppio.com) console → API Keys
3. **GitHub repository** — Auto-detected from your git remote, or enter manually

Config is stored at `~/.config/techunter/`.

---

## Usage

```bash
tch
```

Starts the conversational REPL. Type natural language or slash commands:

| Command | Alias | Description |
|---|---|---|
| `/help` | `/h` | Show all commands |
| `/refresh` | `/r` | Refresh the task list |
| `/pick` | `/p` | Browse and act on tasks interactively |
| `/new` | `/n` | Create a new task |
| `/close` | `/d` | Close (delete) a task |
| `/submit` | `/s` | Review changes for a task and commit + push |
| `/review` | `/rv` | Review team submissions — approve or request changes |
| `/status` | `/me` | Show tasks assigned to you |
| `/code` | `/c` | Launch Claude Code for the current task branch |

Any other input is sent to the AI Agent, for example:

```
> claim task #12
> create a task to add pagination to the user list
> what tasks are available right now?
> deliver the current task
```

---

## Task Lifecycle

Each GitHub Issue carries exactly one `techunter:*` label at a time:

```
techunter:available  →  techunter:claimed  →  techunter:in-review
     (green)                (yellow)               (blue)
                                                      ↓ rejected
                                           techunter:changes-needed
                                                     (red)
```

Labels are created automatically in your repository during `tch init` and when tasks are created.

---

## Branch Naming

A branch is created automatically when you claim a task:

```
task-{issue_number}-{your-github-username}
```

Example: Issue #7 claimed by `johndoe` → `task-7-johndoe`

---

## AI Agent Tools

The Agent can call the following tools:

| Tool | Description |
|---|---|
| `list_tasks` | List all open tasks |
| `get_task` | Get full details of a specific Issue |
| `create_task` | Create a new GitHub Issue |
| `claim_task` | Assign an Issue and create a local branch |
| `deliver_task` | Push the branch, open a PR, mark as in-review |
| `close_task` | Close a GitHub Issue |
| `post_comment` | Post a Markdown comment on an Issue |
| `scan_project` | Scan the project file tree and read key files |
| `read_file` | Read the contents of a specific file |
| `run_command` | Execute a shell command in the project root |
| `get_diff` | Get the current Git diff |
| `stage_and_commit` | Stage all changes, commit, and push |
| `ask_user` | Ask the user a question (max 3 times per task) |
| `get_my_status` | Show tasks assigned to the current user |
| `get_comments` | Read the latest comments on an Issue (e.g. rejection feedback) |
| `reject_task` | Reject an in-review task: post feedback and mark as changes-needed |

---

## Development

```bash
npm run dev        # Run directly with tsx (no build step)
npm run build      # Compile to dist/index.js
npm run typecheck  # Type-check without emitting files
```

---

## Architecture

```
tch
  └─ src/index.ts           Entry point, REPL, slash command dispatch
       └─ src/lib/agent.ts   AI tool-call loop
            ├─ src/lib/github.ts    Octokit — Issues, PRs, label management
            ├─ src/lib/git.ts       simple-git — branches, push, diff
            ├─ src/lib/project.ts   File tree + key file scanning (80 KB cap)
            └─ src/lib/config.ts    conf-based config store (~/.config/techunter/)
```

---

## License

[MIT](LICENSE)
