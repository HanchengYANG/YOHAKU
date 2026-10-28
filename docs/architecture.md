# 账号、书籍与 AI provider 边界

更新日期：2026-10-28。

## 两种账号分开

网站账号负责登录、资料和权限；AI provider 连接负责该用户的模型授权。网站登录成功不代表 AI 已授权，未授权时不会寻找管理员或其他用户的连接作为后备。

| 层 | 可信身份与职责 |
| --- | --- |
| 网站会话 | HttpOnly Cookie 对应服务端会话哈希，得到 `req.user.id` |
| 用户资料 | 所有文章、搜索、导出、原图、识别草稿和聊天按这个 user ID 查询 |
| Provider 选择 | 按站内 user ID 读取当前 provider；客户端传来的 userId/ownerId 不作为归属依据 |
| Provider 连接 | 每个 `(userId, providerId)` 有独立认证管理器、运行时和存储目录 |
| 外部身份绑定 | `(providerId, subject)` 唯一绑定网站用户；同一 OpenAI 身份不能被两个网站用户同时借用 |

管理员可以生成单次、有限期的邀请码。朋友注册后有自己的书架、会话和 provider 目录；管理员身份不会让 AI 请求绕过资料归属检查。

## 代码结构

```text
server/accounts.mjs                 网站账号、会话、邀请
server/books.mjs                    多页书籍、页序、归属与版本保护
server/providers/index.mjs         提供方注册与构造入口
server/providers/openai/index.mjs  OpenAI connection adapter
server/providers/openai/auth.mjs   本应用的 SIWC OAuth 与刷新
server/providers/openai/runtime.mjs Codex stdio、会话恢复、最终结果校验
server/ai/routes.mjs               图片与讨论业务，选择当前用户的 provider
server/ai/images.mjs               受限图片解码及原图持久存储
shared/ocr.mjs                    纯正文Schema、OCR／纠错提示、历史OCR兼容与验证
shared/ocr-correction.mjs         本地文字纠错、缺失读音Schema、提示与逐字校验
server/ocr/manga.mjs              持久Python进程、JSONL协议与请求生命周期
server/ocr/manga-worker.py        mokuro自动分区与MangaOCR本地识别
server/ocr/ndl.mjs                NDLOCR-Lite解释器与共用JSONL进程配置
server/ocr/ndl-worker.py          国会图书馆布局、文字识别与读序适配
server/ocr/line_preprocess.py     横排行的自动几何估计与原RGB重采样
shared/ruby-display.mjs           整词读音对齐与汉字部分显示
```

应用只通过 connection 的 `auth`、`runtime.run`、`runtime.status` 和 `close` 接口使用提供方。OCR 的正文／注音结构和阅读界面不依赖某个厂商的 RPC 协议。OpenAI 的 OAuth、Codex 协议及模型目录处理留在其 adapter 内。

正文纠错与注音使用两个独立Schema和请求：`ImageImport`一次点击后顺序调用`/images/:id/recognize`及`/images/:id/annotate`，两步完成再交给Editor。失败时缓存已上传图片和已完成正文，重试仅续失败阶段；最终页面总计时等待原图metadata／解码和双rAF。注音仍严格核对逐字相同并保护已有来源。`image_drafts.blocks`保留初始识别／正文纠错输出，第二阶段另存`annotation.blocks`和自己的计时、模型、等级；保存材料时用注音阶段作为来源锚点，原识别记录不被人工校对或新增注音改写。

当前图片导入固定走纯LLM：第一阶段使用`OCR_BODY_SCHEMA`，模型只返回`{text}`，由程序展开为无读音草稿；第二阶段同时传已确认正文和本人原图的方向规范化像素，图片仅供参考读音，使用稀疏`blocks/words`返回含汉字词的`t/r`，原假名／标点／空白由程序回填。依序定位不得跳过任何未覆盖汉字，未知词也必须返回null，以防重复同形词错位。图片版本在推理后再次核对，记录`annotation.imageReference`；参考图片不等于逐词证实source，新增仍为generated。最终正文、来源与读音保护由程序执行。历史`OCR_SCHEMA`和本地OCR接口保留兼容，当前UI不再选择本地引擎。

注册表目前只有 OpenAI 启用，认证方式是 `chatgpt_subscription`。`claude` 和 `api_base` 只保留不可用的注册项与空认证方式，界面禁用，调用返回 501；没有客户端、密钥输入、外部请求或计费接入。

## 存储归属

