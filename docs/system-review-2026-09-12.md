**Techunter 系统审查记录 · 2026-09-12**

审查基线：`c9bf25130a07335bc8700c308c38198e7887178c`。范围包括共享 Core、API、Supabase 迁移、CLI/MCP、Desktop 的本机 Agent 与主要 UI 流程，以及构建和发布配置。

发现 11 项应用层问题。P1 表示应优先修复的权限、状态一致性或数据完整性问题；P2 表示特定使用条件下的明确功能缺陷。本报告区分代码追踪、本地数据库复现和外部服务替身验证，不将替身测试描述为线上端到端验证。

首次审查未修改业务代码；下表是修复前基线。随后按“帮我修复”的要求完成了本文 11 项问题的代码修复及依赖更新，实施说明见下文。验证使用本地数据库和外部服务替身，未连接线上 Supabase 或执行实际 GitHub 写入。

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 全部 workspace 通过 |
| `npm test` | 62 项通过：API 52、Desktop 9、CLI 1 |
| `npm run build` | Core、CLI、API、Desktop 全部通过 |
| 隔离复现 | 使用内存 PGlite 应用全部迁移，并调用实际 TaskService；GitHub 使用替身。另使用临时 Git 仓库验证字节完整性，使用拦截 fetch 验证 CLI 并发 |
| `npm audit --json` | 4 个依赖包告警：2 high、2 moderate；均报告存在修复版本 |

**修复结果**

| 修复后验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 所有 workspace 通过 |
| `npm test` | 77 项通过：API 62、Desktop 11、CLI 4 |
| `npm run build` | Core、CLI、API、Desktop 全部通过 |
| `npm audit --json` | 0 项漏洞告警 |
| `git diff --check` | 通过 |

1. 子任务插入与发布均在数据库中复核父任务状态和当前执行者/管理员权限；API 同时提前拒绝越权请求。
2. 带中央 task ID 的 CLI 认领、交付、验收、退回、取消统一经过 API；校验中央任务对应的仓库、Issue 和 GitHub 身份。中央子任务通过 Desktop 创建，独立任务不能移动到中央任务下。
3. 独立 GitHub 任务以原子创建 Git ref 决定认领者，失败后仅原执行者可恢复；关闭时清理认领 ref。所有参与客户端需要升级，手工 GitHub 修改不参与该互斥。
4. 预审交付保存不可变 Git tree SHA，验收严格比对；旧已预审交付从保存的包重建快照。范围内追加提交也必须重新审核。
5. 释放任务纳入持久化操作和可续租机制，GitHub 同步失败时保持占用，可重试原操作，完成后才开放新认领。
6. CLI 与 Desktop 共用字节安全的打包函数；不能逐字节还原的 UTF-8 使用 base64。
7. 交付包携带普通/可执行文件模式，API 保留旧客户端文件原有模式，并支持显式 chmod。
8. 重复导入原子返回既有项目，保留来源分支和导入者，初始化贡献点只执行一次。
9. 工作环境按当前执行者和设备匹配，释放、重新认领、结算、取消使旧记录停止，禁止旧记录重新启用。
10. Conexus 用户按完整稳定 ID 原子 upsert，同邮箱前缀、并发首次登录和旧用户名碰撞均有回归覆盖。
11. 聊天请求仅发送最近 16 条有效历史，单条截至 API 接受的长度；界面保留完整历史。

`fast-uri`、`js-yaml`、`hono`、`qs` 已在兼容范围内更新。上线先应用新增迁移 `infra/supabase/migrations/202609120003_system_integrity.sql`，再替换 API 并升级客户端；本次没有部署线上服务。详细顺序见 [Supabase README](../infra/supabase/README.md)。

以下为原始问题证据，行号对应修复前基线。

