**Techunter 当前系统审查 · 第四轮 · 2026-09-12**

审查基线：`a63007bac4696d7c2942637558149e75b6037e25`。检查中央 API、Supabase 全部迁移、Core、Desktop、本机 Git 操作和构建发布配置。历史报告中已修复的问题未重复列为现存缺陷。本次新增报告与隔离复现脚本，未修改业务代码、执行生产迁移或部署，也未向真实 GitHub 仓库写入或调用付费模型。

**修复更新**：已按用户要求修复下列第 1–4 项。下方保留审查时的触发条件与旧行号，不应作为修复后仍存在的缺陷。新增 `202609120006_role_sources_and_merged_reviews.sql`，需停止旧 API 写入、应用迁移、核对历史管理员授权来源，再更新 API 与 Desktop；未执行生产迁移或部署。

- 角色按 `local_role` 与 `conexus_admin` 分开记录；登录/授权续期可回收 Conexus 权限，本地明确授权保留。旧的、已连接 Conexus 的 admin 默认归为 Conexus 来源；存在独立本地授权时按 [升级说明](../infra/supabase/README.md) 记录。原审核人降权后，有权限的用户可接续其已释放/到期租约中的审核或取消操作，保留原决定和合并状态。
- 退回修改在 GitHub 同步前后检查合并状态；已合并时取消本次退回操作、保留原 approved 提交。旧的 active/changes_requested 交付提供「核对合并并恢复验收」，只接受已合并且匹配原审核证据的最新交付，绝不通过该恢复入口发起新合并。
- worktree、任务分支合并及项目快进均使用当次 Git 授权；凭据不写入 remote，也不传给 setup/test 命令。
- 交付字节经过 Git check-in 转换，包摘要和预审使用最终 blob 内容；不修改用户暂存区或工作文件。保留二进制、可执行模式及文件范围校验；必需 clean filter 失败会阻止交付，当前不支持上传对象的 Git LFS 指针会明确拒绝。

修复后验证：`npm run typecheck`、`npm test`（API 100、Desktop 17，共 117 项）和 `npm run build` 通过。新增 13 项回归覆盖真实旧数据库升级、权限回收及本地授权、外部合并前后竞争、旧提交恢复、快照不匹配与退款保护、原审核人降权后接续、私有 partial clone、编码/换行及暂存区保留。原复现已转为正式测试，见文末。

本轮确认四项新问题：两项 P1（权限回收、结算恢复），两项 P2（私有仓库准备、交付内容正确性）。下面的 P1/P2 表示建议修复优先级，并非已在线上发生事故。另有上一轮保留的三类信任边界风险仍然存在。

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 全部 workspace 通过 |
| `npm test` | API 91、Desktop 13，共 104 项通过 |
| `npm run build` | Core、API、Desktop 全部通过 |
| `npm audit --json` | 当前锁文件 0 项漏洞告警 |
| 本轮隔离复现 | 下列四项均观察到问题行为；不表示问题已经修复 |

