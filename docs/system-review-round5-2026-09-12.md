**Techunter 系统审查 · 第五轮 · 2026-09-12**

审查基线：`4a811708c6f76d02c18d072eeef86f042d53a0a5`。检查 API、全部数据库迁移、GitHub 协作、身份认证、共享 Core、Desktop 交付与列表流程。历史已经修复的问题未重复列为现存缺陷。

本轮审查确认三类新问题：两项 P1（合并后错误退款、断开授权被并发刷新撤销），一项 P2（任务列表截断）。P1/P2 表示建议修复优先级；下述原始结果来自隔离复现，不代表已经在线上发生。

**修复更新**：已按用户要求修复第 1–3 项。下文编号条目保留修复前证据与旧行号，不应作为修复后仍存在的缺陷。新增迁移 `202609120007_delivery_and_connection_recovery.sql`，上线先停止旧 API 写入（含认证），应用迁移，再更新 API；本轮未执行生产迁移或部署。

- 创建 PR 后立即保存地址；恢复先核对历史 PR 的已合并状态与原审核 tree，支持来源分支删除。取消会查找相关历史 PR，旧的缺失地址不再绕过合并检查。尚未退款的旧失败恢复记录可核对原证据后结算；已经取消退款的旧数据需按升级说明人工核对账本。
- GitHub 刷新、连接和断开采用数据库租约，跨 API 实例串行执行；断开等待正在进行的刷新，撤销当前令牌并清空凭据。连接版本阻止过期写入和旧浏览器回调恢复授权；账号资料与凭据、审计事件在同一事务中更新。远端撤销失败时保留重试所需凭据并报告失败。
- API 分页读取完整任务、项目和待审批范围请求，保持当前 Desktop/助手的完整列表契约；短页不被误判为结果结束，审核数量在 PostgreSQL 中独立聚合。本次无需改变客户端的搜索和筛选流程。

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 所有 workspace 通过 |
| `npm test` | API 100、Desktop 17，共 117 项通过 |
| `npm run build` | Core、API、Desktop 通过 |
| `npm audit --json` | 当前锁文件 0 项漏洞告警 |
| 本轮独立复现 | 3 个测试通过，确认下述问题行为；其中认证测试覆盖两个竞争场景 |

上表为修复前审查基线。修复后新增 12 项正式回归，`npm test` 共 129 项（API 112、Desktop 17）通过，全部 workspace 类型检查、完整构建和 `git diff --check` 通过。回归覆盖真实旧数据库升级、两个 API 实例竞争、过期租约与 OAuth 回调、撤销失败重试、单独断开时的令牌刷新、历史缺失 PR 地址、分支删除、审核快照不匹配、禁止错误退款、仅结算一次，以及超过 1,000 条任务的列表和审核计数。

