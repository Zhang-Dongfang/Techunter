# Techunter / 科技猎人

Techunter 是 AI 驱动的共享任务市场。Railway 中央 API 和 Supabase `techunter` schema 保存所有用户共同看到的项目、任务、认领、提交、审核和贡献点；Electron Desktop 是本机源码与环境执行 Agent。

## 产品流程

1. 用户在系统浏览器中使用 Conexus 账号登录，再通过 GitHub OAuth 连接自己的 GitHub 账号；浏览器会复用已有会话。
2. 用户从有读取权限的 GitHub 仓库中导入项目。项目以稳定的 GitHub repository ID 去重，所有 Techunter 用户都能看到共享项目目录。
3. 发布者创建任务；中央 Task Agent 从 GitHub 临时 archive 读取代码证据，生成摘要、验收标准、文件范围和原生宿主机环境计划。
4. 发布时创建 GitHub Issue 并冻结项目贡献点。
5. 执行者原子认领任务。Desktop Agent 在本机没有项目时自动 clone，已有缓存时验证 remote 并 fetch，然后从任务 `baseSha` 创建独立 worktree，并同步固定的 `workingBranch`，继承已验收子任务的成果。
6. Desktop Agent 执行仓库声明或 Agent 推导的 setup commands，不使用预制项目镜像。
7. 提交时本机只收集 `editablePaths` 内的改动，中央 Review Agent 生成预审结果并创建 PR。
8. 维护者合并验收后，Supabase 原子结算贡献点。验收和取消共享持久化操作占用；网络失败可恢复同一操作，确认合并被拒绝后才允许退回修改。

## 架构

```text
apps/desktop: React Web + Electron
       │ HTTPS
       ▼
apps/api (Railway)
├─ Conexus account/model gateway
├─ GitHub OAuth/App/Webhook
└─ Supabase service-role access
       │
       ▼
Supabase.techunter

Electron Local Agent
├─ repositories/<project-id>
├─ workspaces/<task-id>
├─ clone / fetch / worktree
└─ dependency setup / diff collection
```

`apps/api` 是唯一中央业务服务，只提供 API，不托管 UI。Electron 本地渲染器不持有 Supabase service-role key。Supabase 不保存源码、本机绝对路径、依赖缓存或构建产物。

## 仓库结构

```text
Techunter/
├─ apps/
│  ├─ api/                  Railway Fastify control plane
│  └─ desktop/              React UI、Electron 和本机 Agent
├─ infra/
│  ├─ railway/              API 部署配置
│  └─ supabase/             techunter schema migrations
└─ packages/core/           共享 Agent、仓库工具、任务约定与 API contracts
```

## 数据边界

Supabase `techunter` schema 包含 users、sessions、projects、tasks、claims、workspaces、submissions、point_accounts、point_transfers、audit_events 和 github_deliveries。所有表启用 RLS，但不向 `anon` 或 `authenticated` 授权；只有 Railway API 使用 `service_role`。

任务认领、预算冻结和结算由 PostgreSQL functions 完成，不能用客户端读后写替代。原 SQLite 数据只允许通过一次性迁移脚本导入；正式运行不双写、不回退。

## 本地环境

Desktop 保存稳定的 device ID，并在 Electron userData 下维护受管仓库缓存和任务 worktree。中央 API 会在确认用户仓库权限后提供短期 GitHub App installation token；未安装 App 时使用该用户已连接的 OAuth 授权。带凭据 remote 会在 clone/fetch 后恢复为普通 URL。

Task Agent 的环境结构只包含 `setupCommands`、`testCommands` 和 `networkAllowlist`。不再存在 image 字段或 Docker provider。没有 setup commands 时，本机 Agent 根据 pnpm/yarn/npm、uv/pip、Cargo 或 Go 锁文件自动探测。

## 开发与部署

```powershell
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

Supabase 和 Railway 部署步骤分别见 `infra/supabase/README.md` 与 `apps/api/README.md`。
