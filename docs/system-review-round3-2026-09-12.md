**Techunter 当前系统审查 · 第三轮 · 2026-09-12**

审查基线：`78d6694`。检查 API、数据库迁移、共享 Core、Desktop 与测试；历史报告中已经修复的问题不作为现存缺陷重复列出。审查阶段确认三个流程缺陷，并记录三个有明确代码依据、取决于部署信任边界的风险；随后按用户要求修复第 1–3 项。下方保留修复前的问题证据及行号。本轮未连接线上 Supabase、执行 GitHub 写入或调用付费模型。

**修复更新**：第 1 项增加 GitHub 写权限预检、保留原执行者的管理员恢复，以及本人/管理员将未完成认领转为持久化释放的路径；第 2 项按父任务授权规则保留尚未存在的具体文件，同时继续拒绝越权、禁止路径与空权限扩张；第 3 项允许作者在数据库事务内删除自己的未发布草稿，并保留对进行中发布、其他人的草稿和已发布任务的限制。新增迁移为 `202609120005_claim_recovery_and_drafts.sql`，需要先停旧 API 写入、应用迁移，再升级 API 和 Desktop。第 4–6 项的产品行为未改动。

修复后验证：`npm run typecheck`、`npm test`（API 91、Desktop 13，共 104 项）、`npm run build` 和 `git diff --check` 均通过。新增 11 项回归包含从上一版数据库迁移的实际升级测试；没有执行生产环境迁移或部署。

验证：`npm run typecheck`、`npm test`（API 80、Desktop 13）和 `npm run build` 全部通过。另有五个隔离复现通过：实际 TaskService、GitHubService、Core 运行；数据库使用应用全部迁移的内存 PGlite，GitHub 使用替身，模型使用仅监听本机的固定响应服务。复现通过表示观察到了报告中的行为，不表示问题已修复。

1. **P1 · GitHub 无权限导致认领长期占用，缺少退出或管理员接管路径。**

   位置：`apps/api/src/task-service.ts:350`；`infra/supabase/migrations/202609120004_task_coordination.sql:48`、`:181`；`infra/supabase/migrations/202609120003_system_integrity.sql:103`。

   `claimTask` 只先确认用户连接了 GitHub，就通过数据库将任务置为 active 并记录 claim 操作，之后才调用 GitHub。没有该仓库权限或只有读取权限的用户，会在同步分支/Issue 时失败。原用户重试仍缺权限；release 和管理员 cancel 都被未完成操作拦截，管理员 claim 也不能接管其他人的操作。90 秒租约到期仅解除执行租约，不会完成或撤销 claim。

   已复现：GitHub 替身返回 404 后，状态为 active、执行者为失败的认领用户、pendingOperation 为 claim；本人释放、管理员取消和管理员认领均返回 OPERATION_IN_PROGRESS。如果权限不能恢复，现有公开接口不能解除占用。普通已连接 GitHub 的用户可以触发这一情况。

   建议：认领前确认必要仓库权限；为已确认失败的认领提供补偿取消，并允许管理员核对 GitHub 后恢复或撤销。仍需保留对远端结果不确定情况的保护。

2. **P2 · 子任务不能继承父任务允许新增的文件。**

   位置：`packages/core/src/task-agents.ts:35`。

   子任务范围归一化先列出仓库中已经存在的文件，再与模型提供的 editablePaths 求交。父任务即使明确允许新增 `src/new.ts`，该路径在冻结基线中不存在，就会被过滤。若子任务仅需新增文件，分析直接失败；若同时涉及旧文件，新增路径会被遗漏。

   已复现：同一模型结果在根任务保留 `src/new.ts`，在父任务已授权这一新路径的子任务中却抛出“没有给出有效的 editablePaths”。

   建议：新文件权限按父任务路径规则和 deniedPaths 校验，不应以文件已存在作为可编辑的必要条件。

3. **P2 · 放弃一个子任务草稿，会阻断父任务，草稿作者无法自行清理。**

   位置：`apps/api/src/task-service.ts:321`、`:399`；`apps/api/src/app.ts:164`；`infra/supabase/migrations/202609120003_system_integrity.sql:112`。

   未发布的 draft 子任务同样被当作未完成子任务，阻止父任务释放和提交；删除草稿的接口及服务却只允许 admin。普通执行者创建草稿后发现拆分不合适、模型分析持续失败，无法撤销自己的草稿，只能继续完成它或等待管理员删除。第 2 项会加重这一阻塞。

   已复现：父任务执行者创建自己的子任务草稿后，删除被拒绝，父任务释放和提交也均被拒绝。

   建议：允许作者删除尚未发布且没有进行中操作的草稿，在事务内核对子任务、操作和权限；已发布任务继续采用独立取消流程。

