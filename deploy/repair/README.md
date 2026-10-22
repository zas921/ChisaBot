# 云端修复、本地验收

此功能复用 ChisaBot 自带的云端 Claude Code 节点，不需要另装 CloudCLI。
服务器和 PC 节点必须一起升级到包含本功能的版本。先部署服务、配置 GitHub 和验收适配器；Claude 订阅登录可以最后完成。

## 数据与权限边界

1. 用户向 ChisaBot 提交问题，`repair_start` 在已绑定的 GitHub 工作区创建独立 Claude 会话。
2. Claude 只接触云端仓库，最终答复包含原因、改动、验证与遗留问题。修复文档保留在云端会话。
3. 用户预先勾选项目的推送授权后，编排器在会话正常完成时推送 `cc/*` 分支并创建草稿 PR。还须拥有 GitHub 仓库的云端读写授权及相应令牌权限。不自动合并 GitHub PR。
4. 本地节点按配置的 GitHub 仓库抓取完整提交 SHA。默认在新建副本中验收；项目开启“直接更新原工程”后，先将该提交快进到原工程当前分支，再在原工程验收。不自动 reset、clean、stash 或解决冲突。
5. 本地返回检查状态、退出码、测试计数；完整日志与报告保留在本机。结果写入云端会话系统消息，可让机器人用 `repair_status` 查询。不会自动把本地日志反馈给 Claude，也不会自动循环修改。

VPS 不挂载本机目录，不启用电脑文件夹同步，不使用本机 Claude 登录态、SSH 密钥或 Git 配置。仓库内已提交的文件以及用户主动发送的内容仍会到达云端。GitHub 令牌作为受信任节点 Git 子进程的临时凭据使用，不写入聊天；节点与 Claude 共用容器不是凭据的独立安全沙箱，应使用只覆盖所需仓库的令牌。

**本地验收会执行生成的工程代码**，Unity 导入也可能执行编辑器脚本。这不是虚拟机隔离；需要更严格边界时，把验收节点放在独立系统账号或虚拟机中。不要让本地验收配置位于模型可修改的工程内。

## 部署

- VPS：按 [云端节点部署说明](../cloud-node/README.md) 配对节点。无需开启入站 PC 端口，不开启目录同步。预留云端仓库空间；Unity 资源很多时要考虑 Git LFS、磁盘容量和克隆时间。
- 构建并部署新版 server/app（仓库原有 `bun run build` / Docker 流程）。新增表在启动时自动创建，不需要单独迁移命令。
- 构建新版 PC 客户端或运行 `node pc/src/cli.js run --server <服务器> --token-file <本地设备令牌文件> --approve web`。设备必须上报 `repair_validate`、`repair_status`、`repair_cancel` 能力。旧客户端不会收到不支持的验收任务。
- 设置 → 账号连接 → GitHub：连接独立的 fine-grained 令牌，再设置“云端 Git 授权”的仓库列表和只读/读写权限。默认关闭；已有用户升级后也必须显式开启。令牌建议 Contents 读写、Pull requests 读写，仅选需要的仓库。关闭阻止后续 Git 操作；已发出的操作和已克隆代码不会自动撤回。
- 在云端代码页面添加 GitHub 工作区，等待克隆完成，保持“仅云端”。最后在设置 → 云端工作区完成 Claude 登录。

推送时使用独立临时裸仓库与服务端指定的 URL，不使用模型可修改的 pushurl、URL 重写或 Git hooks。不要配置不可信的 GitHub API/Git 基址。不同版本的服务器和节点混用时，应先更新服务端再更新节点。

## 本地验收配置

复制相邻的 `unity-profile.example.json` 或 `commands-profile.example.json` 到工程以外，填写自己的仓库与绝对路径，然后运行：

```powershell
node pc/scripts/configure-repair.cjs --id my-project --profile D:/LocalConfig/my-project.json
```

默认写到用户目录 `.chisabot-node/repair-profiles.json`。使用 `--config FILE` 指定其他文件时，节点启动环境中的 `CHISABOT_REPAIR_PROFILES_FILE` 必须指向该文件。修改已有配置需显式 `--replace`。配置不包含 GitHub 令牌；本地 Git 默认使用系统凭据管理器（`gitAuth: "system"`），也可以配置 `gitAuth: "github-cli"` 使用已在本机登录的 `gh`。两种方式均不使用服务器令牌，不把本机凭据复制到云端。

在设备设置中把 `workspaceRoot` 加入允许的文件夹，开启命令行能力（询问或允许）。每台设备同一时间只运行一个验收。紧急停止会终止后台验收及其子进程。配置里的可执行文件必须为绝对路径，使用参数数组，禁止由远端任务指定 shell 命令。

本地配置可选 `environment` 字符串映射，为 Git 和验收子进程指定代理、PATH 或独立包缓存。例如 Unity 可设置 `UPM_CACHE_ROOT` 为工程外的验收缓存目录，避免继承不可访问的全局缓存。变量仅从本机配置读取，远端请求不能覆盖，不随验收结果上传；不要在此保存账号令牌，继续使用本地凭据管理器。配置只影响验收子进程，不修改系统环境。

