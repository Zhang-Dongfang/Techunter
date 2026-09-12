**Techunter 系统审查 · 第六轮 · 2026-09-12**

审查基线：`295fa466a1bc0f336724f882ddc66a746453958f`，即上一轮已推送的修复。审查时确认三类问题：一项 P1、两项 P2。编号表示修复优先级，隔离复现不代表线上已发生事故。

**修复更新：以下三类问题已按用户要求修复。** 编号条目保留原问题证据与审查时行号，不代表修复后的现状。

- 释放关闭旧交付 PR，并在远端写入前后核对合并状态；已合并时终止释放，网络失败时保持操作可重试。新增迁移 `202609120008_release_settlement_recovery.sql`，历史已释放、转交以及出现较新失败交付的任务，可核对原快照并按原作者结算。恢复选中的提交被固定为结算依据，重试不会误选更新记录或重复支付；接手者的认领与工作区会停止，审计保留原归属。Desktop 提供历史交付恢复入口。
- 任务、项目、待审批范围请求及关联用户/项目均按不可变 ID 游标读取；任务更新时间变化不再影响分页位置，较低服务器行数上限也不会截断关联查询。显示排序在读取之后执行。多次 HTTP 查询并非覆盖所有并发状态变化的数据库事务快照。
- Windows 使用 Job Object 跟踪命令及后代，原 shell 退出也不会失去后代进程；准备、测试、命令台取消和退出共用清理逻辑，退出等待命令停止。保留 UTF-8 日志及退出码，不影响无关进程。

修复后新增 **13 项正式回归**，API 120、Desktop 22，共 **142 项测试通过**；全部 workspace 类型检查与完整构建通过。上线先停止旧 API 写入，应用迁移 008，再更新 API 和 Desktop。本次未执行生产迁移或部署。

