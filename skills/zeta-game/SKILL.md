---
name: zeta-game
description: Create and improve games on Zeta Studio through its MCP connection, using local source editing or the platform Lite, Pro and Plan workflows, then verify and save a playable version.
---

# Zeta Studio 游戏创作

帮助用户从想法到可试玩、可继续编辑的游戏。先读取本 Skill 同目录的 `connection.json`（只有服务器地址和连接名称），发现当前 `zeta` MCP 工具及输入 schema，不读取凭证库或个人配置。必要时执行固定公开版本 CLI：

`npx --yes --package=https://github.com/ZetaZeroHub/zeta-local-development/releases/download/v0.2.2/zeta-studio-local-development-0.2.2.tgz zeta-dev <命令>`

所有 CLI 命令带 `--profile` 的实际连接名。工具未连通时运行 `doctor` 并按结果恢复；如果项目配置刚安装，提示刷新 MCP / 重启工具和信任项目，不假称已能调用。

## 选择流程

- 用户要求自己工具中的 AI 改代码，或不使用平台模型：**源码编辑**。这是独立路径，不是 Lite/Pro/Plan 的第四种执行模式；默认选它，不暗中调用平台 AI。
- 用户明确使用平台 AI：**Lite** 用于简单快速修改，**Pro** 用于完成与检验明确需求，**Plan** 用于需要调研、规划、构建、打磨的复杂目标。尊重用户指定模式；平台 AI 需要网页单独授权，按实际用量与账号额度处理。
- 读取 [references/modes.md](references/modes.md) 中所选流程；每次平台编辑都显式传入 `mode`，尤其 Plan 基线。不得因拒绝/费用不足换成更高模式，不开启 delegation。

## 开始与交付

1. 先列出用户已授权项目或读取已有工程状态。没有项目时用 `init 新空目录 --starter pixi-orbit-v1 --name 游戏名`（3D 使用 three-orbit-v1），消耗网页允许的一次模板创建；不使用无限游戏生成绕过项目授权。不覆盖非空目录。
2. 开发中保留本地修改和请求句柄。遇到结果不明、断线、限流先查询原请求，遵守服务返回的轮询间隔；不创建新的任务来“重试”。有版本冲突先列出差异，不能强推覆盖。
3. 检查服务端终态、交付局限、版本号、源码与产物摘要；实际试玩交互。保存不等于发布。给用户站内项目 URL 和具体剩余问题；社区发布由用户在网页确认封面、许可和审核提交。

面向用户只说当前动作和下一步，不倾倒 MCP/句柄/摘要教程。工具失败或只读查询不算开发完成。

## 线上平台与工具适配

平台授权、验证和保存均访问 connection.json 中的线上 server。工程和 AI 工具在用户电脑上；不要替用户启动 Zeta 前端/后端。安装命令携带 --web-origin 当前平台，授权和试玩留在同一站点；浏览器两个域名可以共用 API，CLI 的 profile 按 API 环境隔离。localhost 仅用于开发者联调或下载产物的本地预览，不能把它当线上平台地址。

Codex、Claude Code、Cursor、TraeCode、WorkBuddy、Pi 的项目配置由安装器写入。TraeCode 需要在设置中启用可信项目的 MCP；Pi 需要项目信任和新版内置 MCP。TraeWork、Antigravity、Hermes 用安装结果 integration.docs 和 zeta-mcp.json 引导添加服务器，不猜全局配置路径，不擅自改全局设置。不要把安装文件/doctor 当成 AI 工具内实际接入成功。

OpenClaw 或暂时不能原生接 MCP 的工具，可以直接读取本 Skill，通过 CLI 完成相同授权链：
- 先运行 tools --profile NAME，读取服务实际返回的工具名和 inputSchema。
- 调用 call --tool game_TOOL --arguments 'JSON对象' --profile NAME；参数严格遵守返回的 schema。它使用同一系统凭证库、同一 MCP 和服务端权限，无需导出 token。
- 源码流程仍用 init/status/push/validate/save-version。Lite/Pro/Plan 使用上述 call 调 game_edit_* 和 game_revision_*；失败、预算不足、原任务未确认时遵守 references/modes.md，不重复创建任务或扩大权限。
- 工具必须能在同一用户电脑上读写工程、执行命令并访问该用户的凭证库。云端沙箱与本机凭证隔离时停止并提示使用桌面/本机执行环境，不复制凭证到云端。
