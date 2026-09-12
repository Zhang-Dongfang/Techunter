**Techunter 系统复查 · 2026-09-12**

审查基线：`a5244dfd97571d8246d40f8d0ffba32c6c8689f8`。范围包括 API、Supabase 全部迁移、Core、CLI/MCP、Electron、本机工作环境、主要 UI 与构建发布配置。本报告补充当前代码中新发现的问题；不重复将上一份报告中已修复的问题列为现存缺陷。

确认 9 项新问题：3 项 P1（优先处理的代码/结算一致性和流程阻塞问题），6 项 P2（特定使用条件下可复现的功能问题）。审查阶段仅增加仓库内的审查报告与隔离复现脚本，未修改业务代码或数据库迁移；随后按用户要求修复，见下方更新。CLI 启动对照验证另有本机配置副作用，见第 9 项和文末说明。

| 验证 | 本次结果 |
| --- | --- |
| `npm run typecheck` | 全部 workspace 通过 |
| `npm test` | 77 项通过：API 62、Desktop 11、CLI 4 |
| `npm run build` | Core、CLI、API、Desktop 全部通过 |
| `npm audit --json` | 当前锁文件 0 项漏洞告警；不代表应用逻辑没有安全问题 |
| 独立复现 | 7 个场景全部触发预期缺陷。使用 PGlite 应用全部迁移，实际 TaskService/数据库函数运行；GitHub 用本地替身 |
| CLI 最低版本运行 | 实际使用 Node 18.20.8 启动构建后的 CLI，报 `ReferenceError: File is not defined`，退出码 1 |

**修复更新**：本报告下方保留修复前的发现与验证结果。当前分支已删除 CLI/MCP、对应依赖和配置回退，并修复第 1–7 项。原缺陷复现已转为 [`apps/api/test/task-coordination.test.mjs`](../apps/api/test/task-coordination.test.mjs) 中的正式回归测试，随 `npm test` 运行；GitHub 适配层和 Desktop 另有对应测试。新增迁移为 [`202609120004_task_coordination.sql`](../infra/supabase/migrations/202609120004_task_coordination.sql)，升级条件见 [数据库说明](../infra/supabase/README.md)。下方 CLI 启动验证属于历史记录，当前版本不再提供该入口。

修复验证：`npm run typecheck`、`npm run build` 通过；API 80 项、Desktop 13 项共 93 项测试通过；`npm audit --json` 为 0 项漏洞告警。新增测试覆盖双向验收/取消竞争、明确拒绝与未知合并结果、旧数据迁移及未完成操作、父任务换人保留子任务成果、认领部分失败恢复、多设备提交、分支切换并发、Direct 模型模式与 RPC 权限。验证使用内存 PostgreSQL、本地 Git 仓库和 GitHub/模型替身，没有部署到线上环境。

升级需先应用新迁移，再更新 API 和 Desktop；提交接口新增必填 `workspaceId`。历史分支冲突、外部删除分支或已变化的旧审核快照仍需核对真实仓库数据，详见数据库说明。GitHub 合并拒绝分类结合[官方合并接口说明](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)及再次读取的 PR 状态，网络超时不会被当作确定拒绝。

1. **P1：验收与取消缺少互斥，可能出现代码已合并、任务被取消、积分被退回。**

   位置：`apps/api/src/task-service.ts:316`、`:487`；`infra/supabase/migrations/202609120001_submission_recovery.sql:213`。

   验收先执行 GitHub 合并，再调用 `accept_task` 结算。其审核占用只存放在 `submissions.review_action`。取消流程只查询 `task_operations`，而 `admin_remove_task` 仅拒绝已经进入 `accepted` 的任务，不检查正在进行的验收决定。因此，GitHub 已合并但数据库尚未结算时，取消操作仍可提交并退款；后续验收因状态成为 `cancelled` 而失败。

   复现让 GitHub 替身在完成合并后暂停，调用实际 `removeTask`，再继续验收。结果：`githubMerged=true`、`status=cancelled`、退款 100，验收返回“任务当前不在待验收状态”。这验证了本地状态机与账本缺少互斥；没有把替身结果当作真实 GitHub 端到端测试。

   建议让验收和取消共享持久化操作与数据库互斥。已有验收意图或合并结果未确认时，禁止退款取消；记录合并结果并允许幂等恢复结算。

