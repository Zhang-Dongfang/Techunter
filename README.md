# Techunter / 科技猎人

AI 驱动的任务分发与协作平台。Electron Desktop 提供任务市场、本机工作环境和交付界面，中央 API 负责 GitHub 协作、模型调用与贡献点结算。

- [`apps/desktop`](apps/desktop/README.md)：React UI、Electron 和本机 Agent
- [`apps/api`](apps/api/README.md)：Railway 中央控制面，连接 Supabase、Conexus 与 GitHub
- [`packages/core`](packages/core)：共享 Agent、仓库工具、任务约定和 API 类型

## 开发

需要 Node.js 24 或更新版本、npm 和 Git。本机 Desktop 连接 `TECHUNTER_API_URL` 指定的中央 API。

```powershell
npm install
Copy-Item apps/desktop/.env.example apps/desktop/.env
# 在 apps/desktop/.env 中配置 TECHUNTER_API_URL
npm run dev          # 启动本地 UI 和 Electron
npm run dev:api      # 调试中央 API 时另行启动，需要配置根目录 .env
npm run typecheck
npm test
npm run build        # 构建 core、API 和 Desktop
```

Windows 安装包与更新配置见 [Desktop 文档](apps/desktop/README.md)。中央 API 的部署顺序和环境变量见 [API 文档](apps/api/README.md)。

## 工作流程

1. 使用 Conexus 账号登录 Desktop，连接 GitHub 账号并导入有访问权限的仓库。
2. 创建任务，由 Task Agent 分析源码、生成验收标准、修改范围和环境计划；确认发布后创建 Issue 并冻结贡献点。
3. 认领任务，在本机准备独立 worktree。任务使用固定分支，释放后换人认领仍保留已验收子任务成果。
4. 完成修改并运行测试，提交当前设备的交付包。中央 Agent 预审后创建 PR。
5. 维护者验收合并并结算贡献点，或要求修改后重新交付。

发布、认领、提交、释放和审核遇到中断时，可在任务详情恢复相应操作。验收与取消互斥；合并结果尚未确定时不会允许退款取消。

## 架构与升级

```text
Desktop / 本机 Agent ── HTTPS ── API (Railway)
        │                         ├─ GitHub
        └─ 本机仓库和 worktree      ├─ Conexus / 模型服务
                                  └─ Supabase.techunter
```

源码和环境位于本机；共享项目、任务状态和贡献点由中央 API 管理。Supabase service-role key 仅存放在 API。

升级时先停止旧 API 写入（包括登录与 GitHub 授权），按顺序应用 [数据库迁移](infra/supabase/README.md)，包括 `202609120008_release_settlement_recovery.sql`，然后更新 API 和 Desktop。释放任务会关闭并核对交付 PR；已合并的历史交付支持按原作者恢复结算，包括释放、转交及更新提交后的记录。列表按不可变 ID 分页，关联用户与项目也处理数据库返回上限。Desktop 的准备、测试及命令台共用进程清理，Windows 超时或取消会停止整个命令进程树。历史管理员来源及已错误退款记录仍需按迁移文档核对。提交接口必须携带当前工作区 `workspaceId`。

本仓库已移除终端应用与 MCP 服务。当前入口为 Desktop；旧终端安装不再属于受支持的客户端。

完整开发约定见 [CLAUDE.md](CLAUDE.md)，系统说明见 [TECHUNTER.md](TECHUNTER.md)。

## License

[MIT](LICENSE)
