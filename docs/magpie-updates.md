# Magpie 一键更新

入口：管理后台 → 模型平台 Magpie → 网关版本与更新。先点「检查更新」，再点「更新到最新版」。
等待正在回答的对话结束后操作；切换期间 Magpie 会短暂重启。ChisaBot 本体和数据库不参与这次更新。

## 执行流程

应用通过现有管理员 API `/api/admin/system-update/magpie` 排队请求。宿主机更新器调用
`deploy/updater/magpie.sh` → `magpie-update.py`，与其他更新共用 `update.lock`。
应用容器不需要 Docker socket。新文件由 `deploy/updater/install.sh` 一同安装。

1. 检查更新按服务器架构读取 registry manifest JSON，将远端镜像的配置摘要与**运行中容器**的镜像 ID 比较。
   查不到时显示「未知」，不能根据本地 `latest` 标签或多架构索引宣称已经更新。
2. 先拉取 `MAGPIE_IMAGE`（默认 `ghcr.io/yetone/magpie:latest`）。拉取失败不停止服务；镜像未变则直接完成。
3. 原容器的环境变量、代理、Web 启动命令、挂载、网络、端口和资源限制全部沿用，不依赖 Compose 路径。
4. 短暂停止 Magpie，将完整 `/config` 数据和容器配置备份到宿主机更新目录的 `magpie-backups/`。
   目录权限 700、文件 600；每次备份有随机后缀，配置和数据不会出现在页面日志里。
5. 保留旧容器，创建新版本。验证带管理密钥的页面、设置与提供方 API，以及网关 healthcheck。
   配置了 ChisaBot 探测地址时，还通过其保存的调用密钥刷新模型目录。
6. 验证失败或更新被中断时，校验备份，再恢复数据、原容器与网络并重新检查服务。
   宿主机突然断电留下的事务会在下一次更新前恢复；不会覆盖其他操作创建的替代容器。

## 配置

宿主机更新器的 `config.env`：

```sh
MAGPIE_IMAGE=ghcr.io/yetone/magpie:latest
MAGPIE_CONTAINER=magpie
MAGPIE_PROBE_URL=http://127.0.0.1:3430/
MAGPIE_HEALTH_TIMEOUT_SEC=60
# 可选：校验 ChisaBot 的实际模型连接，Host 按部署填写。
MAGPIE_CHISABOT_URL=http://127.0.0.1:3001
MAGPIE_CHISABOT_HOST=your-host:8443
```

`MAGPIE_DIR` 和 `MAGPIE_COMPOSE` 不再决定更新方式。固定镜像摘要也可更新，只会切换到所配置的摘要。
Magpie 必须正在运行，具有可写 `/config` 持久化挂载和固定的 `MAGPIE_WEB_KEY`。
更新器需要 Python 3.6+、Docker、buildx 和 GNU tar。

备份和旧容器不会自动删除；确认新版本稳定后再由维护者清理，避免影响人工回滚。
备份包含供应商与登录凭据，应保持仅 root 可读。

## 验证

`python3 deploy/updater/test_magpie_update.py` 无需真实 Docker 或网络，覆盖成功切换、回滚、失败保护、
静态网络与具名卷保留、并发锁、中断恢复、备份校验和摘要解析。
`python3 deploy/updater/test_updater.py` 验证队列和任务进度协议。
