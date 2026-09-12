# Techunter Desktop

Techunter Desktop 是中央任务市场的本机执行器。项目、任务、认领、审核和贡献点保存在 Supabase 的 `techunter` schema；Railway `techunter-api` 是唯一业务 API。Desktop 不连接 Supabase，也不携带 service-role key。

## 本机职责

- 在本机加载随 Electron 打包的 Techunter UI；
- 为每台设备维护稳定的 `deviceId`；
- 由用户选择本机父目录后同步项目：不存在时从 GitHub clone，存在时验证 remote 并 fetch；
- 按任务冻结的 `baseSha` 创建独立 git worktree；
- 执行 Task Agent 生成的原生宿主机 `setupCommands`，没有命令时根据锁文件自动探测；
- 收集并校验 `editablePaths` 内的本地改动；
- 通过窄 Electron IPC 提供工作区终端。
- 在系统浏览器完成 Conexus 和 GitHub 授权，并通过随机本机回调安全返回 Desktop。

不会使用预制项目镜像。涉及系统管理员权限、缺少运行时或凭据时，环境会进入 `failed` 并把错误回报中央 API，可在修复本机条件后重试。

## 开发

`apps/desktop/.env` 只需要配置中央 API 地址，参见同目录 `.env.example`：

```powershell
npm install
npm run dev
```

开发入口：

- Web：<http://127.0.0.1:5173>
- API：读取 `TECHUNTER_API_URL`，默认使用已部署的 Railway 服务
- Electron 自动等待本地 Vite UI 就绪后打开；中央 API 暂时不可用不会阻止客户端启动。

只有调试中央控制面时才需要另行准备根目录 `.env` 并运行 `npm run dev:api`。

生产 Desktop 在本机 `127.0.0.1:4311` 提供打包后的 UI，只需要配置中央 API 地址：

```dotenv
TECHUNTER_API_URL=https://techunter-api.example.com
TECHUNTER_UI_PORT=4311
```

在 Windows 上打包 x64 安装程序：

```powershell
npm run package:win --workspace @techunter/desktop
```

打包时 `apps/desktop/.env` 会作为资源随安装程序分发，并在安装后的应用启动时读取。这里只能放客户端可公开的配置，禁止放 API 密钥、令牌或其他秘密。安装程序输出到根目录的 `dist/windows`。

## 自动更新与发布

安装版 Desktop 启动 10 秒后会检查 GitHub Releases，之后每 4 小时复查一次。发现新版本后会后台下载；下载完成时可从左下角立即重启安装，也会在正常退出应用后自动安装。开发模式不会访问更新源。

发布前先在 GitHub 仓库的 Actions variables 中配置公开的 `TECHUNTER_API_URL`，然后从干净工作区执行：

```powershell
.\release-desktop.ps1 0.1.1
```

脚本会更新 Desktop 版本、验证构建并推送 `desktop-v0.1.1` tag。`Release Desktop` workflow 会生成 NSIS 安装程序、blockmap 和 `latest.yml`，并发布到 GitHub Release。不要手工上传缺少 `latest.yml` 的安装包，否则客户端无法发现更新。

生产发布建议再配置 `WIN_CSC_LINK` 与 `WIN_CSC_KEY_PASSWORD` Actions secrets 为安装器签名；未配置时更新链路仍可工作，但 Windows 会把安装器显示为未签名应用。

Railway API 的 `TECHUNTER_WEB_ORIGINS` 必须包含 `http://127.0.0.1:4311`。`TECHUNTER_RENDERER_URL` 只供开发时指向 Vite，生产环境不要设置。

GitHub clone 优先使用中央 API 签发的短期 GitHub App installation token；未安装 App 的仓库使用当前用户已连接的 GitHub OAuth 授权，`tch init` 本机 token 仅作本机后备。凭据通过单次 Git 进程环境传入，不写入 remote。私有仓库会先确认当前 GitHub 用户已有访问权；没有访问权时必须先完成合作者申请并接受 GitHub 邀请。

Conexus 与 GitHub 登录都在系统默认浏览器完成。GitHub 会直接复用浏览器中的 github.com 会话；GitHub 连接按用户保存，不随单次 Techunter 登录结束。Techunter 登录会话最长 30 天、连续 7 天未使用会失效；短期 Conexus Run Ticket 到期只暂停模型功能，可复用官方 API 域保存的 HttpOnly 浏览器会话快速续期。

## 安全边界

渲染页保持 `contextIsolation`、禁用 Node integration 并启用 sandbox。只有本机 Desktop UI origin 能调用 preload。源码、依赖缓存、构建产物和本机绝对路径不进入 Supabase。

## 验证

当前版本提交时会校验本机已合入的远程任务版本。子任务成果合并后，点击「同步并检查环境」会将它们合入父任务工作区；本机冲突需要先处理，Agent 不会重置或覆盖未提交改动。交付面板可以运行任务的 `testCommands` 并收集输出；测试后代码变化会要求重跑。测试仍在执行者本机运行，中央预审会明确注明这一证据来源。

发布或提交遇到断线时，重新打开任务可选择「恢复发布」或「恢复提交」。如果原 API 进程刚刚退出，最多等待 90 秒后再重试。待发布的赏金会保留；「撤回发布」会关闭已创建的 Issue 并释放预算占用。升级前请先应用 [持久化操作迁移](../../infra/supabase/migrations/202609120002_durable_task_operations.sql)，再更新 API 和 Desktop。

```powershell
npm run typecheck --workspace @techunter/desktop
npm run test --workspace @techunter/desktop
npm run build --workspace @techunter/desktop
```
