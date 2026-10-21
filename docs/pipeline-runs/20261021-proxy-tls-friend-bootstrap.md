# CB-088：代理 IP 证书与首次构建

分支 `fix/proxy-tls-friend-bootstrap`，基于 `c4d68728`，上传至个人 Fork。尚未创建 PR、打包客户端或部署服务。

## 改动

- `pc/src/agent/proxy.js` 在隧道上的 `tls.connect` 中传入目标 `host`。IP 不发送 DNS SNI 时仍按 IP SAN 校验；保留证书链与目标身份验证。
- `deploy/friend-up.sh` 安装依赖后先从仓库根生成中文租户配置，再运行 Vite。显式使用与前端构建相同的租户目录，生成失败立即停止。已有前端产物的跳过行为不变。
- 新增代理 TLS 与部署脚本回归，可按测试手册运行；PC 发布测试会自动发现新的 `*.check.js`。`ChisaBot checks` 的工作流入口改动保留在本地：当前 GitHub OAuth 授权缺少 `workflow` 权限，无法上传工作流文件；修复与测试代码正常上传。

## 验证

- 新增回归 8 项通过：HTTP CONNECT / SOCKS5 两条线路分别验证匹配 IP SAN、匹配 DNS SAN、错误目标拒绝、不受信任证书拒绝；隔离 shell 覆盖根目录 / app 两种 Vite 布局、安装 / 生成 / 构建失败停止，以及已有前端产物跳过构建。
- 同一组回归对照原版：受信任 IP 证书被误按 `localhost` 校验；首次构建因缺少生成配置而失败。修复版全部通过。
- PC 登录、重连与 TLS 相关测试 17 项通过；加上部署隔离回归，共 23 项相关测试通过。
- PC 外壳指纹校验、`sh -n deploy/friend-up.sh`、`git diff --check` 通过。
- 全量 PC 测试：142 项，131 通过、8 失败、3 跳过。隔离原版对照包含相同 8 项失败，另出现一次重连清理竞态（原版 141 项，129 通过、9 失败、3 跳过）。失败涉及工作区进程、shell / 进程枚举、Windows 执行 mock 脚本及临时 SSH 密钥 ACL；本轮不修改这些不相关代码。
- 没有根目录 `.env` 的情况下，实际运行 `bun scripts/generate-app-config.ts` 成功。

## 验证边界

TLS 用公开的测试证书与测试私钥，仅在独立子进程中信任；所有代理和目标都在本机 loopback，不请求实际服务器。shell 回归中的 Bun 与启动脚本使用替身，不会启动 Docker 或安装更新器。

类型检查与完整前端构建已尝试，但依赖安装在 6 分钟期限内未完成并超时退出：类型检查缺少 `tsc` 命令链接，Vite 首次缺少 `rollup/parseAst`，后续重试报 `failed to load config`（详细错误为 `undefined`）。因此尚不能宣称完整构建通过。依赖获取的本地调整不改变上游版本或完整性哈希；安装退出后已恢复原始 `bun.lock`，与上游无差异。
