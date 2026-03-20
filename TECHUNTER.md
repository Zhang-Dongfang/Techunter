# Techunter

> AI-powered task distribution CLI for development teams that manages GitHub Issues through a conversational terminal interface and MCP tools.

## What Is This?

Techunter is a TypeScript/Node.js CLI that turns GitHub Issues into an AI-assisted team workflow. Instead of bouncing between GitHub, git, a terminal, and an AI chat window, developers can stay inside `tch` and create tasks, claim work, review diffs, submit pull requests, and approve or reject changes. The project’s core idea is that task management should be tightly coupled to the codebase and repository state, not handled as a separate browser-only process.

The primary users are software teams already using GitHub Issues and pull requests. A repo collaborator can run `tch init` once to connect GitHub and an OpenAI-compatible model provider, then use the REPL in `src/index.ts` for both slash commands and natural-language requests. Team leads can create richer implementation-ready tasks with `/new`; individual developers can claim work with `/pick`; reviewers can inspect and merge work with `/review`, `/accept`, and `/reject`.

A distinguishing feature is that Techunter does not just store tasks — it actively orchestrates git and GitHub operations. It creates and enforces `techunter:*` labels, manages per-user worker branches like `worker-{github-username}`, generates task guides by scanning the repository, reviews diffs before submission, and opens PRs automatically. It also ships an MCP server (`tch-mcp`) in `src/mcp.ts`, exposing the tool layer to external MCP-compatible clients.

Architecturally, the project combines two interaction styles: direct command flows and tool-driven agent flows. Slash commands call interactive `run()` functions in `src/tools/*`, while freeform text goes through `runAgentLoop()` in `src/lib/agent.ts`, where the LLM selects from registered tools in `src/tools/registry.ts`. That split lets the product keep predictable UX for critical workflows while still supporting conversational task handling.

## Quick Start

1. **Install dependencies and build the CLI**
   ```bash
   npm install
   npm run build
   ```
   For local global usage during development:
   ```bash
   npm link
   ```
   This exposes `tch`, `techunter`, and `tch-mcp` from the `bin` section in `package.json`.

2. **Make sure you are inside a git repository with a GitHub `origin` remote**
   Techunter auto-detects the repository using `getRemoteUrl()` and `parseOwnerRepo()` in `src/lib/git.ts`. If no remote is found, setup will ask for owner/repo manually.

3. **Run the setup wizard**
   ```bash
   tch init
   ```
   The wizard in `src/commands/init.ts` will prompt for:
   - GitHub auth via OAuth device flow or PAT
   - AI provider: OpenRouter by default (`https://openrouter.ai/api/v1`, model `z-ai/glm-5`)
   - API key
   - Repository owner/name if auto-detection fails

4. **Verify configuration and label setup**
   During init, Techunter stores config through `conf` in `src/lib/config.ts` and calls `ensureLabels()` from `src/lib/github.ts` to create:
   - `techunter:available`
   - `techunter:claimed`
   - `techunter:in-review`
   - `techunter:changes-needed`

5. **Start the REPL**
   ```bash
   tch
   ```
   On startup, the CLI prints the banner, current model, and detected repo, then shows the task list and your assigned tasks.

6. **Try a full workflow**
   ```text
   /new     -> create an issue with an AI-generated implementation guide
   /pick    -> claim a task and switch/create your worker branch
   /submit  -> review changes, commit, push, and create a PR
   /review  -> inspect tasks awaiting approval
   /accept  -> merge and close approved work
   ```

## Architecture

Techunter is structured around a thin CLI shell, a shared service layer, and a tool registry consumed by both the REPL agent and the MCP server.

- **Entry points**
  - `src/index.ts`: main CLI entrypoint for `tch` / `techunter`
  - `src/mcp.ts`: stdio MCP server for `tch-mcp`
- **Command layer**
  - Interactive workflows live in `src/tools/*/index.ts`
  - Setup/config flows live in `src/commands/*.ts`
- **Service layer**
  - `src/lib/github.ts`: all Octokit-based GitHub operations
  - `src/lib/git.ts`: branching, diffs, commit/push, repo detection
  - `src/lib/client.ts`: OpenAI-compatible client creation and model selection
  - `src/lib/config.ts`: persisted local config and task state
- **Agent layer**
  - `src/lib/agent.ts`: main natural-language loop using tool calls
  - `src/lib/sub-agent.ts`: helper loop for specialized sub-agents
  - `src/tools/registry.ts`: central list of all available tools

Request/data flow looks like this:

```text
tch
 └─ src/index.ts
    ├─ slash command like /pick or /submit
    │   └─ calls tool run() directly for interactive terminal UX
    └─ natural language input
        └─ runAgentLoop() in src/lib/agent.ts
            ├─ builds tool list from src/tools/registry.ts
            ├─ sends system prompt + history to LLM
            ├─ executes selected tools
            └─ returns final assistant response
```