1. **P1：创建子任务缺少父任务执行者权限校验。**

   位置：`apps/api/src/task-service.ts:259`、`apps/api/src/app.ts:187`、`infra/supabase/migrations/202609120002_durable_task_operations.sql:55`。

   `createDraft` 检查项目和父任务状态，但没有检查调用者是否为父任务执行者。后续发布只检查子任务自己的发布者身份以及父任务预算。拥有相关 GitHub 访问能力的其他用户因此可以给别人的任务添加子任务。前端按钮仅对执行者显示，不能替代服务端鉴权。

   本地数据库复现：父任务执行者为 worker、奖励 100；other 用户成功创建、分析并发布奖励 80 的子任务，状态为 open。随后 worker 释放父任务被 `OPEN_CHILD_TASKS` 拒绝。未完成子任务同样会阻止父任务提交；即使只是遗留草稿也可能阻塞工作流。

   修复：在服务端和数据库事务中验证父任务执行者/明确授权的管理员，并在插入、发布时锁定并复核父任务状态和归属。同步收紧目前允许 submitted 父任务新增草稿的入口，避免审核期间插入新的阻塞项。

2. **P1：CLI 和中央控制面没有共享任务状态写入链路。**

   位置：`apps/cli/src/lib/github.ts:173`、`apps/cli/src/lib/github.ts:684`、`apps/api/src/app.ts:222`。

   Desktop 发布的 Issue 可以被 CLI 读取，但 CLI 的认领、提交、验收直接修改 GitHub。Webhook 只保存 delivery ID、事件名和 payload hash，未把事件应用到 tasks、claims、submissions 或贡献点账本；仓库中也没有消费这些记录的后台同步流程。

   代码追踪推导出的触发场景：Desktop 发布任务后，A 用 CLI 认领，Supabase 中任务仍为 open；B 仍可能从 Desktop 认领。CLI 验收/关闭 Issue 也不会自动完成中央任务结算。CLI 提交流程还会直接暂存全部工作区改动，未调用中央 editablePaths 校验。这些问题影响两个客户端混用同一任务的场景，不能由“共享标签和元数据格式”保证一致性。

   修复：对带中央 task ID 的任务统一通过 API 执行状态变更，并使用同一套范围、审核和账本校验；若保留 GitHub 外部操作，补充经过验证、幂等且可重试的事件协调机制。

3. **P1：CLI 自身的并发认领不是原子操作。**

   位置：`apps/cli/src/lib/github.ts:182`。

   当前顺序是读取 Issue、检查 available、更新 assignees、移除 available、添加 claimed。两个调用可以同时读到同一份可认领状态，随后各自执行写入，没有原子条件更新或互斥。

   已用拦截 fetch 的本地替身复现：alice、bob 同时执行实际 `claimTask`，两次 Promise 均 fulfilled，最后的 assignee 为 bob。先收到成功的用户仍可能继续创建分支、开展工作。

   修复：接入中央 `claim_task` 原子认领；不要依赖 GitHub 标签的多次读写实现分布式锁。

4. **P1：最终验收没有绑定 AI 预审过的代码版本。**

   位置：`apps/api/src/task-service.ts:494`、`apps/api/src/github-service.ts:438`。

   API 校验最新 submission 为 approved；GitHub 合并前则验证当前 PR 的文件范围和校验期间 HEAD 是否变化。这只能防止校验期间的并发 push，没有比较“预审时的代码快照”和“本次准备合并的快照”。作者在预审通过后、验收开始前再次 push editablePaths 内的代码，仍可沿用原来的预审通过状态。

   本地替身验证：PR 当前 HEAD 为 `changed-after-review`，范围合法且两次读取一致，实际 `completeTask` 将该 HEAD 传入 merge。流程没有读取已保存的审核包进行内容比对。

   修复：保存提交后对应的不可变 commit/tree SHA，验收时要求 PR HEAD 或完整 tree 与已审核快照一致；发生改变时使预审失效，重新提交或审核。

