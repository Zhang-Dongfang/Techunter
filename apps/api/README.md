# Techunter API

`@techunter/api` 是部署到 Railway 的独立中央控制面。它连接 Supabase 的 `techunter` schema，管理共享项目、任务、原子认领、审核和贡献点；还负责 Conexus 登录、GitHub OAuth/App、Webhook 和模型调用。

它不 clone 长期仓库、不保存本机路径，也不执行用户项目环境命令。任务分析需要代码证据时，会从 GitHub 下载短期 archive 到临时目录并在调用结束后删除。Conexus 与 GitHub 都由 Desktop 发起系统浏览器授权；GitHub callback 使用与当前 Techunter session 绑定的短期签名 state，不依赖系统浏览器共享 Desktop Cookie。

Techunter 登录会话具有 30 天绝对期限和 7 天空闲期限。Conexus Run Ticket 保持自身的短期有效期；它过期后只暂停模型功能，用户可以通过 Conexus 保存的浏览器会话重新授权。GitHub OAuth 凭证按用户加密保存，不随单个 Techunter 会话退出或 Run Ticket 到期而丢失；用户从 Desktop 断开 GitHub 时会同时撤销远端授权。

## 部署顺序

1. 按 `infra/supabase/README.md` 应用迁移，并把 `techunter` 加入 Supabase Data API Exposed schemas。
2. 在 Railway 新建独立 `techunter-api` Service，配置 `infra/railway/api.json`。
3. 从 `.env.example` 配置 Supabase、Conexus、GitHub 和凭据加密密钥。
4. 把 `TECHUNTER_PUBLIC_URL` 设置为 API 的最终 HTTPS 地址；需要同时支持本地开发和生产 Desktop 时，把 `TECHUNTER_WEB_ORIGINS` 设置为 `http://127.0.0.1:4311,http://127.0.0.1:5173`。
5. 把 GitHub OAuth callback 配置为 `https://<techunter-api>/api/auth/github/callback`，Webhook 配置为 `https://<techunter-api>/api/github/webhook`。如需自动处理私有仓库合作者申请，GitHub App 必须安装到对应仓库，并具有仓库 `Administration: write` 权限。

API Docker 镜像只构建中央 API 和它依赖的 `@techunter/core`，不包含或托管 Web UI。Electron 在本机提供打包后的 UI，并通过 HTTPS 调用这里的 API。

## 版本升级

当前版本须先停止旧 API 写入（包括认证），按顺序应用迁移至 `202609120008_release_settlement_recovery.sql`，再替换 API 和 Desktop。008 为历史交付固定结算依据，恢复已释放或转交的任务时奖励归原提交作者，并保留原执行者和恢复操作审计。007 引入的 GitHub 连接租约与版本控制继续有效。

恢复提交先核对已合并 PR 的原始 HEAD/tree，支持远程分支已删除。释放先关闭旧交付 PR，并在远端写入前后检查是否已经合并；发现已合并就终止释放并保留归属，网络失败则保留待恢复操作。`GET /api/tasks/:id/submissions/recovery` 向维护者和管理员列出 open/active 任务的历史合格交付；原验收入口核对合并、快照、范围和任务版本后恢复结算，不能自审，不能通过历史恢复发起新合并。已错误退款或取消的任务仍需人工核对账本。任务、项目及关联用户查询采用不可变 ID 游标，不会因 updated_at 排序移动而跳过任务；保持现有完整列表契约，审核计数仍在 PostgreSQL 中聚合。

此前的 `202609120006_role_sources_and_merged_reviews.sql` 区分角色来源。用户成功登录或续期 Conexus 授权时，会刷新来自 Conexus 的管理员身份；本地角色单独保存。历史已连接 Conexus 的 admin 默认视为来自 Conexus 的授权，如有独立本地授权，需按 [Supabase 升级说明](../../infra/supabase/README.md) 显式记录。

退回修改前后会检查 PR 是否已合并；已合并时保留 approved 提交供验收结算。对于已经处于 active/changes_requested 的旧交付，`POST /api/submissions/:id/accept` 可核对外部合并后恢复结算，但不会合并一个尚未合并的 PR；仍要求当前执行者、最新交付、已通过的原预审、相同审核快照与有效范围。原审核人降权后，当前有权限的审核人可接续其租约已释放或到期的操作。

上一轮的 `202609120005_claim_recovery_and_drafts.sql` 在认领前验证 GitHub 写权限；未完成认领允许本人撤销或管理员恢复，撤销使用持久化释放流程并保留分支成果。`DELETE /api/tasks/:id` 允许作者删除未发布且没有进行中操作的草稿；已发布任务仍由管理员取消。具体恢复条件和历史数据检查见 [Supabase README](../../infra/supabase/README.md)。

此前的 `202609120004_task_coordination.sql` 统一认领、审核、取消的持久化互斥与恢复，固定任务集成分支，并在提交事务中校验工作区。`POST /api/tasks/:id/submissions` 必须携带 UUID `workspaceId`；旧客户端必须同步升级。

当前版本还需要先应用 `202609120002_durable_task_operations.sql`，然后更新 API 和 Desktop。任务分析会固定读取任务 `baseSha`，通过版本校验写回；发布和提交进度存入数据库，可以在 API 重启后从 Desktop 恢复。发布失败保留预算占用，撤回发布时先关闭对应 Issue 再释放占用。恢复提交不再要求重新运行模型。完整升级和旧提交恢复说明见 [Supabase README](../../infra/supabase/README.md)。

部署带有复议接口的 API 前，先应用 `infra/supabase/migrations/202609080001_scope_requests.sql`。接取者在 Desktop 任务详情提交逐文件申请，发布者或管理员在审核中心审批；批准后更新范围版本并尝试同步 GitHub Issue。同步失败可以单独重试，不会撤销授权。完整边界、流程与接口见 [复议机制设计](../../docs/scope-reconsideration.md)。

## 本地 SQLite 一次性迁移

正式切换前可以运行：

```powershell
$env:GITHUB_MIGRATION_TOKEN='...'
npm run migrate:sqlite --workspace @techunter/api -- apps/desktop/.data/techunter.sqlite
```

脚本迁移共享业务数据，但不会迁移会话和机器本地工作区路径。迁移完成后不存在 SQLite 双写或运行时回退。