1. **P1 · Conexus 管理员降权后，Techunter 仍永久保留原管理员角色。**

   位置：[202609120003_system_integrity.sql:77](../infra/supabase/migrations/202609120003_system_integrity.sql#L77)、[auth.ts:142](../apps/api/src/auth.ts#L142)。

   登录和模型授权续期会把 Conexus 返回的管理员标志传给 `upsert_conexus_user`，但数据库只在 `p_admin=true` 时提升角色；`false` 时保留旧角色。因此，曾以 Conexus 管理员身份登录的用户，后来在 Conexus 被降为普通用户，即使重新登录或续期，Techunter 仍将其识别为 admin。任务取消、管理员恢复等接口继续依据这个本地角色授权。

   隔离复现：实际应用全部迁移，先以 `p_admin=true` 创建用户，再以同一 Conexus ID 和 `p_admin=false` 更新，返回的 `role` 仍为 `admin`。这不是等待旧会话到期即可解决的问题。

   建议：明确角色来源。如果本地需要独立授予 maintainer/admin，分别记录本地授权与来自 Conexus 的授权；Conexus 降权时撤销后者，并同步有效权限。当前没有这种来源区分，不能依赖在 Conexus 降权来回收 Techunter 管理权限。

2. **P1 · 对已在 GitHub 合并的 PR“要求修改”，会失去原提交的正常结算入口。**

   位置：[task-service.ts:537](../apps/api/src/task-service.ts#L537)、[github-service.ts:340](../apps/api/src/github-service.ts#L340)、[202609120001_submission_recovery.sql:91](../infra/supabase/migrations/202609120001_submission_recovery.sql#L91)。

   触发条件：交付预审通过，维护者直接在 GitHub 合并 PR，Techunter 尚未执行验收结算；此时另一名维护者在 Desktop 点击“要求修改”。`syncChangesNeeded` 只更新 Issue 标签和评论，不读取 PR 的 merged 状态，随后数据库把提交改为 `changes_requested`、任务改回 `active`。

   后果：原提交不再满足 `acceptSubmission` 的 approved/submitted 条件，不能正常补结算；管理员取消会发现 PR 已合并，返回 `PULL_ALREADY_MERGED`。代码已经进入目标分支，贡献点却继续冻结。数据库的验收/取消互斥已存在，但不能覆盖这个外部合并后的退回入口。

   隔离复现使用真实 TaskService、GitHubService 和应用全部迁移的 PGlite。GitHub 客户端替身中的 PR 为 merged；要求修改成功且完全没有读取 PR，任务变为 active，验收与取消均拒绝，100 点仍在 reserved 账户中。没有把该结果当作真实 GitHub 端到端验证。

   建议：退回修改前协调远端 PR 状态；已合并时保留原审核证据并进入可恢复的结算流程。外部合并应进入统一的状态核对路径，不能仅在验收与取消时处理。需要补充“GitHub 外部合并 → 要求修改”及并发合并的回归。

3. **P2 · 私有仓库 partial clone 的后续 worktree/merge 缺少授权，环境准备会失败。**

   位置：[local-agent.ts:141](../apps/desktop/src/worker/local-agent.ts#L141)、[local-agent.ts:171](../apps/desktop/src/worker/local-agent.ts#L171)、[local-agent.ts:178](../apps/desktop/src/worker/local-agent.ts#L178)。

   克隆使用 `--filter=blob:none`，授权仅通过临时环境变量传给 clone/fetch。创建 worktree 和合并任务分支没有传入 `gitEnvironment(project, accessToken)`。当任务基线、非默认分支或新合入成果的文件内容尚未下载，Git 会在这些操作中按需访问远端，因缺少凭证而失败或触发额外认证。存在本机凭据缓存、所需 blob 已缓存时，该问题可能被掩盖。

   隔离复现：真实本地 Git partial clone，非默认分支的目标 blob 确认缺失；本地 upload-pack 包装器模拟“必须携带临时授权”。真实 `LocalAgent.provision` 的 fetch 成功，worktree add 报 `FIXTURE_AUTH_MISSING`；同一目标用相同临时授权执行 worktree add 成功。仅绕过了测试用 file:// remote 的地址检查，未替换 fetch/worktree/merge 实现。未连接真实私有 GitHub 仓库。

   建议：向可能触发 blob 下载的受控 Git 操作传递临时授权，或先在带授权的阶段完整取得后续所需对象；继续保持凭据不写入 remote/持久配置。Git 的按需下载机制见 [Git partial-clone 官方说明](https://git-scm.com/docs/partial-clone)。

4. **P2 · 交付直接上传工作区原始字节，绕过 `.gitattributes` 的换行和编码转换。**

   位置：[local-delivery.ts:81](../packages/core/src/local-delivery.ts#L81)、[local-delivery.ts:92](../packages/core/src/local-delivery.ts#L92)、[github-service.ts:382](../apps/api/src/github-service.ts#L382)。

   `collectTaskChanges` 使用 Git 判断哪些文件变化，但随后直接读取磁盘内容；API 将这些内容直接创建为 Git blob。正常 Git check-in 应用的 text/eol、working-tree-encoding 等转换没有执行。因此，平台生成的提交内容可能与同一个工作区执行 `git add` 得到的内容不同。

   隔离复现包含两种明确属性：`file.txt text eol=crlf` 的正常 Git index 为 LF，交付包保留 CRLF；`script.ps1 text working-tree-encoding=UTF-16LE eol=crlf` 的正常 Git index 为 UTF-8/LF，交付包却是编码了 UTF-16LE/CRLF 原始字节的 base64。后者若直接成为 Git blob，将违背仓库声明的内部编码约定，给后续 checkout、审查和工具处理带来问题。本轮验证了交付包与真实 Git index 的差异，没有执行远端提交。

   建议：从遵循 Git check-in 规则的临时 index/对象读取交付内容，保留现有文件范围、二进制和 mode 校验；避免修改用户现有 index。包摘要与模型审查也应基于最终将进入仓库的内容。转换规则见 [Git gitattributes 官方说明](https://git-scm.com/docs/gitattributes)。

**仍需明确的既有信任边界**

以下是第三轮已经记录、当前代码仍保留的行为，未计入上述四项新问题：

- 私有项目合作者“申请”在 GitHub App 具备权限时直接发邀请，组织仓库授予 push，没有项目负责人审批。若部署面向不互信的成员，这应优先收紧。位置：`apps/api/src/github-service.ts:78`。
- 任务详情仅要求平台登录，返回执行者工作日志、测试输出、设备信息及相关用户邮箱；没有针对这些字段检查仓库访问权。提交源码还会保存在数据库的交付快照中。位置：`apps/api/src/app.ts:138`、`apps/api/src/task-service.ts:180`。
- setup/test 命令以宿主机用户权限执行并继承环境变量，`editablePaths` 只约束交付，`networkAllowlist` 没有实际网络执行限制。对不可信仓库、发布者或模型输出，这是宿主机信任边界，而非沙箱。位置：`apps/desktop/src/worker/local-agent.ts:63`。

这三项是否符合产品预期取决于部署成员的互信关系和授权约定，详见[第三轮报告](system-review-round3-2026-09-12.md)。

**回归与验证边界**

从仓库根目录运行：

```powershell
npm run build --workspace @techunter/core
npm run build --workspace @techunter/api
node --test apps/api/test/task-recovery-round4.test.mjs
npm run test --workspace @techunter/desktop
```

正式回归为 [task-recovery-round4.test.mjs](../apps/api/test/task-recovery-round4.test.mjs) 和 [local-delivery.test.ts](../apps/desktop/src/worker/local-delivery.test.ts)，随根目录 `npm test` 执行，断言修复后的正确行为。上方编号条目中的隔离复现结果属于修复前基线。PGlite 仅驻留内存；Git 测试使用独立临时目录，结束时核对绝对路径后清理。

本轮未核验线上数据库迁移是否已应用、真实 GitHub App/OAuth 权限与组织策略、Railway 运行状态、Windows 安装包签名或自动更新端到端流程。构建及依赖审计通过不能替代这些运行环境验证。
