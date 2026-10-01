# Zeta Studio 本地游戏创作

把接入提示词发给你使用的 AI 工具，AI 安装 MCP 与游戏 Skill，你在网页确认项目权限，再继续聊天创作。工程和 AI 工具在电脑上，平台授权、验证和保存使用线上服务，无需启动本地 Zeta 前后端。保存后返回平台试玩和提交发布。

## 一次接入

需要 Node.js 20.19+，在选定项目目录执行（工具公开发行于 GitHub；未发布至 npm 注册表）：

```sh
npx --yes --package=https://github.com/ZetaZeroHub/zeta-local-development/releases/download/v0.2.2/zeta-studio-local-development-0.2.2.tgz zeta-dev install --ide codex --server https://api.zzh.app --web-origin https://studio.zzh.app --profile zeta-online --directory .
```

`--web-origin` 使用当前平台域名，例如 `https://game.zzh.app`；服务端只接受明确开放的站点，不根据 Host 猜域名。不传该参数的旧客户端仍使用服务端默认站点。HTTPS 用于线上；HTTP 仅允许 loopback 联调，换环境用不同 profile。

`--ide` 支持 `codex`、`claude`、`cursor`、`traecode`、`traework`、`workbuddy`、`antigravity`、`pi`、`openclaw`、`hermes` 或逗号组合。命令自动打开网页授权，并等待确认。配置仅写选定项目目录，凭证仅保存在系统凭证库；保留其他服务、配置和 Skill 本地修改，更新前备份，冲突则停止。

| 工具 | 项目配置与下一步 |
|---|---|
| Codex / Claude Code / Cursor | `.codex/config.toml` / `.mcp.json` / `.cursor/mcp.json`；信任项目并刷新 MCP |
| TraeCode | `.trae/mcp.json`；在 MCP 设置中启用可信项目配置 |
| WorkBuddy | `.workbuddy/mcp.json`；刷新并检查服务器连接 |
| 新版 Pi | `.pi/mcp.json`；项目信任，使用内置 MCP，执行 `/reload` |
| TraeWork / Antigravity / Hermes | 生成 `zeta-mcp.json`，按 integration.docs 官方说明导入；不自动修改全局设置 |
| OpenClaw / 无原生 MCP 的工具 | 读取 `.agents/skills/zeta-game/SKILL.md`，用 `tools` 读取 schema，`call --tool NAME --arguments JSON` 调用同一 MCP；需要本机命令执行与凭证库访问 |

非 Claude 的 Skill 位于 `.agents/skills/zeta-game`，Claude 位于 `.claude/skills/zeta-game`。不同客户端版本的自动发现规则有差异，提示词会要求 AI 直接读取该文件。

安装后刷新 MCP 或重新打开工具。Codex 需要信任项目目录，才会读取项目级配置。网页授权、doctor 检查和 Agent 实际工具调用是不同验证步骤。重跑相同安装命令可以安全恢复；换账号/服务用新的 `--profile NAME`。

## 三种模式和源码编辑

安装的 `zeta-game` Skill 根据用户任务选择流程：

| 流程 | 实际能力 | 授权与费用 |
|---|---|---|
| 源码直接编辑 | 本地修改、同步、异步验证、保存新版本 | 独立于三模式；不调用平台模型，外部 AI 供应商收费，验证托管受平台配额 |
| Lite | 简单快速平台修改 | 网页单独允许平台 AI，按实际用量与账号额度处理 |
| Pro | 平台观察、修改、检验与交付 | 同上，共用既有预算；有局限结果须明确说明 |
| Plan | 平台 research/brainstorm/mvp_build/polish/finish | 环境与凭证都明确允许才可使用；不自动降级，不开放 delegation |

先通过模板初始化创建一个获授权项目，再使用平台编辑。此个人连接不开放无限 game:create。旧连接不会自动扩大权限，需要重新网页授权。Skill 的具体参数与恢复路径见 `skills/zeta-game/references/modes.md`，实际工具 schema 与服务端终态为准。

## CLI 续接

所有命令可带 `--profile NAME`。已有项目用 `init 空目录 --game GAME_HANDLE --revision N`；新项目用 `init 空目录 --starter pixi-orbit-v1 --name 游戏名`（3D 用 three-orbit-v1）。

源码主链：`status → push → validate → preview → save-version`。首次保存返回计划；确认后用返回摘要 `save-version --confirm-source sha256:...`。保存不自动社区发布。用 `resume` 查询原操作，凭证变化用 `reconnect --profile NEW_PROFILE`，保留本地改动。`create-script` / `delete-script` 管理脚本，`doctor` 检查 MCP，`forget` 只删除本机凭证，远端请在网页撤销。

## 凭证与系统依赖

令牌仅保存系统凭证库，不进入配置、命令参数、Skill 或项目文件。macOS 使用 Keychain，首次编译辅助程序需要 Xcode Command Line Tools；Windows 使用 Credential Manager；Linux 使用 secret-tool 和已解锁用户密钥环。本次实际验收环境为 macOS/Codex，其他客户端配置有静态与隔离验证，未宣称其他系统实机通过。

## 备用源码包 / 开发

下载 ZIP 只作为备用。解压后 `npm ci --ignore-scripts`，用 `node src/cli.mjs install ...`；或单独 `connect/config/doctor`。本仓库 Apache-2.0 许可，不包含平台服务配置和用户凭证。
