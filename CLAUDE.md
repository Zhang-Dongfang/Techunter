# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # Build with tsup → dist/index.js and dist/mcp.js
npm run dev        # Run directly with tsx (no build step)
npm run typecheck  # Type-check without emitting
npm link           # Install globally as `tch` / `techunter` / `tch-mcp`
```

There are no tests. To verify end-to-end, build and run `tch init` in a directory with a GitHub remote.

## Architecture

**Techunter** is an AI-powered task-distribution CLI. Users interact via a conversational readline REPL (`src/index.ts`); natural-language requests are handled by an agent loop (`src/lib/agent.ts`).

### Request flow

```
tch
  └─ src/index.ts          readline REPL + slash command dispatch
       ├─ /pick, /new …    → tool run() functions directly
       └─ natural language → runAgentLoop()
            └─ LLM (tool_use) → toolModules[name].execute(input, config)
                 ├─ command tools   hardcoded interactive flows (terminal=true → loop exits)
                 └─ low-level tools reasoning helpers (get_task, list_files, grep_code, …)
```

### Tool architecture

All tools live in `src/tools/{name}/index.ts` and export:

```typescript
export const definition: OpenAI.ChatCompletionTool  // tool schema for the LLM
export const execute: (input, config) => Promise<string>
export const terminal?: boolean   // true = agent loop exits after this tool
export function run(config, ...): Promise<string>  // called by slash commands
```

`src/tools/registry.ts` collects all modules into `toolModules[]`. The agent uses this to build its tools array and dispatch calls — no hardcoded switch statements.

**Command tools** (`terminal = true`) — hardcoded interactive flows, mirrors slash commands:
`pick`, `new_task`, `close`, `submit`, `my_status`, `review`, `refresh`, `open_code`, `reject`, `accept`, `edit_task`, `wiki`

**Low-level tools** — reasoning helpers, chainable:
`get_task`, `get_comments`, `get_diff`, `run_command`, `list_files`, `grep_code`, `ask_user`, `list_tasks`

### Sub-agents

Three sub-agent loops run inside command tools, each using `runSubAgentLoop()`:

| Sub-agent | File | Tools |
|---|---|---|
| Guide generator | `new-task/guide-generator.ts` | `list_files`, `grep_code`, `run_command`, `ask_user` |
| Rejection comment | `reject/comment-generator.ts` | `get_task`, `get_comments`, `get_diff`, `grep_code` |
| Submit reviewer | `submit/reviewer.ts` | `run_command`, `grep_code`, `get_diff` |
| Wiki generator | `wiki/wiki-generator.ts` | `list_files`, `grep_code`, `run_command` |

Sub-agents reuse tool `execute()` functions from the registry. Prompts live in co-located `prompts.ts` files.

### Key files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point, readline REPL, slash command dispatch |
| `src/lib/agent.ts` | Main agent loop; uses registry for tools and dispatch |
| `src/lib/sub-agent.ts` | `runSubAgentLoop()` — shared sub-agent loop helper |
| `src/lib/agent-ui.ts` | `printToolCall()`, `printToolResult()` — shared display |
| `src/lib/client.ts` | `createClient(config)`, `MODEL` — single LLM client config |
| `src/lib/display.ts` | `printTaskList()`, `printMyTasks()`, `colorStatus()` etc. |
| `src/lib/launch.ts` | `launchClaudeCode()` — spawns Claude Code for a task |
| `src/lib/github.ts` | All Octokit calls; label management, issues, PRs |
| `src/lib/project.ts` | `buildProjectContext()` — file tree + key files, capped at 80 KB |
| `src/lib/git.ts` | Branch creation, push, diff via simple-git; `makeWorkerBranchName(username)` |
| `src/lib/config.ts` | `conf`-based config store at `~/.config/techunter/` |
| `src/lib/markdown.ts` | `renderMarkdown()` — terminal markdown renderer |
| `src/lib/proxy.ts` | `getHttpsProxyAgent()` / `getUndiciProxyAgent()` — reads `HTTPS_PROXY` env vars |
| `src/lib/update-check.ts` | `startAutoUpdate()` — checks npm, auto-installs update in background |
| `src/mcp.ts` | MCP server (`tch-mcp`) — exposes all tools (except `ask_user`) via stdio |
| `src/commands/init.ts` | One-time setup wizard (`tch init`) |
| `src/tools/registry.ts` | Assembles all tool modules into `toolModules[]` |
| `src/tools/types.ts` | `ToolModule` interface |
| `src/types.ts` | `TechunterConfig`, `GitHubIssue`, `ProjectContext` |

### Build constraints

- Output is ESM (`"type": "module"`). All source imports use `.js` extensions.
- All `node_modules` are **external** in tsup — never bundled. This prevents CJS/ESM double-import issues.
- The `#!/usr/bin/env node` shebang lives in `src/index.ts` line 1. Do not add a tsup `banner` — it would duplicate.
- AI: OpenAI-compatible client → `https://api.ppio.com/openai`, model `zai-org/glm-5`. Always use `createClient(config)` and `MODEL` from `src/lib/client.ts`.

### GitHub label lifecycle

Issues carry exactly one `techunter:*` label at a time:

`techunter:available` → `techunter:claimed` → `techunter:in-review` → `techunter:changes-needed`

Labels are auto-created on `tch init` via `ensureLabels()`.

### Branch naming

Task branches: `task-{issue_number}-{first-5-words-of-title-kebab-cased}`

Worker branches (per-user integration branch): `worker-{github-username}` — `accept` merges task PRs here, then optionally pushes to `baseBranch`.

`submit` derives the issue number from the current branch via regex `^task-(\d+)-`.

### Adding a new tool

1. Create `src/tools/{name}/index.ts` exporting `definition`, `execute`, optionally `run` and `terminal`.
2. Add it to `src/tools/registry.ts`.
3. If it has a slash command alias, add the case to `src/index.ts`.

### inquirer usage

`inquirer` v12 — import named exports from `@inquirer/prompts` (`input`, `password`, `select`).
