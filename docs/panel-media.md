# 面板媒体能力

实时面板和 `render_ui` 共用的组件目录新增 `Video`、`Audio`、`WebEmbed`、`SwipeFeed`。这是通用渲染能力，没有预置站点、推荐流、站源解析、账号或业务面板。旧 HTML 面板的标签白名单没有放宽；不能通过 HTML 插入任意 script、iframe 或媒体标签。

## 组件

| 组件 | 必填属性 | 可选属性 | 行为 |
| --- | --- | --- | --- |
| `Video` | `src` | `title`、`poster`、`aspect`、`autoplay`、`muted`、`loop` | 原生播放、暂停、声音、进度和全屏控制；默认点击播放 |
| `Audio` | `src` | `title`、`loop` | 原生音频控制；默认点击播放 |
| `WebEmbed` | `url`、`title` | `mode`、`height` | 用户点击“加载网页”后才建立外部页面 |
| `SwipeFeed` | 无 | `label`、`height` | 每个直接子元素为一页，纵向滚动吸附，无翻页按钮 |

地址必须使用 HTTPS，不能携带 URL 用户名或密码。`Video.src` 和 `Audio.src` 必须是实际媒体流，不是网站页面。`Video.aspect` 接受 `16:9`、`9:16`、`4:3`、`auto`。高度范围为 180–720，默认 480。

`SwipeFeed` 使用浏览器滚动和 CSS scroll snap，支持鼠标滚轮、触控板、触摸，以及鼠标上下拖动；聚焦容器后也可按方向键或 PageUp/PageDown。播放器控制条不作为拖动起点。不可见的音视频暂停，避免多页同时出声。

## 网页两种模式

`mode: "iframe"` 是默认模式，适用于明确允许第三方嵌入的播放器或网页。iframe 保留脚本、表单和媒体所需的限定沙箱权限，不获得 ChisaBot 的本机桥；从屏幕隐藏时卸载页面以停止后台出声。网站的 X-Frame-Options、CSP、登录、跨域和媒体策略仍然有效。

`mode: "browser"` 需要包含本次变更的 PC 客户端。它使用 Electron `WebContentsView`，不经 JSON 面板脚本执行远程网页；页面可正常联网，并使用网站自身的滚动、表单和手势。普通浏览器或旧 PC 客户端会提示能力不可用，不会把失败的 iframe 当成已接入。

PC 网页使用独立于 ChisaBot 登录会话的存储分区，不注入 preload 或本机桥，关闭 Node integration，保留 Chromium sandbox 和 context isolation。拒绝权限申请、自动下载、新窗口和非 HTTPS 顶层跳转。最多同时打开四个网页面板。

本机桥只接受 ChisaBot 主窗口的受信任顶层框架，校验实例标识和内容区域坐标。远程页面不能调用此桥。原生网页区域被裁切、面板隐藏或其他菜单/对话框覆盖时隐藏并暂停；普通 HTML 媒体通过可见性观察暂停。

“弹出小窗”迁移同一 WebContents，保留页面进度和会话。小窗支持声音、置顶、放回面板；Windows 使用已经实测可保持置顶的 `screen-saver` 级别，初始位置和大小限制在工作区内。关闭小窗会放回面板；关闭组件、主页面导航或渲染进程退出会释放远程内容。

## 能力边界与发布

这是播放器、网页容器和滑动容器，不是站点适配器。没有新增通用脚本执行、任意 fetch、视频解析、媒体转码或第三方推荐流接口。媒体能否解码取决于 Chromium 的格式支持；自动有声播放受浏览器策略约束；网页仍可能要求用户登录或验证。

服务端组件目录、前端注册表和 PC 本机桥需要一起更新后，`browser` 模式才能在已安装客户端使用。Android 原生组件表没有在本次扩展范围内。

## 验证

- `pc/test/media-host.check.js`：来源校验、HTTPS 限制、坐标边界、会话隔离、隐藏静音、弹出/放回/释放。
- `app/tests/panel-media.test.tsx`：组件规格、原有 HTML 限制、播放器控制及无翻页按钮的容器。
- `app/tests/fixtures/media-capabilities.tsx` 和 `pc/test/media-smoke.cjs`：独立真实 Electron 验收页面，仅使用公开测试媒体和 Example Domain，未接入产品业务。

示例测试构建：在 `app` 下使用 Bun 将 `tests/fixtures/media-capabilities.tsx` 构建为 browser bundle，输出到一个独立目录；再用 Electron 运行 `pc/test/media-smoke.cjs --output=<该绝对目录>`。结果保存在该目录的 `result.json` 和 PNG 中。测试使用本机测试代理 127.0.0.1:7897；生产控制器沿用系统网络配置，没有固定此代理。