5. **P1：释放任务在 GitHub 失败后留下不一致状态，原请求无法重试。**

   位置：`apps/api/src/task-service.ts:372`。

   `release_task` 先把数据库任务改成 open 并清空执行者，然后才执行 `syncRelease`。GitHub 超时或权限错误时，Issue 仍可能显示原执行者与 claimed，数据库却已经重新开放认领。再次调用 release 又因任务不再 active 而被拒绝。

   本地数据库复现：注入 GitHub 同步失败后，调用报错但任务状态已为 open；重试返回“只能释放自己正在执行的任务”。发布和提交已有 durable operation，释放尚未纳入同一恢复机制。

   修复：将 release 的 GitHub 同步纳入持久化操作，支持幂等恢复，并避免旧 release 的迟到写入覆盖后来一次认领的 GitHub 状态。

6. **P1：非 UTF-8 文件可能在交付打包时被静默改坏。**

   位置：`apps/desktop/src/worker/local-agent.ts:342`。

   当前只用 `data.includes(0)` 判断二进制；没有 NUL 的文件都会执行 `toString('utf8')`。GBK、Shift-JIS 等文本以及部分二进制数据可能没有 NUL，但并不是有效 UTF-8。解码替换字符会永久改变提交包字节，GitHub 随后上传的是错误内容。

   使用临时 Git 仓库调用实际 `collectChanges` 复现：原始字节 `82a082a2` 被作为 UTF-8 打包，恢复后变成 `efbfbdefbfbdefbfbdefbfbd`，`bytesPreserved=false`。

   修复：先严格验证 UTF-8 或检查 UTF-8 编解码是否能逐字节还原；无法还原的文件使用 base64。加入非 UTF-8 文本与无 NUL 二进制回归用例。

7. **P2：提交文件统一写成 100644，丢失可执行权限。**

   位置：`apps/api/src/github-service.ts:370`、`apps/api/src/github-service.ts:377`、`packages/core/src/platform-types.ts:181`。

   Git tree 的每一个提交文件都被强制指定 `mode: '100644'`，PackageFile 也没有承载 mode。修改已有 100755 shell 脚本时，即使仅修改内容，也会把远端脚本变成不可执行文件，导致 Linux 下直接运行脚本失败。

   已用 GitHub 替身捕获实际 createTree 参数：提交 `scripts/run.sh` 的 mode 恒为 100644。现有提交测试只模拟文件内容，没有覆盖 mode。

   修复：读取并保留原树的文件模式，为新增文件和显式 chmod 定义提交契约；对不支持的 Git 对象类型明确拒绝。

8. **P2：重复导入项目会覆盖管理员选定的来源分支和导入者。**

   位置：`apps/api/src/task-service.ts:67`、`apps/api/src/task-service.ts:78`、`apps/api/src/task-service.ts:87`。

   对已经存在的仓库，`importProject` 仍写入完整初始化 payload，包括 `source_branch: repository.defaultBranch` 和当前 `imported_by`。导入接口允许普通成员调用，因而重复导入可绕过专门切换分支接口的角色限制，重置项目设置。

   本地数据库复现：管理员将来源分支改成 release；普通成员 other 对同一仓库再次导入后，来源分支变成 main，importedBy 变成 other。已有任务的冻结 SHA 未变化，但后续任务会从错误分支创建。

   修复：重复导入应返回现有项目，或只刷新仓库元数据；保留 sourceBranch 与 importedBy。初始化和后续配置更新使用不同的字段集合。

9. **P2：同一设备换账号接手任务，会复用前一个用户的工作区记录。**

   位置：`apps/api/src/task-service.ts:385`、`apps/api/src/task-service.ts:401`。

   查找已有 workspace 时只过滤 task_id、device_id 和状态，没有 user_id；返回后，更新 workspace 又要求数据库记录的 user_id 等于当前用户。

   本地数据库复现：worker 在设备 D 创建 running 工作区后释放任务，other 在同一设备接手；`createWorkspace` 返回同一个旧 workspace ID，other 更新 provisioning 时被拒绝。正常 UI 会在开始本机准备前遇到此错误。

   修复：工作区复用条件包含当前用户和认领生命周期；释放或重新指派任务时使旧工作区记录失效。多设备展示和提交就绪检查也应选用当前设备/当前执行者的记录。