1. **P1 · 退回后在 GitHub 合并的交付仍能被释放，导致原作者失去结算入口。**

   位置：[task-service.ts:364](../apps/api/src/task-service.ts#L364)、[task-service.ts:495](../apps/api/src/task-service.ts#L495)、[202609120005_claim_recovery_and_drafts.sql:30](../infra/supabase/migrations/202609120005_claim_recovery_and_drafts.sql#L30)。

   正常触发顺序是：Alice 的交付预审通过 → 维护者要求修改，任务回到 active → 维护者随后直接在 GitHub 合并原 PR → Alice 释放任务。释放过程只同步 Issue 的执行者和标签，没有读取 PR 状态，数据库成功将任务变为 open 并清空执行者。

   第四、五轮新增的合并恢复要求任务仍为 active，而且 submission.author 必须等于当前 assignee。释放后不满足这些条件；Bob 接手后作者仍为 Alice，也无法恢复该笔交付。管理员取消则被已合并 PR 检查拒绝。代码已合并，原交付既不能通过现有验收入口结算，也不能退款；让新执行者重新提交相同代码并不是正确恢复原作者归属的办法。

   复现应用全部真实迁移，调用实际 TaskService/GitHubService 的要求修改、释放、重新认领、验收和取消方法；GitHub 为替身，初始已审核提交由数据库函数和已保存 tree 构造。观察结果：释放期间读取 PR 次数为 0，释放返回 open，Bob 认领成功，原交付验收返回 409，取消返回 `PULL_ALREADY_MERGED`，项目 available=0、reserved=100，没有 settlement/refund 流水。

   建议：释放流程也核对既有交付的远端结果，已合并时保留原作者和验收意图，提供结算恢复。对尚未合并的旧 PR，要防止释放之后继续被外部合并却失去归属；恢复能力应依据不可变的提交作者和审核证据，而不是只依赖当前执行者。历史已释放记录需要单独恢复路径，不宜直接把奖励结算给接手者。

2. **P2 · 完整列表读取仍有漏项和失败边界：翻页时数据变化，以及关联查询被行数上限截断。**

   位置：[database-pagination.ts:9](../apps/api/src/database-pagination.ts#L9)、[task-service.ts:159](../apps/api/src/task-service.ts#L159)、[task-service.ts:688](../apps/api/src/task-service.ts#L688)。

   `readAllRows` 按已收到的行数继续 offset，任务按可变的 updated_at 排序。若尚未读取的一条任务在两页之间更新，它会移到已读区间，而下一页的 offset 会重复读到原第一页末尾的任务。总行数仍与 count 相等，循环正常结束，既不去重也不发现漏项。

   真实 Supabase SDK 与 TaskService 的 HTTP 替身复现：501 条任务，第一页读取 500 条；原第 501 条 active 任务更新到顶部；第二页再次读到原第 500 条。最终返回 501 条，但只有 500 个不同 ID，唯一 active 任务缺失。相同数据无并发更新时返回 501 个不同 ID。这里不需要把服务器行数上限调低。

   另一个独立边界是 `rowsByIds` 将用户/项目 ID 每 100 个分组，却没有分页或校验返回数量。如果服务器上限小于 100，主任务列表虽然读全，关联用户或项目仍会缺失。替身设置 cap=73、100 条任务来自 100 名发布者时，任务执行两次查询全部读到，用户只查一次、读到 73 人，整个列表抛出“任务关联的项目或用户不存在”。相同数据 cap=1000 时成功。此边界依赖具体服务器设置；未核验线上 cap。

   建议：使用不会因 updated_at 变化而移动的读取游标或数据库一致快照，并在服务端完成关联与需要的统计；不要仅在现有 updated_at offset 分页末尾去重，因为那仍无法找回遗漏项。关联查询也应处理实际返回上限，并补充缺少 assignee 时不会被默认为未认领的校验。

3. **P2 · Windows 命令超时只结束 PowerShell，实际测试子进程仍可继续运行和写文件。**

   位置：[local-agent.ts:63](../apps/desktop/src/worker/local-agent.ts#L63)、[local-agent.ts:80](../apps/desktop/src/worker/local-agent.ts#L80)。命令台取消及退出也使用单进程 kill，见 [main.ts:179](../apps/desktop/src/desktop/main.ts#L179)、[main.ts:338](../apps/desktop/src/desktop/main.ts#L338)。

   `runShell` 启动 powershell.exe，超时调用该 shell 的 `child.kill()`，没有管理整个命令进程树。npm、Node、测试执行器等由 shell 启动的后代不一定随其退出；旧命令可能继续修改产物、占用端口或锁文件，与用户重试的新命令相互干扰。

   本轮在实际 Windows PowerShell/Node 上调用 LocalAgent.test，使用独立临时 Git 工作区。诊断仅把原本 15 分钟的超时定时器缩短为 1.4 秒，保留真实启动、kill、日志与退出处理代码。Node 测试子进程在超时触发后约 1.3 秒仍成功写入标记文件，LocalAgent 返回 passed=false。子进程自行退出，临时目录经边界检查后清理。未在 Electron UI 实测点击取消，也未验证 Linux/macOS。

   Node 文档将 `subprocess.kill()` 定义为向指定子进程发送信号，并另行说明 shell 后代存活的情形；本报告的 Windows 结论来自上面的实际复现，而非将文档的 Linux 示例当作 Windows 测试。[Node 子进程终止说明](https://nodejs.org/api/child_process.html#subprocesskillsignal)。

   建议：统一管理本应用创建的命令进程树，Windows 可采用 Job Object 或受控进程树终止机制；超时、手动取消与退出共用清理逻辑。确认所属后代停止后，再允许同一工作区重试，并覆盖后代延迟写入的回归。

以下为修复前的审查验证结果：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 所有 workspace 通过 |
| `npm test` | API 112、Desktop 17，共 129 项通过 |
| `npm run build` | Core、API、Desktop 全部通过 |
| 新增独立诊断 | 4 项观察到问题行为：释放 1、列表 2、命令超时 1 |

原诊断脚本已经转为正式回归，随 `npm test` 执行，断言修复后的行为。可在仓库根目录单独执行：

```powershell
npm run build --workspace @techunter/core
npm run build --workspace @techunter/api
node --test apps/api/test/task-recovery-round6.test.mjs apps/api/test/list-consistency.test.mjs apps/api/dist/task-list.test.js
npm run test --workspace @techunter/desktop
```

正式回归：[释放、历史结算与升级](../apps/api/test/task-recovery-round6.test.mjs)、[列表完整性](../apps/api/test/list-consistency.test.mjs)、[命令清理](../apps/desktop/src/shared/command-process.test.ts)、[实际 LocalAgent 测试超时](../apps/desktop/src/worker/local-agent.test.ts)。覆盖合并与释放竞争、远端失败重试、原作者结算、更新提交后的固定恢复、授权和版本检查、旧数据库升级、更新期间翻页、低行数上限，以及 Windows 父进程提前退出、超时、手动取消、退出清理和无关进程隔离。

数据库使用内存 PGlite，GitHub 和 Supabase HTTP 请求为本地替身；命令测试仅操作临时目录。未访问生产数据库、执行生产迁移、向 GitHub 写入或调用付费模型。本轮未重新执行依赖审计、生产配置核验或 Electron 界面/安装包端到端测试；非 Windows 平台的进程组行为未在本机验证。已取消或错误退款的历史记录仍需核对账本，本次没有自动冲正。

前几轮记录的私有仓库自动邀请、共享任务详情中的日志与邮箱、宿主机命令信任边界仍需按部署需求处理，未重复计入新问题；背景见[第五轮报告](system-review-round5-2026-09-12.md)。本轮命令问题属于执行生命周期缺陷，处理任意宿主机命令的权限约定本身不能保证超时后进程已停止。
