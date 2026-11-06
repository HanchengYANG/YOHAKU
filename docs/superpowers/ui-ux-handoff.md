# UI/UX 改版交接（2026-11-06）

设计文档：`specs/2026-11-06-ui-ux-overhaul-design.md`（§1–§5，已获确认）。

## 进度

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 错误代码、管理员「错误记录」页、文案原则（§1） | 完成，已合入 main |
| 2 | 侧栏、账号菜单、首页「继续阅读」、书籍页、阅读进度（§2） | 完成，已合入 main（计划 `plans/2026-11-06-ui-ux-step2-navigation.md`） |
| 3 | 阅读细栏与目录、翻页、阅读布局、划词浮层、准备中可读（§3） | 完成（计划 `plans/2026-11-06-ui-ux-step3-reader.md`） |
| 4 | 拍照页（逐张上传、旋转、排序、放进上次的书）、添加页精简（§4） | 完成（计划 `plans/2026-11-07-ui-ux-step4-photo-import.md`） |
| 5 | 任务页、校对、AI 页合并、安装横幅（§5） | 待写计划 |

每一步：先按设计文档写 `plans/2026-11-06-ui-ux-stepN-*.md`，再逐任务执行和审查。

## 用户定下的规则

- 界面文案简短，不显示用户不需要的技术细节。
- 出错只给错误代码，后台按代码查 `error_log`；管理员看到「提示 + 代码」。
- 保留现有视觉风格，只整理细节。手机主要用来拍照，电脑用来浏览和阅读。
- 必要时提交。用户嫌第 2 步太慢，已确认提速（2026-11-06）：每个任务只跑相关测试；每步结束跑一次 `npm run test:all`；小的视觉调整直接改，在浏览器里确认。用户不在时由 Claude 自行判断，不要停下来等确认。

## 测试

| 命令 | 内容 | 要求 |
| --- | --- | --- |
| `npm test` | 单元测试（约 850 项，约 2 分钟） | 全过 |
| `npm run test:browser` | 默认配置：`stage1`、`pwa*` | 全过 |
| `npm run test:browser:sources` | 统一来源（接口替身，静态 `dist`） | 全过 |
| `npm run test:browser:tasks` | 统一任务（接口替身，静态 `dist`） | 全过 |
| `npm run test:browser:ai` | AI 替身服务器上的账号、问答、阅读（约 4 分钟） | 全过 |
| `npm run test:all` | 以上全部，构建一次 | 每步结束跑 |

- **手机项目只跑带 `{ tag: "@phone" }` 的用例**（各配置的 `phone` 项目设了 `grep: /@phone/`）。只有用例里有手机专属布局、触控或抽屉行为时才加这个标签，其余在桌面跑一次即可。
- 两个测试服务器以 `accountRateLimit: false` 启动，不再触发登录限流（生产环境不变）。
- `fixtures/` 被 git 忽略，只在有真实书籍样本的机器上存在。缺少它（或缺文档运行环境 `scripts/install-document-runtime.sh`）时，`baselines/unit-tests-needing-local-fixtures.txt` 里的 PDF／EPUB 用例会失败，其余必须全过。

**2026-11-06 测试精简**：删除了只能走已下线入口的浏览器用例——侧栏／任务页的「导入图片」（旧图片任务创建流程，`c98cd72` 起照片走统一导入）、旧「新建材料」编辑器、对文章整篇打开的旧编辑器（现在「校对正文」一律进来源校对）。共删 `image-tasks.e2e.mjs` 整个文件及 `stage2`／`stage3`／`editor-polish`／`chat-stream` 里 39 个用例；`chat-sheet`、`stage3` 各裁掉一段进旧编辑器的步骤。由此留下的覆盖缺口，在重做对应页面时补测试：

- 第 5 步（校对页）：来源校对编辑器里的输入法合成提交、撤销重做、高亮与输入对齐、编辑面里新建／删除问答组、校对页与阅读页共享对话草稿、校对页流式回答期间禁止新选区提问。
- 旧图片任务界面（只用于恢复以前留下的草稿）不再有浏览器测试，服务端行为仍由 `tests/image-tasks.test.mjs` 等单元测试覆盖。

## 第 3 步做了什么

