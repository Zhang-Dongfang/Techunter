**Techunter 系统审查 · 第七轮 · 2026-09-12**

审查基线：`56c25d07abd7abc3eec6dd56415b61398b4654ef`。核对现有六轮报告、API、数据库迁移、GitHub 授权及交付流程、共享 Core 和 Desktop。本轮确认三项现存问题：一项 P1、两项 P2。优先级表示建议修复顺序，隔离复现不代表线上已经发生事故。

**修复更新：以下三项已按用户要求修复。** 下文编号条目保留审查时的触发条件和旧行号，不表示修复后仍存在。

- 新增迁移 `202609120009_submission_withdrawal.sql` 和「撤回交付」入口。撤回意图在原提交租约内持久化，重试恢复时继续撤回；核对并关闭未合并 PR 后恢复 active，保留执行者、分支成果及冻结贡献点。已合并且原审核快照匹配的提交恢复为待验收，仍按原作者结算。网络失败或证据不匹配时不允许取消退款。OAuth 授权补充 `workflow`，账号菜单允许已有连接重新授权，并按连接版本确认成功。
- GitHub 凭据改为按需获取。首页、账号信息和 Conexus 续期不再刷新 GitHub 令牌；需要 GitHub 的操作仍保留刷新租约并明确报告故障，失效的用户令牌不会悄悄切换到共享 App 凭据。助手在无法读取仓库时仍可查询任务。
- 助手响应携带结构化环境准备请求，由当前 Desktop 执行；与任务详情复用设备/账号校验、目录选择、setup 和状态回写，相同任务共用进行中的准备。聊天显示实际结果并提供失败后的任务入口。模型正文不会作为本机命令执行。聊天响应丢失或执行前退出后，可从任务详情继续已排队的请求。

新增 15 项正式回归（API 9、Desktop 6），总计 157 项测试通过；全 workspace 类型检查和完整构建通过。回归覆盖真实迁移 008 的未完成提交升级、永久拒绝撤回、撤回中断恢复、丢失 PR 地址、合并竞争、快照不一致、防止重复结算、权限/租约、GitHub 刷新故障隔离和 Desktop 准备/重试。正式回归位于 [task-recovery-round7.test.mjs](../apps/api/test/task-recovery-round7.test.mjs) 和 [prepare-workspace.test.ts](../apps/desktop/src/web/src/prepare-workspace.test.ts)；原诊断入口现转发正式回归。部署前停止旧 API 写入，先应用迁移 009，再更新 API 和 Desktop。旧 OAuth 连接需重新授权以取得工作流权限。本次未执行生产迁移或部署。

