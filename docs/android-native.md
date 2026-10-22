# Android 原生版（CB-068）

Android 客户端（`android/`）是 Kotlin + Jetpack Compose（Material3）原生应用。界面规则见 DESIGN.md §80。

## 结构

| 文件 | 做什么 |
| --- | --- |
| `MainActivity.kt` | Compose 入口、扫码（zxing-android-embedded）、桌面快捷方式、`chisabot://pair` 链接、在线更新（`Updater.kt`） |
| `AppViewModel.kt` | 全部状态：登录 / 机器人 / 聊天 / 面板；导航栈 |
| `GatewayAuth.kt` / `Pairing.kt` | 登录网关请求（和 PC `pc/src/agent/auth.js` 同一套规则），WebView 版沿用 |
| `net/Api.kt` | OkHttp；Cookie 存在 `android.webkit.CookieManager`（和网页兜底页、旧 WebView 版同一份）；SSE 按行解析 AG-UI 事件；401 时用设备令牌静默续期一次 |
| `chat/Model.kt` | AG-UI 事件 → 消息（`AgUiReducer`），历史消息合并工具结果 |
| `chat/WorkSteps.kt` | 干活卡说法，抄 `shared/work-step.ts` + `app/src/lib/chat/work-steps.ts`（改一边要同步另一边） |
| `chat/Turns.kt` | 一轮怎么画：开场一句 / 干活卡 / 过程话 / 结果 / 卡片 / 思考中 / 停顿小点 |
| `md/Markdown.kt` | 轻量 Markdown 块解析 + 切气泡（§69） |
| `ui/*` | 主题（蓝天玻璃）、登录、机器人列表、聊天、Markdown 渲染、json-render 原生组件、面板、网页兜底 |

## 图片与图标

- 图片（Coil）走 `Api.imageClient`：同一份 Cookie、跟随跳转；消息 / 头像里的相对路径 `/api/…` 用 `absUrl()` 补成当前服务器地址。
- 启动图标沿用品牌头像（mipmap 名字不变，桌面图标缓存键稳定）；自适应图标多一层 `monochrome`（头像剪影，`mipmap-xxxhdpi/ic_launcher_monochrome.png`），Android 13+ 打开「主题图标」时可以跟着壁纸变色。
- 网页兜底页跟随系统深浅色：页面开始 / 加载完把网页的 `localStorage.openbot-theme` 和 `html.dark` 对齐到原生。

## 用到的服务器接口（都是已有的）

- 登录：`POST /api/devices/agent/pair`、`POST /auth/device-session`（`X-Device-Token`）、`POST /auth/login`、`GET /auth/session`、`POST /api/devices/agent/unenroll`、`POST /auth/logout`
- 机器人：`GET /api/agents`、`GET /api/settings/preferences`（`mainBotId`）、`GET /api/bot-avatars`（DESIGN §81 自定义头像：图片 / emoji / 首字；接口不存在或没设的机器人 → 按 `avatarSeed` 选渐变色 + 首字）。头像一律圆形。
- 会话：`GET /api/channels?limit=100`（机器人打开最近的一对一会话）、`POST /api/channels {agentIds:[bot]}`（第一条消息时建）
- 历史：`GET /api/copilotkit/threads/<threadId>/messages`、`…/inbox`（`running` = 别处正在回答，原生版每 1.5 秒读一次历史直到结束）
- 回复：`POST /api/copilotkit/agent/<bot>/run`（`Accept: text/event-stream`，body = RunAgentInput，只带新的那条用户消息，服务器以存下的历史为准）；停止 `POST /api/copilotkit/agent/<bot>/stop/<threadId>`
- 面板：`GET /api/live-panels?botId=`（只读；搭建 / 刷新中每 5 秒再读一次）
- 确认卡片：`GET /api/confirmations/requests?thread=`、`POST /api/confirmations/requests/<id> {decision}`、`PUT /api/confirmations/prefs/<类别>`；上游审批 `GET /api/approvals`、`POST /api/approvals/<id>/decision`
- 附件：`POST /api/channels/<channelId>/attachments`（multipart `file` + `uploadGroup`）→ 消息里的 `image` / `document` 段（`/api/attachments/<id>`）
- 重新生成 / 编辑：`POST /api/copilotkit/threads/<threadId>/truncate {fromMessageId, mode}`，然后照常发一轮
- 设置：`GET /api/me`、`GET /api/devices`（只读）
- 模型：`GET /api/models`（`?refresh=1` 强制刷新）、`GET /api/agents/<编码后的botId>/model`、`PUT …/model {model: "模型ID" | null}`。聊天输入框上方可搜索并选择模型、恢复部署默认；服务端按机器人持久保存，与 PC／网页共用。返回应用时重新读取，外部 BOT／无管理权限只读，回答期间禁止切换；保存中不能发送、重发或编辑后重发。成功读取目录后，已失效模型会阻止发送并提示重新选择。

## 构建

`cd android && gradle testDebugUnitTest assembleRelease`（JDK 17、Gradle 8.9、AGP 8.5.2、Kotlin 1.9.24、Compose 编译器 1.5.14）。
正式包必须配置 `ANDROID_KEYSTORE_FILE`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`，缺少签名时直接失败。
Windows 可运行 `./build-release.ps1 -Gradle <gradle.bat路径>`：先测试与构建，再用 `apksigner` 验签、`aapt2` 检查固定包名 `cn.ayase.chisabot` 和版本，输出包含包名的 APK 文件名、SHA-256 和更新 JSON 到 `android/out/`。
离线签名中间产物才允许显式设置 `CHISABOT_ALLOW_UNSIGNED=1`；未签名 APK 无法安装，不能当成安装包分发。CI 发布前验证最终签名、包名、版本和更新 JSON 的 SHA-256，未签名版本不会进入 Release。
后续覆盖更新必须沿用同一把签名密钥，并递增 `versionCode`；本地签名版不要指向使用其他密钥的上游更新源。密钥和密码应离线备份，不能提交到仓库。
调试包允许 `http://10.0.2.2:<端口>`（模拟器连本机开发服务器）。

## 阶段

1. **核心原生（0.1.13）**：登录、机器人列表、聊天、富卡片、面板只读；其余网页兜底。
2. **第二轮（0.1.14，DESIGN §86）**：确认卡片 + 上游审批（§58）、附件（照片 / 拍照 / 文件，§56）、停止、重新生成 / 编辑重发（§67）、服务器行（§68.2）、原生设置基础（外观、账号 / 服务器、设备只读）。还没有：回答期间插话（§38 收件箱）、别处正在回答时接上事件流（现在每 1.5 秒读历史）、render_ui 表单组件、聊天文件卡（`⟦chisabot:files⟧`）。
3. **0.1.53**：原生模型选择、搜索、刷新与部署默认；签名、包名和更新源校验。后续：原生设置其余部分（主机器人、审批偏好）、通知、离线缓存、桌面小组件。
4. Claude Code 标签页原生化；管理后台继续用网页。
