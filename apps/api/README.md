# Techunter API

`@techunter/api` 是部署到 Railway 的独立中央控制面。它连接 Supabase 的 `techunter` schema，管理共享项目、任务、原子认领、审核和贡献点；还负责 Conexus 登录、GitHub OAuth/App、Webhook 和模型调用。

它不 clone 长期仓库、不保存本机路径，也不执行用户项目环境命令。任务分析需要代码证据时，会从 GitHub 下载短期 archive 到临时目录并在调用结束后删除。

## 部署顺序

1. 按 `infra/supabase/README.md` 应用迁移，并把 `techunter` 加入 Supabase Data API Exposed schemas。
2. 在 Railway 新建独立 `techunter-api` Service，配置 `infra/railway/api.json`。
3. 从 `.env.example` 配置 Supabase、Conexus、GitHub 和凭据加密密钥。
4. 把 `TECHUNTER_PUBLIC_URL` 设置为 API 的最终 HTTPS 地址；生产 Desktop 默认把 `TECHUNTER_WEB_ORIGINS` 设置为 `http://127.0.0.1:4311`。
5. 把 GitHub OAuth callback 配置为 `https://<techunter-api>/api/auth/github/callback`，Webhook 配置为 `https://<techunter-api>/api/github/webhook`。

API Docker 镜像只构建中央 API 和它依赖的 `@techunter/core`，不包含或托管 Web UI。Electron 在本机提供打包后的 UI，并通过 HTTPS 调用这里的 API。

## 本地 SQLite 一次性迁移

正式切换前可以运行：

```powershell
$env:GITHUB_MIGRATION_TOKEN='...'
npm run migrate:sqlite --workspace @techunter/api -- apps/desktop/.data/techunter.sqlite
```

脚本迁移共享业务数据，但不会迁移会话和机器本地工作区路径。迁移完成后不存在 SQLite 双写或运行时回退。