- `ReadingBar`（细栏）：返回、标题、「N / M 页 ▾」目录浮层（本书各篇 + 本篇各页）、注音、字号浮层、校对、对话（带问答组数）。`BookNavigation`、顶部分页条、元信息行和旧工具栏已删除。
- 正文下方「← 上一页 · N / M · 下一页 →」，键盘 ← →；最后一页「下一篇：…」。单页文章不显示翻页条。
- 阅读页隐藏侧栏但不写 `yohaku.sidebarCollapsed`，「打开书架」以浮层打开；正文列 800px；≥1200px 对话并排，1024–1199px 覆盖，<1024px 底部面板。
- 划词浮层胶囊按钮「翻译」「讲解语法」「提问…」，优先放在选区上方。
- 分句时标题段落总是单独成句（`shared/article-html.mjs` 的 `headingCuts`），修正首个标题与第一句一起高亮。
- 准备中只剩一行状态（「正在准备」「注音还在准备」「需要核对」），有预览就显示原文；失败用 `ErrorNotice`（「准备失败」+ 代码）。
- 顶部错误横幅改用 `ErrorNotice`；书籍操作失败后的静默刷新不再弹第二条提示；首页在正文准备完之前只显示「第 N 页」（摘要多了 `pagesFinal`）。

## 第 4 步做了什么

- 新接口（只对未确认的图片草稿）：`POST /api/imports/:id/files` 追加、`PUT /api/imports/:id/files` 排序、`DELETE /api/imports/:id/files/:fileId`（最后一张不能删）、`POST /api/imports/:id/files/:fileId/rotate`（sharp 先按 EXIF 摆正再转，重新保存图片，`previewUrl` 带版本号）。
- 照片／截图确认后立即请求准备第 1 页（`sources.requestPreparation`），其他类型仍等打开阅读页时才准备。
- `PhotoImport`：首页「📷 拍照添加」直接开相机（`capture="environment"`）；添加页选到图片、继续图片草稿也进这里。每张自动上传，缩略图带序号；点开可左右转、前移后移、删除；长按进入排序后拖动；底栏「拍下一页／相册／完成 · N 张」；「放进」记住上次的书（本机 `yohaku.photoTarget`），可选单独文章或新书籍；完成页「已添加，正在识别」「再拍一篇」「查看进度」。
- 添加页：标题「添加」一行说明，可拖入文件；只有 PDF 让用户选扫描／文字；分章文案压缩。
- 测试：`tests/browser/photo-import.e2e.mjs`（接口替身，跑在 sources 配置里）；`unified-sources` 中只测旧图片列表的用例已迁移或删除。

## 遗留问题

1. 账号菜单「安装为 App」留到第 5 步。
2. 拍照页需要在真手机上试一次：相机直接打开、长按进入排序再拖动、旋转后的缩略图。自动化测试只模拟了文件选择和鼠标拖动。
3. 用真实数据走查（需要用户本人登录，Claude 不能代输密码）：分页文章翻到第 2 页，回首页应显示「第 2 / M 页」，点「继续阅读」从第 2 页开始；顺便看一遍新的阅读细栏和目录。
4. 旧文章路径（真实数据里只剩 1 篇）只统一了细栏和文案，`Reader` 的「重新分句」等旧入口保留。

第 2 步整体审查中未修的小问题：

5. **手机首页 Tab 顺序**：`welcome.css` 用 `order` 把待处理条排在「继续阅读」前面，但 DOM 和 Tab 顺序仍在后面，应直接调整 DOM 顺序。侧栏只有「任务」设置了 `aria-current`，当前打开的书或文章没有。
6. **死代码**：`App.jsx` 的 `importText` 状态、`openUnifiedImport(text)` 参数和 `UnifiedImport` 的 `initialText` 已经不会是真值。
7. **文案**：最近阅读里没打开过的文章也写「继续阅读：…」（`Welcome.jsx`）；任务页还有「导入资料」按钮，应改成「添加」。
8. **缺少浏览器测试**：侧栏任务数字、「N 个导入需要你处理 · 查看」、书籍页「需要处理／准备中」都没有能通过的浏览器测试；`stage1.spec.mjs` 有一个用例假设没打开过的文章能排进最近阅读前 6，前面的用例留下的数据多了会失败。

## 本地预览

`.claude/launch.json` 的 `yohaku-dev` 用 Node 24，强制 `HOST=127.0.0.1`，清空 TLS 设置，使用端口 4317/5173。它会加载 `~/.nvm/nvm.sh` 选 Node 24；没有 nvm 时直接用 PATH 里的 node。依赖装不上或版本不对时先跑 `npm ci`。它读的是真实 `data/`，需要用户的账号。

`yohaku-fixture`（端口 4320）启动 `tests/browser/server.mjs`：带分句／注音测试替身，数据在 `artifacts/preview-data`（每次启动清空），用 `tests/browser/session.mjs` 的夹具账号登录。它直接提供 `dist`，改完前端要先 `npm run build`。用统一导入接口造文章（`POST /api/imports` + `/confirm`），直接 `POST /api/documents` 得到的是旧式文章。页面由 PWA service worker 缓存，换构建后要注销 service worker 或刷新两次；只改 `#` 后面的地址不会重新加载页面。
