# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # Build with tsup → dist/index.js
npm run dev        # Run directly with tsx (no build step)
npm run typecheck  # Type-check without emitting
npm link           # Install globally as `tch` / `techunter`
```

There are no tests. To verify end-to-end, build and run `tch init` in a directory with a GitHub remote.

## Architecture

**Techunter** is an AI-powered task-distribution CLI. Users interact via a conversational readline REPL (`src/index.ts`); all natural-language requests are handled by a Claude agent loop (`src/lib/agent.ts`).

### Request flow

```
tch                        → src/index.ts (REPL)
  user message             → runAgentLoop()
    Claude API (tool_use)  → executeTool()
      list_tasks           → github.ts listTasks()
      create_task          → github.ts createTask()
      claim_task           → project.ts buildProjectContext()
                              ai.ts generateGuide()    (second Claude call)
                              github.ts postGuideComment / claimTask
                              git.ts createAndSwitchBranch / pushBranch
      deliver_task         → git.ts pushBranch()
                              github.ts createPR / markInReview()
      get_my_status        → github.ts getAuthenticatedUser / listMyTasks()
```

### Key files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point, readline REPL, persistent `messages[]` history |
| `src/lib/agent.ts` | Claude tool_use loop, all 5 tool definitions + execution |
| `src/lib/github.ts` | All Octokit calls; label management, issues, PRs |
| `src/lib/ai.ts` | `generateGuide()` — second Claude call that produces `TaskGuide` JSON |
| `src/lib/project.ts` | Builds project context (file tree + key files) sent to Claude |
| `src/lib/git.ts` | Branch creation, push, remote URL parsing via simple-git |
| `src/lib/config.ts` | `conf`-based config store at `~/.config/techunter/` |
| `src/commands/init.ts` | One-time setup wizard (only subcommand: `tch init`) |
| `src/types.ts` | `TechunterConfig`, `TaskGuide`, `GitHubIssue`, `ProjectContext` |

### Build constraints

- Output is ESM (`"type": "module"`). All source imports use `.js` extensions.
- All `node_modules` are **external** in tsup — never bundled. This prevents CJS/ESM double-import issues.
- The `#!/usr/bin/env node` shebang lives in `src/index.ts` line 1. Do not add a tsup `banner` for the shebang — it would duplicate.
- AI provider: OpenAI-compatible client pointing at `https://api.ppio.com/openai`, model `zai-org/glm-5`. Config key: `aiApiKey`.

### GitHub label lifecycle

Issues carry exactly one `techunter:*` label at a time:

`techunter:available` (green) → `techunter:claimed` (yellow) → `techunter:in-review` (blue)

Labels are auto-created on `tch init` and on `create_task` via `ensureLabels()`.

### Branch naming

`task-{issue_number}-{first-5-words-of-title-kebab-cased}`

`deliver_task` derives the issue number from the current branch name via regex `^task-(\d+)-`.

### inquirer usage

`inquirer` v12 — import named exports from `@inquirer/prompts` (`input`, `password`, `select`), not from `inquirer` directly.

### Project context for guide generation

`buildProjectContext()` caps at **80 KB** total. It always reads `README.md`, `package.json`, config files first, then ranks remaining files by keyword overlap with the issue title/body (top 10, max 15 KB each).
