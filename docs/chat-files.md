# 聊天文件与图片生成（ChisaBot）

设计见 DESIGN.md「聊天文件与图片生成」一节。

- 机器人聊天里上传的文件（不设应用级大小上限）存进库（按人隔离）并写进机器人工作区 `uploads/`；消息里是 `/api/chat-files/<id>`。
- 机器人用 `file_share` 把工作区文件交给用户（聊天里出可下载的文件卡，图片 / PDF 可预览）。
- 图片生成默认关闭；管理员在 设置 → 模型 →「生图模型」选接口（MiniMax image-01，或 OpenAI 兼容 /v1/images），打开后机器人有 `image_generate` / `image_edit`。每张图按模型价格计费。旧地址 `/admin/images` 跳到这里。
- 识图：管理员在 设置 → 模型 →「识图模型」选「跟随主模型」（默认，图片直接给聊天模型）或单独的 OpenAI 兼容看图模型；选了后上传的图片先由它写详细描述 + OCR（按文件、模型缓存），文字给聊天模型，机器人还有 `image_inspect` 追问细节。
- 每个人可以在 设置 → 生图与识图（`/settings/media`）换成自己的生图 / 识图接口、密钥、模型，不设就用默认。密钥加密，只显示末四位；普通用户只能填公网接口。

## 对话附件格式（0.1.58）

网页、PC 内的网页和 Android 原生聊天支持常见办公文件、文本/代码及压缩包。上传仍按账号和会话隔离，每条消息最多 8 个附件；图片上限 8 MB、纯文本上限 1 MB、办公文档/压缩包/音视频不设上传大小上限。非图片以附件方式下载，HTML 和代码不会作为站内页面执行。

| 文件 | 提供给机器人的内容 |
|---|---|
| DOC / DOCX / DOCM、RTF | 正文与表格文本；DOCX 还包含页眉、页脚和脚注等可读取文字 |
| PDF | 按页提取文字层；扫描件没有文字时明确说明未进行 OCR，不能假称已读 |
| XLS / XLSX / XLSM | 工作表和单元格文本；XLSX 的公式保留原文，不重新计算；每表最多 5,000 行、100 列 |
| PPT / PPTX / PPTM | 幻灯片文字；PPTX 包含可读取的备注 |
| ODT / ODS / ODP | 文档中的段落与单元格文字 |
| TXT、Markdown、CSV/TSV、JSON、YAML、XML、日志和常见源代码 | UTF-8 文本，服务器校验实际字节 |
| ZIP / XAPK / APK / 7Z / RAR / TAR / TGZ 等压缩包 | 目录清单，不自动释放、执行内部文件，也不假称已阅读包内正文；XAPK 额外读取有大小保护的 `manifest.json`，不反编译 APK；单个 GZ/BZ2/XZ 文本可以提取 |
| 常见音视频 | 保存和下载原文件；本次不提供语音转写或视频内容理解，模型会收到明确说明 |

上传不设大小上限不代表模型会一次阅读全文；服务器可用内存、磁盘和解析超时仍可能使过大的文件处理失败。单个文件最多给模型 120,000 字符，超过后明确标记部分读取。文档内图片、图表和页面排版不随文字提取传入模型；需要视觉理解时可另发图片。损坏、加密或过于复杂的文档返回具体读取失败提示；历史中读取失败的附件改为说明，不阻断后续所有聊天。

解析器使用独立、限时的 Python 子进程，限制内存、CPU、解压体积和输出；不再按 20 MB 拒绝输入；不会运行文档宏、脚本或包内程序。运行镜像包含 `python3-openpyxl`、`python3-pypdf`、`antiword`、`catdoc` 和 `p7zip-full`，本次需要构建含这些依赖的镜像，不能只替换网页。非标准 Python 路径可通过 `CHISABOT_FILE_PYTHON` 配置。

本地验证：`python3 server/tests/file-extraction_test.py`；`bun test server/tests/common-file-attachments.test.ts` 覆盖实际文件从引用到模型文本的路径。上传集成测试在专用 `TEST_DATABASE_URL` 上运行 `server/tests/attachment-routes.test.ts`。Android 0.1.58（versionCode 256）需要安装新版 APK 才能放开原生文件选择限制；PC 刷新服务器网页即可。

## 接口
- `POST /api/chat-files`（multipart：`file`、`agentId`）→ `{ file }`
- `GET /api/chat-files?agentId=&images=1&limit=` → `{ files }`
- `GET /api/chat-files/:id`（本人；`?download=1` 强制下载）、`DELETE /api/chat-files/:id`
- 管理员：`GET|PUT /api/chat-files/settings/image`、`POST /api/chat-files/settings/image/test`（§56，保留兼容）
- 生图 / 识图设置：`GET /api/media-models/default`、`PUT /api/media-models/default/image|vision`（管理员）；`GET /api/media-models/me`、`PUT /api/media-models/me/image|vision`；`POST /api/media-models/test/image|vision`（`scope: default | personal`）

## 环境变量
- `MINIMAX_API_KEY`：MiniMax 图片接口的密钥（设置页没填密钥时用）；`OPENAI_BASE_URL` 指向 minimax 时也会沿用 `OPENAI_API_KEY`。
- `IMAGE_API_KEY`：OpenAI 兼容图片接口的密钥（设置页没填时用）。
