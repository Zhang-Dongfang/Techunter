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

## 修改范围复议升级

部署带有复议接口的 API 前，先应用 `infra/supabase/migrations/202609080001_scope_requests.sql`。接取者在 Desktop 任务详情提交逐文件申请，发布者或管理员在审核中心审批；批准后更新范围版本并尝试同步 GitHub Issue。同步失败可以单独重试，不会撤销授权。完整边界、流程与接口见 [复议机制设计](../../docs/scope-reconsideration.md)。

## 本地 SQLite 一次性迁移

正式切换前可以运行：

```powershell
$env:GITHUB_MIGRATION_TOKEN='...'
npm run migrate:sqlite --workspace @techunter/api -- apps/desktop/.data/techunter.sqlite
```

脚本迁移共享业务数据，但不会迁移会话和机器本地工作区路径。迁移完成后不存在 SQLite 双写或运行时回退。
