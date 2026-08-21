# Techunter Desktop

Techunter Desktop 是中央任务市场的本机执行器。项目、任务、认领、审核和贡献点保存在 Supabase 的 `techunter` schema；Railway `techunter-api` 是唯一业务 API。Desktop 不连接 Supabase，也不携带 service-role key。

## 本机职责

- 在本机加载随 Electron 打包的 Techunter UI；
- 为每台设备维护稳定的 `deviceId`；
- 项目不存在时自动从 GitHub clone，存在时验证 remote 并 fetch；
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

Railway API 的 `TECHUNTER_WEB_ORIGINS` 必须包含 `http://127.0.0.1:4311`。`TECHUNTER_RENDERER_URL` 只供开发时指向 Vite，生产环境不要设置。

GitHub clone 优先使用中央 API 签发的短期 GitHub App installation token；未安装 App 的仓库使用当前用户已连接的 GitHub OAuth 授权，`tch init` 本机 token 仅作本机后备。凭据只用于 git 传输，remote 在 clone/fetch 后恢复为无凭据 URL。

Conexus 与 GitHub 登录都在系统默认浏览器完成。GitHub 会直接复用浏览器中的 github.com 会话；Conexus 第一次成功登录后在官方 API 域保存 HttpOnly 浏览器会话，之后只需确认继续使用该账号。

## 安全边界

渲染页保持 `contextIsolation`、禁用 Node integration 并启用 sandbox。只有本机 Desktop UI origin 能调用 preload。源码、依赖缓存、构建产物和本机绝对路径不进入 Supabase。

## 验证

```powershell
npm run typecheck --workspace @techunter/desktop
npm run test --workspace @techunter/desktop
npm run build --workspace @techunter/desktop
```
