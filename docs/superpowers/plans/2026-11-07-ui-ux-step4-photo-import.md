# UI／UX 改版第 4 步：导入（手机以拍照为主）

**设计文档：** `docs/superpowers/specs/2026-11-06-ui-ux-overhaul-design.md` §4，文案按 §1.1。
**节奏：** 每个任务只跑相关测试；步骤结束跑一次 `npm run test:all`；视觉在内置浏览器里确认（`yohaku-fixture`，1280／375 宽）。

## 现状

- 所有新导入都走 `UnifiedImport`：在本机攒文件（上移／下移／移除）→ `POST /api/imports` 一次上传建草稿 → 选「确认来源类型」→（PDF 分章）→ `POST /api/imports/:id/confirm`。
- 草稿接口只能整批建立，没有追加、删除、排序、旋转单张照片的接口；草稿 `files[]` 带 `imageId`、`contentHash`、`previewUrl`。
- 未完成草稿已是任务（状态 `draft`），计入「需要处理」，首页和侧栏数字已经包含（§4.3 已满足，只需「继续」打开对的页面）。
- 确认导入后不会开始准备：`sources.requestPreparation` 只在阅读心跳里调用。
- 首页「📷 拍照添加」现在打开添加页。

## 任务

### 1. 草稿照片接口（`server/imports.mjs`）

只对仍是 `staged` 的图片草稿开放：

- `POST /api/imports/:id/files`（multipart `files`）：追加图片，处理同新建（保存原图、`imageId`、`contentHash`）；非图片 400。重新计算 `suggestedType`。
- `DELETE /api/imports/:id/files/:fileId`：删掉一张；最后一张不能删（400「至少保留一张照片」），整稿放弃走任务删除。
- `PUT /api/imports/:id/files` `{order:[fileId…]}`：排序，必须是现有 id 的排列。
- `POST /api/imports/:id/files/:fileId/rotate` `{turns:1|-1}`：用 sharp 旋转原文件（先按 EXIF 摆正），重新保存图片，更新 `imageId`、`contentHash`、`bytes`，`previewUrl` 加版本号。
- 每个写操作返回 `present(draft)`；非本人 404，已确认 409。

测试：`tests/imports.test.mjs` 新增追加、删除（含最后一张）、排序（非法排列）、旋转（像素宽高互换、确认后来源用旋转后的图）、已确认草稿 409。

### 2. 导入后自动准备第一页

- `sources` 导出 `requestPreparation`；确认导入后对第一篇新文章请求第 1 页（`mode:'reading', index:0`），失败只记录不影响导入结果。

测试：确认后无需阅读心跳，第一篇文章已有准备请求。

### 3. 拍照页 `PhotoImport`（手机为主，桌面同用）

新组件 `client/components/PhotoImport.jsx`，样式 `client/photo-import.css`。

- 入口：首页「📷 拍照添加」直接触发 `<input type="file" accept="image/*" capture="environment">`，选到照片后打开拍照页；添加页里选到图片也转到拍照页。
- 第一张照片建草稿，之后每张自动追加；缩略图带序号，上传中／失败（可重试）状态在缩略图上。
- 点缩略图打开操作层：向左转、向右转、前移、后移、删除。长按拖动排序（pointer 事件），操作层是键盘和读屏的等价入口。
- 顶部：标题（可空，占位「<月日> · 照片」）、右上角类型小标签「照片／截图」（点按切换，默认用服务器建议，否则「照片」）。
- 「放进」：上次选的书（存本机 `yohaku.photoTarget`），可改「单独文章」或「新书籍…」（先建书再确认）。
- 底部固定栏：「📷 拍下一页」「相册」，下面「完成 · N 张」。
- 完成后确认页：「已添加，正在识别」+「再拍一篇」「查看进度」（打开新文章，阅读页显示准备状态）。
- 草稿 id 存 `sessionStorage`，刷新后恢复；任务页「继续」图片草稿时打开拍照页。

测试：`unified-sources` 新增（接口替身）：拍照页追加、旋转、删除、排序后确认的请求顺序；默认标题与类型；放进上次的书；确认页两个按钮。手机项目加 `@phone`。

### 4. 桌面添加页精简（`UnifiedImport`）

- 标题「添加」，一行说明：可拖入文件、选择文件或粘贴文字。拖放区域覆盖整块。
- 选到图片 → 转拍照页；文字／EPUB 直接确认，不再显示「确认来源类型」；只有 PDF 让用户选一次「扫描 PDF／文字 PDF」。
- PDF／EPUB 分章：长说明压缩为一个「AI 提议章节」按钮和一行状态；其余流程不变。

测试：更新 `unified-sources` 中引用旧标题、旧说明和「确认来源类型」的断言。

## 收尾

1. 内置浏览器走查：手机 375 走一遍拍照（用相册选图代替相机）、桌面 1280 拖入 PDF 和粘贴文字。
2. `npm run test:all`。
3. 更新 `ui-ux-handoff.md`，提交。