- `unity`：通过 Unity CLI 执行批处理编译，再运行 EditMode 测试。不运行打包、设备测试或 GUI 操作。必须安装适配工程的 Unity 编辑器和可用许可证。默认需要有效 NUnit 报告，零测试、跳过测试或缺失报告均不能通过。
- `commands`：按顺序执行 `checks`。支持参数里的 `{project}` 和 `{reports}` 占位符。示例 `node --test` 仅适用于实际有测试的 Node 项目；项目维护者应配置能正确判定成败的命令。安装依赖、LFS/子模块初始化等也必须由维护者明确配置，当前不自动安装或递归拉取。

每次验收目录为 `<workspaceRoot>/<任务UUID>/project`，同级 `reports/` 保存日志，`result.json` 保存结果。不会自动删除这些目录，维护者需定期清理已结束的任务以控制磁盘占用。节点重启后不自动重跑，查询旧任务返回未知；服务器重启将进行中的任务标为 interrupted，需检查远端会话、GitHub 分支和本地报告后再发起新任务。

### 直接更新原工程（按项目选择，默认关闭）

在工程外的本地验收配置中增加以下字段，使用 `configure-repair.cjs --replace` 安装，并将 `originalProjectRoot` 加入设备允许的文件夹：

```json
{
  "originalProjectRoot": "D:/Projects/MyProject",
  "originalRemote": "origin"
}
```

这里展示的是追加字段，仍需保留仓库、验收适配器等完整配置。`originalRemote` 默认为 `origin`，用于核对原工程确实绑定了同一个 GitHub 仓库；支持标准 HTTPS/SSH GitHub 地址。路径只保存在本机，云端项目设置只保存 `updateOriginal` 布尔开关。服务器、PC 节点一起升级；旧节点会拒绝此新参数，不会静默改用副本。

设置 → 云端工作区 → 项目修复与本地验收 → 编辑项目 → 开启“直接更新原工程”并保存。关闭后恢复副本模式，不自动撤销此前应用的修复。

- 开启后复用原工程及其缓存，不创建另一份工程。任务目录仅保存报告和结果；验收命令的 `{project}` 指向原工程。
- 原工程必须是完整 Git 工作树根目录、处于本地分支，且无未提交/未跟踪改动、进行中的 Git 操作或隐藏索引标记。分支分叉时停止，不创建自动合并提交；忽略文件也不会被强行覆盖。运行期间请勿同时编辑、切分支或执行 Git 操作。
- Unity 适配器仍使用 Unity CLI 批处理编译与 EditMode 测试，复用原工程 `Library`。请先正常关闭该工程的编辑器；发现 `Temp/UnityLockfile` 时会停止，不强制关闭、不自动删除锁、不并行启动另一实例。此模式尚不支持在已打开的编辑器内执行测试。
- 更新前建立本地 `refs/chisabot/repair/<任务UUID>` 备份引用，并先落盘 `result.json`。结果中的 `beforeCommit`、`targetCommit`、`afterCommit` 和更新状态可用于核对。原工程路径、分支名、Git 配置和日志不会回传；云端只收到提交 SHA、备份引用、固定错误代码与验收汇总。
- 验收失败、取消或重启不会自动回退已应用的更新。`prepared` 表示已建立回退参考但更新结果未确认，必须检查实际 HEAD 和工作区；`applied` 表示已更新，`unchanged` 表示原工程已经在目标提交。客户端异常退出可能留下 `.git/chisabot-repair.lock`，确认无任务运行并核对结果后由维护者清理。

手动恢复时先保存后续编辑，再用 `git show <备份引用>`、`git diff <备份引用> HEAD` 核对范围。可用 `git switch -c recovery/<新名称> <备份引用>` 在新本地分支上恢复到更新前版本；Git 会阻止覆盖冲突改动。不要直接对含未提交工作的原工程执行强制重置。

## 绑定与使用

设置 → 云端工作区 → 项目修复与本地验收：填写项目编号/名称，选择 GitHub 工作区、本地设备和本地配置编号，勾选推送修复分支及请求验收授权后保存。可编辑或移除绑定；移除绑定会在下次检查时停止进行中的任务，已经推送的提交和 PR 保留。

向机器人发送“修复项目 my-project 的某个问题，完成后验收”。工具返回任务编号。可随时问“查询修复任务 …”或“取消修复任务 …”。Claude 的工具审批仍显示在云端会话中，本地设备审批仍按设备策略执行。任务两小时仍未结束会请求取消。没有登录 Claude、GitHub 权限不足、设备离线或验收配置不匹配时不会宣称成功。

管理 API 均要求当前用户登录：`GET/PUT /api/repairs/projects`、`DELETE /api/repairs/projects/:id`、`GET /api/repairs/jobs/:id`、`POST /api/repairs/jobs/:id/cancel`。配置归当前账号所有，模型工具不能创建授权或写本地配置。

## 验证

```text
node --test pc/test/repair-validation.check.js pc/test/cloud-cc-git.check.js
bun test server/tests/git-authorization.test.ts server/tests/git-authorization-service.test.ts server/tests/repair-workflow.test.ts
```

测试覆盖仓库授权、拒绝命令/路径注入、提交绑定、临时副本、Git 配置重定向、取消、编译失败、缺失测试报告和结果脱敏，以及真实 Git 快进、原工程改动/分叉/忽略文件保护、备份引用和失败保留。真实 Claude 登录、VPS 联网及实际项目验收须在部署后另行检查。