4. **条件性高风险 · 私有仓库“申请”直接授予访问能力。**

   位置：`apps/api/src/app.ts:129`；`apps/api/src/github-service.ts:78`。

   连接 GitHub 的普通用户可以对共享目录中的私有项目请求合作。用户读取仓库得到 404 后，服务调用共享 GitHub App 直接发送合作者邀请；组织仓库明确使用 push 权限。没有项目负责人审批或项目成员白名单。已用替身确认“无访问权限 → 直接发出 push 邀请”。只有在 App 已安装且具有相应 Administration 权限时，真实邀请才会成功。

   自动邀请是 README 明确描述的现有功能，不能仅凭这一行为断言违背产品意图。但若部署包含不互信成员或多个团队，“目录可见”就可能转化为“可自行申请获得仓库写权限”。需要明确允许自动加入的项目与人员范围；其他项目应先审批。

5. **条件性风险 · 共享任务暴露工作日志和邮箱，源码存储说明也不准确。**

   位置：`apps/api/src/app.ts:138`；`apps/api/src/task-service.ts:180`、`:631`、`:669`、`:679`；`infra/supabase/migrations/202609120001_submission_recovery.sql:35`。

   任务详情接口只要求 Techunter 登录，不核对 GitHub 仓库访问权。响应包含当前执行者工作区的 setupLog、deviceId/deviceLabel、提交 testOutput、完整审查结果和关联用户邮箱。服务层隔离复现确认，私有项目的测试标记日志和邮箱均被返回；HTTP 路由直接调用该无调用者参数的方法。这并不等于任意用户能直接下载完整仓库，但日志和审查内容可能包含私有路径、源码片段或命令输出中的凭据。

   TECHUNTER.md 明确说明任务市场共享，因此共享目录和任务本身是设计行为；需要单独判断日志、联系方式是否也应默认共享。另外，该文档称 Supabase“不保存源码”，实际 submissions.files_json 和提交操作 payload 会保存完整交付文件内容。这是恢复流程的事实，应在数据说明、保留期限与访问策略中准确体现。

   建议：区分公开任务摘要与受限工作日志，最小化邮箱和设备信息，对日志做敏感信息处理，并明确交付源码在中央数据库中的保留规则。

6. **条件性高风险 · 文件范围和网络列表不约束本机命令的实际权限。**

   位置：`packages/core/src/task-agents.ts:48`；`apps/desktop/src/worker/local-agent.ts:63`、`:192`；`apps/desktop/src/web/src/App.tsx:486`。

   模型生成的 setupCommands/testCommands 最终直接交给宿主机 PowerShell 或 shell，并继承 process.env。editablePaths 约束交付包，不限制命令读取或修改其他本机文件；networkAllowlist 目前只存储和展示，没有网络执行限制。依赖安装也可能执行仓库脚本。

   此项为代码追踪确认的信任边界，未执行恶意命令，也未证明实际模型会被诱导生成攻击命令。原生本机执行是项目明确的设计选择；当仓库、任务发布者或模型结果不可信时，风险会扩展到当前系统用户可访问的文件、凭据与网络。建议在执行前展示并核准具体命令，缩减环境变量，按使用场景采用独立低权限执行账号或宿主机隔离策略，避免将网络列表展示为已经强制执行的限制。

第 1–3 项原复现已转为正式回归：[task-recovery-round3.test.mjs](../apps/api/test/task-recovery-round3.test.mjs)，随 `npm test` 运行；包含权限预检、并发认领、部分失败与管理员恢复、租约互斥、旧数据升级、分支/账本保留、草稿权限及发布竞争、子任务新增文件的范围约束。从仓库根目录单独运行：

```powershell
npm run build --workspace @techunter/core
npm run build --workspace @techunter/api
node --test apps/api/test/task-recovery-round3.test.mjs
```

回归断言验证修复后的正确行为；上方五个隔离复现的记录属于修复前基线。实际生产迁移、GitHub 配置、安装包及真实 OAuth 流程不在本轮验证范围内。