There is a second, smaller tool-execution path for specialized generation tasks. `new-task/guide-generator.ts`, `submit/reviewer.ts`, `reject/comment-generator.ts`, and `wiki/wiki-generator.ts` all use `runSubAgentLoop()` with a restricted tool set. For example, the wiki generator can only use `list_files`, `grep_code`, and `run_command`, which keeps these sub-agents focused and easier to reason about.

A notable design decision is the separation between **command tools** and **low-level reasoning tools**. Command tools like `pick`, `new_task`, `submit`, and `accept` represent stable product workflows and are marked `terminal = true` so the agent exits after the action. Low-level tools like `list_files`, `grep_code`, `run_command`, `get_task`, and `get_diff` support reasoning and analysis. This prevents the LLM from improvising critical operational flows that should stay deterministic.

GitHub task state is encoded in labels, while local in-progress state is stored in config. When a developer claims a task, `src/tools/pick/index.ts` updates GitHub labels and assignee, switches to or creates a worker branch, records `taskState.activeIssueNumber`, and captures a base commit. Later, `src/tools/submit/index.ts` uses that stored base commit to compute a focused diff with `getDiffFromCommit()` before generating review output and creating the PR.

## Key Files

| File / Directory | Purpose |
|---|---|
| `package.json` | Project metadata, CLI binaries (`techunter`, `tch`, `tch-mcp`), scripts, and runtime dependencies. |
| `README.md` | User-facing overview of installation, command workflow, task lifecycle, branch naming, and MCP usage. |
| `CLAUDE.md` | Maintainer/developer architecture notes, tool taxonomy, build constraints, and key file map. |
| `src/index.ts` | Main CLI REPL: startup, config bootstrapping, repo auto-detection, slash command dispatch, and agent handoff. |
| `src/mcp.ts` | MCP server entrypoint exposing registered tools over stdio, excluding `ask_user`. |
| `src/tools/registry.ts` | Central registry that assembles command tools and low-level tools into `toolModules[]`. |
| `src/lib/agent.ts` | Natural-language agent loop with tool-calling, message history trimming, and terminal tool handling. |
| `src/lib/sub-agent.ts` | Shared helper for constrained sub-agents used by guide generation, review, rejection, and wiki generation. |
| `src/lib/github.ts` | GitHub integration layer: issues, labels, comments, PRs, repo file updates, acceptance, and collaborator checks. |
| `src/lib/git.ts` | Git integration layer: branch switching, worker branch naming, diff generation, syncing with base, and commit/push. |
| `src/lib/config.ts` | `conf`-backed local configuration store and schema validation for auth, model settings, repo, and task state. |
| `src/commands/init.ts` | First-run setup wizard for GitHub auth, model/provider configuration, and optional `TECHUNTER.md` generation. |
| `src/tools/new-task/index.ts` | `/new` workflow: validates permissions, generates a guide, optionally edits/revises it, and creates the GitHub Issue. |
| `src/tools/submit/index.ts` | `/submit` workflow: loads active task, reviews changes, commits/pushes, creates PR, and marks the task in review. |
| `src/tools/wiki/index.ts` | `/wiki` workflow: generates or refreshes `TECHUNTER.md` and commits it back to the repository. |

## Development Workflow

Common day-to-day commands:

- **Run locally without building**
  ```bash
  npm run dev
  ```
  This executes `tsx src/index.ts`.

- **Build distributable output**
  ```bash
  npm run build
  ```
  `tsup.config.ts` builds `src/index.ts` and `src/mcp.ts` into ESM output under `dist/`.

- **Type-check**
  ```bash
  npm run typecheck
  ```
  This project currently has no test suite; `CLAUDE.md` explicitly says end-to-end verification is done manually. I also confirmed `npm run typecheck` succeeds in this repository.

- **Install globally for local CLI testing**
  ```bash
  npm link
  ```

A typical feature workflow:

1. Start from the relevant tool or library module. Most behavior is organized by workflow under `src/tools/{name}/index.ts`.
2. If the feature is a new user action, add a new tool module exporting `definition`, `execute`, optionally `run`, and `terminal`.
3. Register it in `src/tools/registry.ts`.
4. If it should be available as a slash command, add it to `SLASH_NAMES`, `COMMANDS`, and the command switch in `src/index.ts`.
5. Put shared GitHub or git operations in `src/lib/github.ts` or `src/lib/git.ts` instead of duplicating logic in tools.
6. Run:
   ```bash
   npm run typecheck
   npm run build
   ```
7. Verify manually in a real git repository with a GitHub remote by running:
   ```bash
   tch init
   tch
   ```

A few implementation details worth knowing while contributing:

- The project is **ESM-only** (`"type": "module"` in `package.json`).
- Source imports use `.js` extensions even in TypeScript.
- `tsup` keeps dependencies external rather than bundling them.
- Interactive prompts use `@inquirer/prompts`.
- Persistent config includes both credentials and per-task local state such as `activeIssueNumber` and `baseCommit`.

---
*Maintained by Techunter — run `tch wiki` to regenerate*