1. **P1 · 永久性的 GitHub 交付拒绝会留下无法撤回的提交，持续占用任务和贡献点。**

   位置：[task-service.ts:490](../apps/api/src/task-service.ts#L490)、[auth.ts:330](../apps/api/src/auth.ts#L330)、[取消操作检查](../infra/supabase/migrations/202609120004_task_coordination.sql#L194)、[Desktop 恢复入口](../apps/desktop/src/web/src/App.tsx#L514)。

   一个具体触发场景是：使用 OAuth App 登录的用户认领修改 `.github/workflows/ci.yml` 的任务，文件在获准范围内、用户具有仓库写权限，模型预审也通过，但令牌缺少修改工作流所需的 `workflow` scope。当前授权入口仅请求 `repo read:user read:org`，文件范围检查则允许 `.github/workflows/*`。GitHub 明确规定新增或更新工作流需要 `workflow`；同路径、同内容已经存在于其他分支时有例外，本场景指新增或实际更新的内容。[GitHub OAuth scope 说明](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)。该授权结论针对 OAuth App，不把 GitHub App 用户令牌的权限规则等同于 OAuth scopes。

   系统在远端写入前已经将任务置为 `submitted`，提交置为 `reviewing`，并持久化 `submit` 操作。`resumeSubmission` 只对 `WORKSPACE_BEHIND` 和 `SUBMISSION_REVIEW_MISSING` 恢复到可重新交付的状态，其他错误全部保留原提交。对于权限或固定请求内容导致的永久拒绝，重试原包不会自行解决；当前没有终止该提交的接口。

   隔离复现运行实际 TaskService、GitHubService 和全部真实 SQL 迁移，GitHub 替身在更新任务 ref 时固定返回 403，尚未创建 PR，也没有更新远程分支。观察到：

   - 首次提交及恢复均失败；模型只调用一次，远端更新尝试两次。
   - 任务保持 `submitted`，提交保持 `reviewing`，待处理操作为 `submit`。
   - 作者不能释放或提交修正后的包；管理员不能要求修改，也不能取消任务，取消返回 `OPERATION_IN_PROGRESS`。
   - 项目 `reserved=100`，没有结算或退款。

   本复现证明永久错误的状态处理缺口；403 是替身响应，没有实际向 GitHub 推送工作流。真实授权入口另经 Fastify 调用确认，返回的 scope 确实不含 `workflow`。在外部权限被修复或有其他足够权限的凭据后，原操作仍可能恢复，不能据此称数据库已经损坏。

   建议：针对工作流任务检查并补足相应授权；交付操作同时需要安全的终止路径。对确定尚未发生远端写入的失败，可恢复为可修改状态；对于写入结果不明的情况，应先核对远端 ref、PR 和保存快照，再决定继续或撤回，保留现有防止错误退款的约束。

2. **P2 · GitHub 令牌刷新故障会阻塞与 GitHub 无关的页面和 Conexus 续期。**

   位置：[auth.ts:249](../apps/api/src/auth.ts#L249)、[github-connection-service.ts:80](../apps/api/src/github-connection-service.ts#L80)、[Desktop 启动失败页面](../apps/desktop/src/web/src/App.tsx#L924)。

   前置条件是保存的 GitHub access token 已到期或接近到期，仍有有效 refresh token，而 GitHub 刷新接口暂时不可用。认证 `preHandler` 为几乎所有需要登录的 API 同步刷新 GitHub 凭据；刷新发生网络错误或服务端错误时会向上传播，业务处理函数尚未执行，请求就失败。

   使用实际 Fastify 认证、Supabase SDK、凭据加解密及内存数据库，令牌服务替身返回 503。以下三个请求均返回 502：`GET /api/dashboard`、`GET /api/auth/me`、`POST /api/auth/conexus/refresh`。Dashboard 处理函数与 Conexus introspect 调用次数均为零。把 access token 恢复为未到期状态后，相同 Dashboard 请求返回 200。

   这使本应只影响 GitHub 写入的故障扩大到整个客户端：首次加载 Dashboard 失败时，Desktop 只显示“无法启动 Techunter / 重试”，用户无法通过该页面打开账号面板断开 GitHub。实际 DELETE 断开接口已豁免自动刷新，因此服务端仍存在可用的手动脱困接口，不是所有 HTTP 路由都失效。长期、不需要刷新的 OAuth token 不触发本场景。

   建议：将 Techunter 会话认证与 GitHub 凭据刷新分开；仅在需要 GitHub 的操作中获取凭据，或让刷新故障以独立的连接状态返回。保持任务查询、账号信息和 Conexus 续期可用，并在客户端提供重新连接或断开的入口。

3. **P2 · 聊天助手的环境准备只写入 queued 记录，没有后续本机执行。**

   位置：[assistant-service.ts:165](../apps/api/src/assistant-service.ts#L165)、[AgentDock.tsx:71](../apps/desktop/src/web/src/AgentDock.tsx#L71)、[App.tsx:421](../apps/desktop/src/web/src/App.tsx#L421)。

   助手提供 `create_workspace` 工具，Desktop 活动名称显示为“部署工作环境”。实际执行只调用中央 `createWorkspace`，创建 `queued` 数据库记录并返回。AgentDock 收到聊天结果后只保存消息并刷新 Dashboard，没有分发本机准备操作；源码中也没有消费 queued 工作区的轮询或调度逻辑。

   本轮直接执行实际工具 handler，使用真实 TaskService 和数据库迁移，不调用模型，返回结果确实为 `queued`。后续执行缺口经代码追踪确认：整个 Desktop 唯一的 `desktop.provision(...)` 调用位于任务详情的手动 `provisionWorkspace` 按钮流程。未在 Electron 中模拟一整段聊天，也不声称模型一定会虚报完成。

   因而即使模型正确调用工具，聊天中的“准备环境”请求也不会启动 clone/worktree/setup，用户需要再打开任务详情点击“让 Agent 准备环境”。建议把助手返回的准备请求接到当前设备的执行流程，沿用现有目录选择、授权、准备和状态回写逻辑；若产品只打算记录准备意图，应明确提示需要用户继续操作，并提供直接入口。

**验证与交付**

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 全部 workspace 通过 |
| `npm test` | API 120、Desktop 22，共 142 项通过 |
| `npm run build` | Core、API、Desktop 全部通过 |
| `npm audit --json` | 当前锁文件 0 项漏洞告警 |
| 独立诊断 | 3 项通过，断言本轮观察到的问题行为 |

上表为修复前审查基线。原诊断已转为随 `npm test` 执行的正式回归，[review-round7.mjs](diagnostics/review-round7.mjs) 保留为兼容运行入口，断言修复后的正确行为。运行方式：

```powershell
npm run build --workspace @techunter/core
npm run build --workspace @techunter/api
node --test docs/diagnostics/review-round7.mjs
```

审查阶段只新增报告和诊断脚本；之后的修复包含业务代码、迁移及正式回归。数据库为内存 PGlite，GitHub、Supabase HTTP 和模型均使用本地替身；没有访问生产数据库、执行线上迁移、写入真实 GitHub 或调用付费模型。未验证安装包、自动更新、真实 OAuth 授权页面、生产配置及非 Windows 平台。

此前报告中的私有仓库自动邀请、共享任务详情中的日志/邮箱，以及宿主机命令执行的信任边界仍保留，详见[第五轮报告](system-review-round5-2026-09-12.md)。这些不是本轮新增项；现有自动化测试通过也不等于这些部署边界已经解决。
