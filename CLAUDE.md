# CLAUDE.md

This file contains repository-specific guidance for coding agents working on Techunter.

## Workspace layout

Techunter is an npm-workspaces monorepo. The two product applications are peers; neither imports source code from the other.

```text
apps/api/       Railway control plane and Supabase/GitHub/Conexus adapters
apps/cli/       Published `techunter` CLI, `tch` REPL, and `tch-mcp`
apps/desktop/   React Web UI, Electron shell, and local repository/environment Agent
infra/          Supabase migrations and Railway deployment configuration
packages/core/  Shared Agent runtime, contracts, repository tools, and task conventions
```

Cross-application behavior belongs in `@techunter/core`. UI, terminal prompts, HTTP handlers, persistence, Electron IPC, and other adapter-specific code stays in its application.

## Commands

Run these from the repository root:

```bash
npm install
npm run dev          # API + Web + Electron
npm run dev:cli      # CLI, using the repository root as its working directory
npm run typecheck    # all workspaces
npm test             # API and local-Agent tests
npm run build        # core, CLI, then desktop
```

Target one workspace when useful:

```bash
npm run typecheck --workspace @techunter/core
npm run typecheck --workspace techunter
npm run typecheck --workspace @techunter/api
npm run test --workspace @techunter/desktop
```

## Shared core

`packages/core/src/index.ts` is the public boundary. It currently exports:

- AI client creation and the reusable tool-calling runtime;
- repository file listing, grep, safe command execution, and context collection;
- task analysis and delivery-review Agents;
- CLI config-store discovery for desktop reuse;
- canonical GitHub labels, task metadata, branch names, and task-guide rendering.

Both applications import these capabilities through `@techunter/core`; do not add relative imports that reach into another workspace.

## CLI architecture

```text
apps/cli/src/index.ts
  ├─ slash command → tools/{name}.run()
  └─ free text     → lib/agent.ts → registered tool execute()
```

- `apps/cli/src/tools/registry.ts` is the central tool registry.
- Interactive product flows live in `apps/cli/src/tools/*`.
- GitHub and git CLI adapters live in `apps/cli/src/lib/github.ts` and `git.ts`.
- `apps/cli/src/mcp.ts` exposes non-interactive tools over stdio.
- Source imports use `.js` extensions. tsup emits bundled CommonJS executables and preserves the shebang already present in `src/index.ts`.

To add a CLI tool, create `apps/cli/src/tools/{name}/index.ts`, register it in `registry.ts`, and add its slash-command dispatch only if it needs an interactive alias.

## Control-plane and Desktop architecture

```text
apps/api/src/              Fastify API, Supabase, GitHub, Conexus, task/ledger services
apps/desktop/src/web/      React renderer bundled and served locally by Electron
apps/desktop/src/desktop/  Electron main process and narrow preload bridge
apps/desktop/src/worker/   Local clone/fetch/worktree/setup/diff Agent
infra/supabase/            Isolated techunter schema and atomic database functions
```

The Railway API is the only shared business service and the only component allowed to hold `SUPABASE_SERVICE_ROLE_KEY`. It does not serve the UI. The Electron renderer calls the API and never queries Supabase directly. `AgentService` delegates task analysis and review to `@techunter/core`; it must not introduce a second heuristic Agent implementation.

The local Agent owns machine-specific repositories and worktrees. It must verify Git remotes, check out the frozen task base SHA, keep credentials out of persisted remotes, execute native-host setup commands, and reject submitted files outside `editablePaths`. Never add project-image or Docker-provider branches back to the environment contract.

Electron intentionally allows arbitrary local shell commands from the trusted Techunter page. Preserve the trust boundary: `contextIsolation` and sandbox remain enabled, Node integration remains disabled in the renderer, and shell access stays behind the narrow preload IPC API.

## Task and GitHub invariants

- Canonical states use exactly one `techunter:*` lifecycle label.
- Task metadata and guide formatting come from `@techunter/core` so CLI and desktop remain compatible.
- Publishing a desktop task creates a CLI-readable GitHub Issue before freezing points.
- Claiming is atomic; only one user can win a concurrent claim.
- Contribution-point transfers are ledger entries with idempotency keys, never balance-only mutations.
- Atomic claim, reserve, and settlement behavior belongs in Supabase functions, not read-then-write API code.
- `projects` never stores a local path; local paths are device-owned state and never enter Supabase.
- `Project.sourceBranch` selects the GitHub branch used for future task analysis and checkout. Switching it must not rewrite an existing task's frozen `baseSha` or `targetBranch`; `defaultBranch` remains repository metadata.
- Parent/child task visibility may only narrow, never broaden.
- Agent output is advisory; deterministic scope, ledger, repository, and permission checks remain authoritative.

## Verification

For code changes, run typecheck, tests, and builds from the root. Avoid live GitHub or paid-model mutations in automated verification. The integration suite uses fake Agent/GitHub ports and covers task settlement, denied-file isolation, and concurrent claims.