10. **P2：不同邮箱具有相同前缀时，第二个用户无法首次登录。**

    位置：`apps/api/src/auth.ts:144`、`infra/supabase/migrations/202608210001_techunter_schema.sql:14`。

    新用户 login 仅取邮箱 @ 前缀，但数据库 login 是全局唯一字段。`sam@first.invalid` 与 `sam@second.invalid` 对应不同 Conexus 身份，却都会生成 sam；没有冲突重试或唯一后缀。

    使用完整迁移后的内存数据库验证，第二条插入报 `duplicate key value violates unique constraint "users_login_key"`。这一复现验证了用户名生成结果与数据库约束的冲突，未执行实际 Conexus 登录。

    修复：从稳定的用户 ID 生成唯一 login，或添加稳定后缀并处理并发唯一冲突；展示姓名与身份标识分离。

11. **P2：聊天完成 11 轮后，第 12 次发送会固定失败。**

    位置：`apps/desktop/src/web/src/AgentDock.tsx:55`、`apps/api/src/app.ts:51`。

    前端每次发送全部历史消息，后端限制 history 最多 20 条。完成 11 轮问答后有 22 条历史，第 12 次请求被 Zod 拒绝；失败后前端还会保留本次用户消息，后续重试不会自行恢复。Core 虽然只使用最近 16 条，但请求在到达 Core 前就被拒绝。

    直接使用从源码提取的实际 assistantBody schema 验证：20 条通过，22 条报 `Array must contain at most 20 element(s)`。

    修复：发送前按 API 契约截取历史，必要时摘要较早对话，并处理单条回复超过 20,000 字符的情况。

**依赖安全扫描补充**

`npm audit` 在当前锁文件中报告以下四个包存在已知漏洞。此处是依赖版本告警，尚未证明 Techunter 的业务调用路径可以利用每项漏洞。

| 包 | 安装版本 | 扫描级别 | 主要依赖路径 | 建议 |
| --- | --- | --- | --- | --- |
| fast-uri | 3.1.5、4.1.2 | high | Core 的 conf/ajv；API 的 Fastify 编译器和序列化依赖 | 更新至包含修复的兼容版本 |
| js-yaml | 4.3.1 | high | electron-updater、electron-builder | 更新至修复版本，并验证更新清单读取和打包 |
| hono | 4.13.3 | moderate | CLI 的 MCP SDK | 更新依赖并验证 MCP 启动 |
| qs | 6.15.3 | moderate | MCP SDK → Express/body-parser | 更新依赖并验证相关传输入口 |

已核对维护者公告：fast-uri 的该项修复版本包含 3.1.6、4.1.3；js-yaml 的 4.x 修复版本为 4.3.2。来源：[fast-uri 公告](https://github.com/fastify/fast-uri/security/advisories/GHSA-f65p-4m7j-42xc)、[js-yaml 公告](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh)。另外两包来自本次 npm audit 的公告：[Hono](https://github.com/advisories/GHSA-g6gw-c38x-mqfc)、[qs](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)。

建议先修复子任务权限、CLI/中央状态一致性及原子认领、验收代码版本绑定和释放恢复；随后修复字节/文件模式完整性，再处理项目、工作区、登录与聊天问题。依赖升级可以单独形成小改动验证。

这轮没有验证线上环境变量、实际部署的迁移版本、GitHub App 权限、真实 OAuth/安装包/自动更新流程，也没有进行负载测试。所有现有测试通过并不能排除本报告列出的跨模块问题；CLI 现有自动化测试只有 1 项，UI 聊天和账户切换工作流尚缺少对应回归覆盖。