2. **P1：父任务完成子任务后换人，新的任务分支丢失已验收子任务的成果。**

   位置：`apps/api/src/github-service.ts:284`，尤其 `:298`；`apps/api/src/task-version.ts:22`；`infra/supabase/migrations/202608210001_techunter_schema.sql:358`。

   子任务合并目标是父任务当前执行者的分支，例如 `task-3-alice`。所有子任务完成后，父任务允许释放并重新认领。Bob 接手时，`ensureTaskBranch` 创建 `task-3-bob`，起点仍为父任务最初冻结的 `baseSha`，没有继承 Alice 分支上已经验收的子任务提交。子任务记录和已支付积分则继续保留。

   复现建立奖励 100 的父任务、奖励 40 且已验收的子任务，在旧父分支放入子任务合并 SHA。释放并让 Bob 认领后，新分支 HEAD 为最初的 `aaaaaaaa…`，旧分支的成果为 `dddddddd…`，子任务仍是 `accepted`。此处旧分支没有被删除，问题是新执行者的默认工作基线不包含成果，需要手工找回；不能描述成 Git 对象已永久丢失。

   建议采用不随执行者变化的任务集成分支，或在交接操作中保存并转移已集成 HEAD。保持原 `baseSha` 的冻结语义，同时明确区分原始基线与任务当前成果。

3. **P1：合并被明确拒绝后，审核决定仍锁定为 accept，正常退回修改流程被阻断。**

   位置：`apps/api/src/github-service.ts:471`；`infra/supabase/migrations/202609120001_submission_recovery.sql:86`；`apps/api/src/task-service.ts:495`。

   调用 GitHub merge 前，`start_submission_review` 把 `review_action` 永久写成 `accept`。如果 GitHub 因冲突或限制明确拒绝合并，代码没有恢复审核状态。之后 `request-changes` 被 `REVIEW_ACTION_CONFLICT` 拒绝，任务保持 `submitted`，执行者也不能走正常的重新提交流程。若直接 push 修复冲突，审核 tree 又会失效，验收要求重新交付，而重新交付仍不可用。

   复现注入明确的合并失败响应后，再调用实际 `requestChanges`：任务仍为 `submitted`，返回 `REVIEW_ACTION_CONFLICT`。保留“结果未知”操作的恢复意图是必要的，但目前没有为“确定未合并”提供可恢复的状态转换。

   建议持久化区分合并成功、确定失败、结果未知；在确认未合并且没有并发验收执行者时，原子释放该审核决定，允许退回修改。

4. **P2：认领成功后的一次数据库读取失败，会留下 GitHub 尚未同步的 active 任务，原请求无法重试。**

   位置：`apps/api/src/task-service.ts:338`。

   `claim_task` 先在数据库认领，随后 `getTask`、`getProject` 位于补偿 `try/catch` 之外。任一读取失败，API 报错但认领仍生效，`syncClaim` 尚未运行；同一用户重试认领也会被 `TASK_ALREADY_CLAIMED` 拒绝。进程在该窗口退出也有同类风险。

   复现注入认领后的 `getTask` 瞬时读取失败：数据库 `active`，GitHub 同步调用次数 0，原执行者重试失败。目前可以通过额外释放再认领尝试恢复，因此这项不应描述为永久锁死。

   建议认领也使用可恢复的持久化操作，并允许同一认领者幂等续接。补偿还应检查 RPC 错误，避免忽略回滚失败。

5. **P2：同一账号使用多台设备时，较新的失败工作区会阻止正常设备提交。**

   位置：`apps/api/src/task-service.ts:185`、`:391`；`apps/desktop/src/web/src/App.tsx:498`。

   `getTask` 虽已按执行者筛选 workspace，但仍取所有设备中创建时间最新的一条。`submitTask` 和 Desktop 提交按钮使用这条记录判断是否准备完成，提交接口没有传入当前 workspace/device 标识。

   复现设备 A 工作区为 `running`，随后设备 B 准备失败成为 `failed`。A 的数据库记录依然是 `running`，实际提交却返回“本机工作环境尚未准备完成”，任务详情选中的设备为 B。重复准备 A 还会复用 A 的旧记录，不改变其创建顺序，因而不能可靠消除这个问题。

   建议提交明确绑定 `workspaceId`，服务端验证执行者、当前认领生命周期和状态；任务详情按当前设备选择工作区，或返回列表由客户端准确选择。

6. **P2：普通项目同步可以覆盖管理员并发完成的来源分支切换。**

   位置：`apps/api/src/task-service.ts:77`、`:88`、`:105`。

   `syncProject` 读取当前 `sourceBranch` 后等待 GitHub 请求，随后无条件写回该旧分支与对应 `headSha`。期间管理员可能已通过 `switchProjectBranch` 切换到另一分支。同步没有版本条件，较晚返回的旧请求会撤销管理员设置；创建任务入口也会调用该同步。

   复现暂停读取 main 的普通同步，让管理员成功切换 release，再继续旧同步：最终 `sourceBranch` 回到 main。后续草稿可能冻结错误的分支和 SHA。

   建议为项目版本信息使用条件更新；普通同步只在来源分支仍等于本次读取值时更新对应 SHA，否则重新读取。仅删除 `source_branch` 写入仍不充分，因为旧分支的 `head_sha` 同样会覆盖新分支版本。

