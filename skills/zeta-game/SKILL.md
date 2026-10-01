---
name: zeta-game
description: Create and improve games on Zeta Studio through its MCP connection, using local source editing or the platform Lite, Pro and Plan workflows, then verify and save a playable version.
---

# Zeta Studio 游戏创作

帮助用户从想法到可试玩、可继续编辑的游戏。先读取本 Skill 同目录的 `connection.json`（只有服务器地址和连接名称），发现当前 `zeta` MCP 工具及输入 schema，不读取凭证库或个人配置。必要时执行固定公开版本 CLI：

`npx --yes --package=https://github.com/kinglegendzzh/zeta-local-development/releases/download/v0.2.0/zeta-studio-local-development-0.2.0.tgz zeta-dev <命令>`

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