1. **P1 · 已合并 PR 的分支被删除后，恢复提交可能丢失 PR 关联，允许错误退款。**

   位置：[github-service.ts:426](../apps/api/src/github-service.ts#L426)、[github-service.ts:437](../apps/api/src/github-service.ts#L437)、[task-service.ts:478](../apps/api/src/task-service.ts#L478)、[github-service.ts:534](../apps/api/src/github-service.ts#L534)。

   触发条件：工作区提交时同步的任务分支 HEAD 已不同于冻结的 `baseSha`，例如存在此前提交或分支成果；创建 PR 后的 GitHub 同步中断，数据库保留 reviewing 提交；维护者在 GitHub 合并该 PR，并删除来源分支。GitHub 支持合并后自动删除来源分支，因此无需异常的仓库操作就能满足删除条件。[GitHub 自动删除分支说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)。

   恢复时，`getRef` 的 404 被解释为任务分支尚未创建，`workingSha` 回退到 `baseSha`，随后与保存的提交前 HEAD 比较，抛出 `WORKSPACE_BEHIND`。查找已合并 PR 的恢复分支位于这一步之后，且要求当前分支 tree 匹配，因此没有执行。TaskService 随即把提交标为 changes_requested、任务改回 active，并将 `pull_request_url` 写为 null。

   此时“核对合并并恢复验收”因为缺少 PR 地址而失败；管理员取消任务只检查 latestSubmission 中已有的 PR 地址，空值导致跳过合并检查，最终退款。代码已进入目标分支，贡献点却没有支付给执行者。

   隔离复现使用实际 TaskService、GitHubService 和应用全部迁移的内存 PGlite；GitHub 使用替身，先成功创建提交/PR，再模拟同步中断、外部合并和分支删除。恢复期间没有查询已合并 PR；最终观察到：`githubMerged=true`、任务 `cancelled`、项目 available 从 0 回到 100、reserved 从 100 降为 0。没有连接真实 GitHub。

   建议：分支缺失时先按任务、提交标记和已审核 tree 核对历史 PR；尽早持久化远端 PR 标识。不能仅凭 ref 404 或 HEAD 不符，就认定此前提交没有外部效果；取消前也不能把缺少 PR 地址等同于从未创建或合并过 PR。

2. **P1 · 凭据刷新与断开 GitHub 缺少协调，断开成功后有效凭据会被重新保存。**

   位置：[auth.ts:184](../apps/api/src/auth.ts#L184)、[auth.ts:195](../apps/api/src/auth.ts#L195)、[auth.ts:276](../apps/api/src/auth.ts#L276)、[auth.ts:392](../apps/api/src/auth.ts#L392)。

   适用条件：使用带到期时间和 refresh token 的 GitHub App 用户令牌。普通不含 refresh token 的长期 OAuth token 不触发本复现。GitHub 的 refresh token 使用后失效，旧 access token 也会失效。[GitHub 用户令牌刷新说明](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)。

   每个 API 请求都独立读取 connection 并尝试刷新，没有按用户合并刷新请求，也没有数据库版本检查。两个同时到达的请求会消费同一个 refresh token；一个成功，另一个失败并被 catch 转成“没有 GitHub 凭据”。隔离复现中两个同时请求分别返回 200 和 401，而下一次请求又正常返回 200。

   更严重的情况是，刷新 A 已消费旧 token、尚未返回时，用户点击断开。断开请求的 preHandler 刷新失败，`request.githubCredential` 为空，于是跳过远端撤销；删除 connection、清空 github_login，并返回成功。随后 A 返回，`saveGitHubConnection` 无条件 upsert，把新的有效凭据重新插入。

   实际 Fastify 认证路由、真实 Supabase SDK 和凭据加解密代码的隔离复现结果：断开接口返回 200；当时 connection 确实删除；迟到刷新随后恢复 connection；`/api/auth/me` 返回 `githubConnected=true`，但 `user.githubLogin=null`；远端撤销调用次数为 0。全部 fetch 被拦截，令牌和用户均为测试数据。

   建议：按用户协调刷新，失败的并发请求重新读取已轮换凭据；保存刷新结果时校验 connection 的版本和撤销状态，禁止将已断开的连接重新 upsert 出来。断开、刷新和重新绑定账号应共享同一套并发控制，适用于多个 API 实例。

3. **P2 · 任务列表没有分页，超过数据库返回上限后，旧任务从界面和筛选中消失。**

   位置：[task-service.ts:165](../apps/api/src/task-service.ts#L165)、[task-service.ts:145](../apps/api/src/task-service.ts#L145)、[App.tsx:888](../apps/desktop/src/web/src/App.tsx#L888)。

   `listTasks` 一次执行 select，按更新时间倒序取结果，没有 range、游标或分页循环。随后才在内存中把 active/open/submitted 排到前面。Dashboard 使用这份列表，Desktop 的搜索、“我的任务”、状态筛选也只过滤已收到的数据，没有向 API 请求缺失任务。

   Supabase 项目默认单次最多返回 1,000 行，且该上限可以调整；调整上限只改变触发阈值。[Supabase 查询与默认行数说明](https://supabase.com/docs/reference/javascript/v1/select)。在默认设置下，较早的 active 任务可能被较新的 accepted/draft 任务挤出返回结果。数据库中的任务并未删除，按 UUID 查询详情仍可能正常，但用户无法通过当前界面的列表和筛选找到它。

   隔离复现使用真实 TaskService 和 Supabase SDK，替身模拟 1,000 行服务器上限：1,001 条任务中，较新的 1,000 条为 accepted，最早一条为 active。实际仅发起一次 tasks 查询，返回 1,000 条，进行中任务缺失。未核验线上 Supabase 是否调整过上限，也未把该替身测试描述为真实托管服务的测试。

   建议：API 返回带稳定排序和游标的分页结果，将状态、归属、项目与搜索条件下推数据库；Desktop 筛选时重新查询，并提供后续页。审核数量等统计应独立聚合，不能依赖一次取回的任务子集。

**仍存在的既有信任边界**

第三、四轮记录的以下行为在当前代码中仍保留，未计入三项新问题：

- 私有仓库合作者申请可经共享 GitHub App 直接发送邀请；组织仓库申请 push 权限，没有项目负责人审批。是否可接受取决于成员互信与项目授权约定。见 `apps/api/src/github-service.ts:78`。
- 任务详情只要求平台登录，返回工作区日志、设备信息、测试输出和相关用户邮箱，没有针对这些字段检查仓库访问权。见 `apps/api/src/app.ts:138`、`apps/api/src/task-service.ts:180`。
- setup/test 直接以宿主机用户权限运行并继承环境变量；editablePaths 限制交付内容，networkAllowlist 没有实际网络拦截。见 `apps/desktop/src/worker/local-agent.ts:63`、`:192`。这些命令不构成执行沙箱。

详细背景见[第三轮报告](system-review-round3-2026-09-12.md)。

**复现与验证范围**

从仓库根目录运行：

```powershell
npm run build --workspace @techunter/core
npm run build --workspace @techunter/api
node --test apps/api/test/task-recovery-round5.test.mjs apps/api/test/github-connection-recovery.test.mjs apps/api/dist/task-list.test.js
```

原复现已转为正式回归：[状态与退款](../apps/api/test/task-recovery-round5.test.mjs)、[认证与迁移](../apps/api/test/github-connection-recovery.test.mjs)、[分页](../apps/api/src/task-list.test.ts)，均随 `npm test` 执行，断言修复后的正确行为。数据库使用应用真实迁移的内存 PGlite；认证回归使用两个 Fastify 实例、真实 Supabase SDK 与凭据加解密代码，所有外部请求被替身拦截。上文编号条目的复现输出属于修复前基线。

未访问生产数据库、执行生产迁移、实际 GitHub 写入或付费模型调用。未验证线上配置、真实 OAuth、安装包和自动更新，也未进行负载测试。本次构建与测试通过说明现有检查未发现失败，不能覆盖上述已复现的跨步骤问题。