7. **P2：直连 AI 模式的聊天创建任务仍硬性要求 Conexus 模型凭据。**

   位置：`apps/api/src/assistant-service.ts:55`、`:146`。

   `chat()` 支持 `AI_ACCESS_MODE=direct`，可以使用服务端 `AI_API_KEY`。但 `create_task` 工具在创建草稿后，无条件要求 `input.modelCredential` 和 `input.modelAudience`。因此在直连模式、当前 Conexus 模型票据已过期而 Techunter 登录会话仍有效时，聊天可以工作，创建并分析任务却中途失败，还会留下草稿。

   复现执行实际工具回调，输入有用户和 GitHub 凭据、没有模型票据：草稿已创建，分析未调用，返回 `CONEXUS_AUTHORIZATION_REQUIRED`。未调用实际模型；验证的是工具内部必经的凭据检查。

   建议按实际 `accessMode` 校验所需凭据，并把授权检查移到创建草稿之前。直连模式调用 `analyzeTask` 时应允许不传 Conexus 授权。

8. **P2：CLI 声明支持 Node 18，实际构建产物在该版本上无法启动。**

   位置：`apps/cli/package.json:58`；`apps/cli/tsup.config.ts:12`；`apps/cli/src/lib/proxy.ts:2`。

   发布包的 `engines.node` 为 `>=18.0.0`，构建目标也是 `node18`，但 CLI 启动时静态导入的 undici 7 要求更高的 Node 版本。当前安装的 undici 在模块初始化时引用全局 `File`，在 Node 18 上直接抛异常。构建器的 target 不会为缺失的运行时 API 自动补实现。

   实测：使用 Node 18.20.8 执行 `apps/cli/dist/index.cjs --version`，退出码 1，错误为 `ReferenceError: File is not defined`，堆栈指向打包后的 `undici/lib/web/webidl/index.js`。这是实际版本运行测试，而非仅凭依赖元数据推断。测试运行时通过 `npm exec --package=node@18.20.8` 获取到 npm 缓存，没有更换系统 Node。后续启动回归应使用隔离的配置目录和拦截网络，避免第 9 项的启动副作用。

   建议把公开声明的最低 Node 版本、依赖要求与构建目标统一，并在 CI 增加最低支持版本的 CLI/MCP 启动检查。目前 CI 只用 Node 24，不能发现这一兼容性错误。

9. **P2：CLI 忽略 `--version` 等未知参数，进入会写配置和调用外部服务的常规启动流程。**

   位置：`apps/cli/src/index.ts:152`、`:135`、`:189`、`:209`。

   `main()` 只分派 `config` 命令，没有处理 `--version` 或拒绝未知参数。常规启动会读取/刷新凭据、根据当前目录切换全局仓库配置、初始化 GitHub 标签，还会启动自动更新检查。因此读取版本的命令实际上有初始化与联网副作用，不能用作安全的部署探测或版本兼容性检查。

   本轮在 Node 24.14.0 上启动 CLI 并传入 `--version`，实际输出为“New repo detected”“Labels ready”和 REPL 任务列表，而不是打印版本后退出。源码确认 `setConfig({ github: ... })` 已执行；`ensureLabels` 会先读取现有标签，仅对缺失项发起创建。终端输出不能证明这次是否创建了新标签。

   建议在任何配置、凭据、仓库、更新操作之前解析参数，版本/帮助信息打印后立即退出；未知参数返回明确错误。为这些入口添加无网络、无持久化写入的启动测试。

优先处理 1–3 的状态机和代码交接，再修复 4–9。当前测试主要覆盖单项操作和已知回归，缺少“跨操作竞争”“跨认领生命周期”“多设备”和最低运行时版本的组合场景。报告中的复现可作为新增回归测试的依据。

本轮没有核验线上环境变量、实际已应用的 Supabase 迁移、GitHub App/组织权限配置、真实 OAuth、安装包/自动更新和 Linux Docker 部署，也没有进行负载测试。部署健康检查当前只返回进程及配置状态，不能据此判断数据库迁移或外部服务可用。依赖扫描清零与所有测试通过，均不能排除这些运行边界问题。

**验证副作用说明：**第 9 项的 Node 24 对照命令没有事先隔离 CLI 配置，这是本轮验证的疏漏。它已将本机 CLI 的默认仓库改为 `Zhang-Dongfang/Techunter`，调用 GitHub 标签检查并读取任务列表；无法从现有输出确定有无新增标签，也没有原配置快照可准确恢复先前仓库。这之后停止了真实配置下的 CLI 启动验证，没有执行任务认领、提交、验收或积分结算。前述 7 场景的复现脚本仍全部使用隔离数据与外部服务替身。