- 数据库：`data/yohaku.sqlite`，每条资料有 owner/user ID。
- 图片：`data/images/`，由 `image_owners` 索引检查所有权，不直接公开整个目录。上传从revision 1开始，保存旋转时先写新像素版本，再原子切换元数据指针；同一图片ID继续使用，旧像素内部保留，过期revision拒绝覆盖。
- AI 授权：`data/users/<userId>/providers/openai/`。
- Codex 历史：上述提供方目录下的 `runtime/`，再按外部账号区分。
- 所有真实学习数据、授权和备份都被 Git 忽略。

正文块的可选`type`仅允许paragraph、heading和list_item；旧无类型块按段落显示。页面用受控标签呈现，Markdown导出保留既有标题与条目，不执行模型HTML。当前纯正文识别按换行展开paragraph，来源页为unknown、nonBody为空，不恢复原图方向、页边界或标题／列表语义；历史结构化识别信息仍保留。阅读与编辑统一横排。

当前注音优先参考清晰印刷读音，缺失或模糊才按语境补全；由于稀疏注音结果不返回逐词来源证据，新增读音统一generated。已有source／generated／manual保持，历史记录不迁移。通用解析器继续兼容历史数字source，并过滤新草稿不含汉字片段的冗余读音。存储与校对使用完整词读音；阅读和Markdown导出按正文假名对齐，只在汉字上显示对应小假名。不能可靠对齐时不猜分，完整读音保留于悬停提示和校对条目，原文与整词记录保持。

初次创建站内账号时，旧本机资料归初始管理员。这与管理员创建处于同一数据库事务，失败会整体回滚。此前在本应用完成的 SIWC 授权留在旧目录，只有初始账号可以明确点击「绑定刚才的 ChatGPT 授权」认领；认领保留原注册、主机 ID 和历史，并形成持久外部身份绑定，不默认共享给朋友。

## 书籍与页面

`books`存储书名、owner、revision和创建／更新时间；`documents`新增可空的`book_id`与`page_position`。没有book_id的旧资料继续作为独立材料，不自动归书或合并。成员页面仍是原document，保留独立ID、正文块、整词读音、原图、识别／注音记录和聊天，不把整本书压成单篇长文。每次导入一张图片或一份文字，保存到所选书籍末尾；position从1连续排列。

`GET /api/books`列书籍摘要，可按书名或书内页面标题／正文搜索；`GET /api/books/:id`返回书籍与按序页面摘要。`POST /api/books`创建空书，传documentId则把本人既有独立材料原地设为第一页。`GET /api/documents`只列独立材料；成员页面仍通过原文档接口读取／校对，响应带bookId／position。既有独立材料可通过PUT文档指定本人的bookId追加归书，保留原ID及关联数据；已经归书的页面不通过该接口换书或移出。所有书籍与页面查询均限制当前站内用户。

书名编辑、页面完整排列及整书删除使用书籍revision拒绝过期写入，修改书内页面也会更新书籍版本。排序必须覆盖当前全部页面且不能重复。删除单页会删除该页讨论、重排剩余position并更新书籍；整书删除在同一数据库事务中删除页面及其讨论。两种删除均保留图片文件与识别草稿，不跨用户清理。归书、重排、删除和摘要版本更新按事务写入，避免出现页面顺序缺口或半本书状态。

前端`#book/<id>`打开书籍目录，页面继续沿用`#<documentId>`；书籍与独立材料共同出现在书架，成员页在书籍目录中显示。分页只切换当前document，讨论仍以页面ID保存。新页面的保存位置由编辑器明确选择；现有成员页校对不隐式移动到别的书籍。

## OAuth 回调归属

发起授权时保存一次性 state 对应的网站 user ID 和 provider ID。来自 OpenAI 的跨站回调可能不带 SameSite=Strict 网站 Cookie，因此回调按服务端 state 找回原连接，再由认证模块校验 state、nonce、签名、audience、时效及 granted scopes。不会拿当前浏览器碰巧登录的另一个网站账号接收授权。

运行时当前固定验证 Codex CLI `0.160.1`，使用官方实验字段 `environments: []` 禁止模型访问执行环境。线程创建和每一轮都显式指定；不支持时失败，不回退到默认环境。模型推理、结构化识别及持续运行仍须使用真实账号另行验证。

OCR单独请求`reasoningEffort: low`，OpenAI adapter按当前账号`model/list`的支持列表校验后映射到`turn/start.effort`；不支持或能力信息缺失时明确拒绝，不静默沿用更高等级。普通问答不增加此覆盖。线程start/resume返回的有效等级及后续显式覆盖按线程记录，识别记录保存本次等级；未知返回null，不用目录推荐默认值冒充实际使用值。模型仍取账号目录的默认图片模型，最近实测为gpt-6.1-sol，未硬编码升级到其他型号。
