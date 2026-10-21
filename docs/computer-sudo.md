# 机器人电脑的完整 sudo（默认关闭）

机器人的「电脑」是 ChisaBot 容器里的普通用户 `pwuser`：shell 和浏览器都以它运行，默认只能免密 `sudo` 包管理器（`apt-get` / `apt` / `dpkg` / `apt-key` / `apt-cache`）。原因见根目录 `Dockerfile` 里「A Bot can install what a task needs」一节。

单用户的个人部署可以自己决定放开：

```sh
# deploy/.env
CHISABOT_COMPUTER_SUDO=full
```

然后重建容器（`sh deploy/start.sh`，或 `docker compose -f deploy/compose.yaml up -d`）。改回 `off`（或删掉这一行）再重建，即恢复受限状态。

## 打开后会怎样

- 容器启动时 `/etc/cont-init.d/50-computer-sudo`（源文件 `agent-computer/src/computer-sudo.sh`）以 root 写入 `/etc/sudoers.d/zz-chisabot-computer-full`：`pwuser ALL=(ALL) NOPASSWD: ALL`，并用 `visudo` 校验；值不是 `full` 时删掉这个文件。
- `computer_run_command` 的工具说明会告诉模型：它有完整的免密 sudo。
- 容器日志里会出现一行 `[computer-sudo] CHISABOT_COMPUTER_SUDO=full：机器人电脑已开启完整 sudo`。

## 风险（打开前请读）

机器人的 shell 与 API 服务、内置 PostgreSQL 在**同一个容器**里。容器内 root 意味着机器人可以：

- 读 API 进程的环境变量（`sudo cat /proc/1/environ`），其中有 `KEY_ENCRYPTION_KEY`；配合数据库就能解出保存的模型密钥；
- 读写内置数据库（对话、审计记录、设置）、停掉或改坏 API 进程；
- 读其它机器人的工作区和浏览器登录态。

最现实的威胁不是你自己，而是**提示词注入**：机器人浏览网页、读文件时，内容里的恶意指令可能诱导它执行命令、把上面这些东西发出去。打开后建议：

- 在 设置 → 审批 里保留「运行命令」类操作的确认；
- 不要让机器人在无人值守（定时任务、IM 渠道）时浏览不可信网站；
- 定期轮换模型供应商密钥。

它**碰不到宿主机**：容器外的 docker、systemd、SSH、nginx 和证书都不受影响。不建议为了「更高权限」把 `docker.sock` 挂进容器或让容器 SSH 回宿主——那等于把整台服务器的 root 交给模型。

## 生效范围

- `Dockerfile`、`deploy/Dockerfile.zh`、一键更新的 `deploy/updater/Dockerfile.update` 都会安装这个启动脚本。
- 一键更新用的是宿主机上已安装的 `Dockerfile.update`；更新程序会在每次更新结束时把自己升级到新提交里的版本，所以合入后**第二次**一键更新起才带上这个脚本。急用时执行 `sudo sh deploy/install-updater.sh` 先升级更新程序，或用 `CHISABOT_FORCE_BUILD=1 sh deploy/start.sh` 按当前代码重建。
