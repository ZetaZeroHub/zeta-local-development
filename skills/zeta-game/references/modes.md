# 模式与恢复

工具参数以已连接 MCP 的 schema 为准。源工作区和平台任务使用不同的句柄，不能互换。

## 源码直接编辑

已有本地工程先 `status`，已有云端项目可 `init 空目录 --game GAME_HANDLE --revision N`。浏览器已有草稿先按网页“接入已有草稿”转成授权项目。仅在本地编辑已下载脚本；新增删除用 `create-script` / `delete-script`。

依次 `push → validate → preview → save-version`。首次 `save-version` 只读取保存计划；向用户说明将保存一个新版本，在其开发指令已授权保存时按返回的源码摘要执行 `save-version --confirm-source sha256:...`。有新的本地修改时重新 push/validate，旧验证不能用于新源码。返回站内试玩保存产物。

也可直接调用 `game_source_workspace_open/file_list/file_read/file_update/file_create/file_delete/validation_start/validation_status/publish`；使用返回的 CAS 与源码摘要，验证成功后才能发布新版本。关闭工作区后需要重开，不复用旧 handle。源码编辑 Plan 版本仍是 source_agent_edit，不能伪称完成了一次 Plan 模型执行。

外部 AI 的费用由其供应商收取；平台源码同步、验证和保存不调用平台模型，验证/托管仍受配额。没有源码权限时请用户重新网页授权，不改本机/服务端凭证。

## Lite / Pro / Plan 平台 AI

先 `game_revision_list/get` 获取获授权项目的当前版本。用 `game_edit_start` 传 `gameHandle`、`baseRevision`、全新一次性的 `editRequestId`、用户原始 `instruction`、明确 `mode: lite|pro|plan`，`allowDelegation:false`。

- Lite：快速生成/有限修复；不宣称经历完整打磨。
- Pro：在现有预算内观察、修改、验证和交付；可能返回 delivered_with_limitations，必须指出未达成部分。
- Plan：显式阶段执行（research/brainstorm/mvp_build/polish/finish），共用冻结预算和截止时间。没有 Plan 权限或环境关闭则停止并说明；不自动降级为 Pro，不把本地 AI 规划冒充平台 Plan。

保存 `editHandle`，按 `pollAfterMs` 调 `game_edit_status`，终态后调 `game_edit_result`。中断后查询相同 handle；用户取消使用 `game_edit_cancel` 并回读状态。成功后用 `game_revision_get` 核对新版本与产物，返回站内试玩。平台编辑任务已经保存版本，不再用源码 publish 重复保存。

编辑 Plan 基线必须显式 mode；继续 Plan 就传 plan，明确切换才传 lite/pro。预算、账号额度不足、权限撤销或版本冲突不自动加预算/新建任务。已在运行的任务按服务端既有控制语义查询，不能伪称取消成功。

平台生成 `game_generation_*` 仅在实际获得 game:create 且有完整项目归属时使用；本 C 端连接使用模板初始化后编辑，未开放无限 create。版本恢复使用 `game_revision_restore`（先确认旧版本及当前基线），恢复产生新版本，旧版本保留。
