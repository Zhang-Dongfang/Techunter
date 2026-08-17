# Techunter Platform v0.1

Techunter（科技猎人）的企业内部试点版：Web 任务市场 + Electron 桌面端 + GitHub 协作 + Agent 任务分析/交付预审。

## 已实现的闭环

1. 发布者创建草稿，Agent 根据仓库文件树生成摘要、验收标准、文件范围和建议贡献点。
2. 发布任务时从项目预算冻结贡献点，并同步为 GitHub Issue（配置 GitHub App 后）。
3. 成员原子认领任务；并发抢单只会成功一个。
4. 平台创建最小工作包：只复制 `editablePaths` 和 `readonlyPaths`，始终排除 `.git`、`.env`、密钥等路径。
5. 执行者可以从进行中的任务继续拆分子任务；子任务只能看到父任务已经公开的文件。
6. 提交时只收集授权范围内的变更，Agent 生成评分、验收项证据和 Markdown 交付文档。
7. 维护者验收后合并 GitHub PR、结算贡献点；子任务成果同时写入父任务工作包。
8. Electron 桌面端提供本机命令台，可以在工作包目录运行任意 shell 命令。

贡献点在 v0.1 是企业内部记账单位。数据库已经使用账户与不可重复转账流水建模，但真实充值、提现、支付渠道和税务/KYC 不在本版范围内。

## 本地启动

要求 Node.js 24+。

```powershell
cd platform
Copy-Item .env.example .env
npm install
npm run dev
```

- Web UI：<http://127.0.0.1:5173>
- API：<http://127.0.0.1:4310>
- Electron 会在两者就绪后自动打开。
- 演示模式内置管理员、开发者、维护者三个账号，可以在右上角切换。

生产构建和本机桌面运行：

```powershell
npm run build
npm run desktop
```

Electron 生产模式会在本机启动 `127.0.0.1:4310` 服务并加载构建后的 Web UI。桌面命令台以当前操作系统账号运行，不对命令做白名单限制；它只通过窄 IPC 暴露给 Techunter 自身页面，网页仍保持 `contextIsolation`、禁用 Node 集成并启用 sandbox。

桌面端默认使用 115% 缩放。可用 `Ctrl +`、`Ctrl -` 调整，`Ctrl 0` 恢复默认；也可以通过 `TECHUNTER_DESKTOP_ZOOM=1.25` 修改启动默认值。

## 企业内网部署

第一阶段建议继续以 GitHub 为代码与审查事实源：Techunter 管任务状态、文件范围、工作包、Agent 结果和贡献点；GitHub 管仓库、Issue、分支、PR 和最终合并。这样无需在第一版重造代码托管、权限和审计系统。

浏览器版可用 Docker 部署：

```bash
docker compose up --build -d
```

默认把上级 Techunter 仓库只读挂载到 `/repository`，持久数据写入 `techunter-data` volume。上线前请至少修改：

- `TECHUNTER_PUBLIC_URL`：内网可访问的 HTTPS 地址；
- `TECHUNTER_WEB_URL`：同一个生产地址；
- `TECHUNTER_DEMO_MODE=false`：关闭演示免登录；
- GitHub OAuth 与 GitHub App 配置；
- AI 模型配置（不配置时使用确定性本地规则）。

## GitHub 配置

登录使用 GitHub OAuth App，回调地址是：

```text
https://你的域名/api/auth/github/callback
```

设置 `GITHUB_ALLOWED_ORG` 后，仅该 GitHub Organization 的成员可以登录。仓库操作优先使用 GitHub App，建议只安装到试点仓库并授予：

- Metadata：Read-only
- Contents：Read and write
- Issues：Read and write
- Pull requests：Read and write

然后填写 `GITHUB_APP_ID`、`GITHUB_INSTALLATION_ID`、`GITHUB_PRIVATE_KEY` 和 `GITHUB_WEBHOOK_SECRET`。`GITHUB_TOKEN` 只作为本地开发后备，不建议用于企业部署。

## Agent 配置

支持任意 OpenAI-compatible Chat Completions 服务：

```dotenv
AI_API_KEY=...
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=z-ai/glm-5
```

不配置密钥也能完整演示：系统会根据文件树和任务关键词确定文件范围/贡献点，并用变更与测试输出进行确定性预审。

## 关键目录

```text
src/shared/       Web、服务端和 Electron 共用契约
src/server/       API、SQLite、账本、Agent、GitHub、工作包
src/web/          React UI
src/desktop/      Electron 主进程与安全 preload
.data/            SQLite 与任务工作包（不会提交 Git）
```

## 验证

```bash
npm run typecheck
npm test
npm run build
```

集成测试覆盖完整任务结算流程、敏感文件不出工作包和并发认领冲突。
