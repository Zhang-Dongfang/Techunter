# Techunter

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-orange)](package.json)
[![AI](https://img.shields.io/badge/AI-GLM--5%20%C2%B7%20zai--org-purple)](https://ppio.com)

> 面向开发团队的 AI 任务分发 CLI。通过对话式终端界面管理 GitHub Issues 任务。

```
   ▗▄▄▄▄▖     Techunter v0.1.0
◆──▐████▌══▶  GLM-5 · zai-org
   ▝▀▀▀▀▘     owner/repo
```

---

## 目录

- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [初始化配置](#初始化配置)
- [使用方法](#使用方法)
- [任务生命周期](#任务生命周期)
- [分支命名规则](#分支命名规则)
- [AI Agent 工具](#ai-agent-工具)
- [开发](#开发)
- [项目架构](#项目架构)
- [许可证](#许可证)

---

## 功能特性

- **对话式 REPL** — 用自然语言描述需求，Agent 自动调用工具完成操作
- **GitHub Issues 集成** — 创建、领取、提交、关闭任务，全程同步 Issue 标签与指派人
- **自动分支管理** — 领取任务时自动创建并推送对应 Git 分支
- **智能任务指南** — 领取任务前 Agent 扫描项目代码，自动生成详细实现指南并评论到 Issue
- **一键交付** — `/submit` 选择任务后 Agent 对比验收标准，确认后提交并推送；`/deliver` 自动创建 PR 并标记为 in-review
- **斜杠命令** — 常用操作无需描述，直接 `/pick`、`/new`、`/submit` 即可
- **持久对话历史** — 同一 REPL 会话内保留完整上下文，Agent 可跨轮次推理

---

## 环境要求

- Node.js ≥ 18
- GitHub 仓库（需有 Issues 功能）
- GitHub Personal Access Token 或通过 OAuth Device Flow 授权
- [ppio.com](https://ppio.com) API Key（使用 GLM-5 模型）

---

## 安装

```bash
git clone <this-repo>
cd techunter
npm install
npm run build
npm link          # 全局安装，注册 tch / techunter 命令
```

---

## 初始化配置

在任意含 GitHub remote 的目录下执行一次性向导：

```bash
tch init
```

配置文件存储于 `~/.config/techunter/`。

---

## 使用方法

```bash
tch
```

启动对话式 REPL，输入自然语言或斜杠命令：

| 命令 | 别名 | 说明 |
|---|---|---|
| `/help` | `/h` | 显示所有命令 |
| `/refresh` | `/r` | 刷新任务列表 |
| `/pick` | `/p` | 交互式浏览并操作任务 |
| `/new` | `/n` | 创建新任务 |
| `/close` | `/d` | 关闭（删除）任务 |
| `/submit` | `/s` | 选择任务后审核变更并提交推送 |
| `/status` | `/me` | 显示分配给自己的任务 |

其他输入均发送给 AI Agent，例如：

```
> 领取任务 #12
> 创建一个给用户列表加分页的任务
> 现在有哪些可用任务？
> 交付当前任务
```

---

## 任务生命周期

每个 GitHub Issue 同一时间只携带一个 `techunter:*` 标签：

```
techunter:available  →  techunter:claimed  →  techunter:in-review
     （绿色）                （黄色）                （蓝色）
```

标签在 `tch init` 和创建任务时自动创建。

---

## 分支命名规则

领取任务时自动创建分支：

```
task-{issue_number}-{标题前5个单词-kebab格式}
```

示例：Issue #7「Add README with project overview」→ `task-7-add-readme-with-project`

---

## AI Agent 工具

Agent 可调用以下工具：

| 工具 | 说明 |
|---|---|
| `list_tasks` | 列出所有开放任务 |
| `get_task` | 获取指定 Issue 的完整详情 |
| `create_task` | 创建新 GitHub Issue |
| `claim_task` | 指派 Issue 并创建本地分支 |
| `deliver_task` | 推送分支、创建 PR、标记 in-review |
| `close_task` | 关闭 GitHub Issue |
| `post_comment` | 在 Issue 上发布 Markdown 评论 |
| `scan_project` | 扫描项目文件树并读取关键文件 |
| `read_file` | 读取指定文件内容 |
| `run_command` | 在项目根目录执行 Shell 命令 |
| `get_diff` | 获取当前 Git diff |
| `stage_and_commit` | 暂存全部变更、提交并推送 |
| `ask_user` | 向用户提问（每个任务最多 3 次） |
| `get_my_status` | 显示当前用户被分配的任务 |

---

## 开发

```bash
npm run dev        # 使用 tsx 直接运行（无需构建）
npm run build      # 编译到 dist/index.js
npm run typecheck  # 仅做类型检查，不输出文件
```

---

## 项目架构

```
tch
  └─ src/index.ts           入口、REPL、斜杠命令
       └─ src/lib/agent.ts   AI 工具调用循环
            ├─ src/lib/github.ts    Octokit — Issue、PR、标签管理
            ├─ src/lib/git.ts       simple-git — 分支、推送、diff
            ├─ src/lib/project.ts   文件树 + 关键文件扫描（上限 80 KB）
            └─ src/lib/config.ts    conf 配置存储（~/.config/techunter/）
```

---

## 许可证

[MIT](LICENSE)
