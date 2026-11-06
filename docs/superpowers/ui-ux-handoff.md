# UI/UX 改版交接（2026-11-06）

设计文档：`specs/2026-11-06-ui-ux-overhaul-design.md`（§1–§5，已获确认）。

## 进度

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 错误代码、管理员「错误记录」页、文案原则（§1） | 完成，已合入 main |
| 2 | 侧栏、账号菜单、首页「继续阅读」、书籍页、阅读进度（§2） | 完成，已合入 main（计划 `plans/2026-11-06-ui-ux-step2-navigation.md`） |
| 3 | 阅读页（§3） | 待写计划 |
| 4 | 拍照导入，手机首页「拍照添加」直接开相机（§4） | 待写计划 |
| 5 | 任务页、校对、AI 页合并、安装横幅（§5） | 待写计划 |

每一步：先按设计文档写 `plans/2026-11-06-ui-ux-stepN-*.md`，再逐任务执行和审查。

## 用户定下的规则

- 界面文案简短，不显示用户不需要的技术细节。
- 出错只给错误代码，后台按代码查 `error_log`；管理员看到「提示 + 代码」。
- 保留现有视觉风格，只整理细节。手机主要用来拍照，电脑用来浏览和阅读。
- 必要时提交。第 2 步之后，用户觉得流程太慢：每个任务只跑相关测试，每步结束再跑全套回归；小的视觉调整直接改，在浏览器里确认。

## 测试基线

`artifacts/` 被 git 忽略，基线复制在 `baselines/`。新机器上先恢复：

```bash
mkdir -p artifacts && cp docs/superpowers/baselines/*.txt artifacts/
```

- 单元测试：已知失败 26 项（`baseline-failing-tests.txt`）。对比命令见第 2 步计划开头。
- 浏览器：默认配置、`tests/browser/sources.config.mjs`、`tests/browser/tasks.config.mjs` 必须全过。
- AI 配置（`playwright.ai.config.mjs`）：已知失败 140 项（`ai-browser-baseline-failing.txt`），只看有没有新增。

## 遗留问题

1. **AI 测试登录限流**：`server/accounts.mjs` 限制同一 IP 15 分钟最多登录 30 次，AI 测试每个用例都登录，30 次之后全部 429，只能等到超时。AI 测试不调用真实模型（`tests/browser/ai-server.mjs` 里是写死的回复）。修法：测试服务器放宽限制，或登录一次后共用登录状态。用户已同意在第 2 步之后修。
2. `image-tasks.e2e.mjs` 的「无待处理任务不显示数字…」用例还会点击 `c98cd72` 已删掉的「继续上传」，需要按现在的导入流程重写。
3. `client/App.jsx` 顶部错误横幅仍显示服务器原文，留到第 3 步改用 `ErrorNotice`。
4. 添加页（统一导入）的说明文案仍然啰嗦，留到第 4 步。
5. 账号菜单「安装为 App」留到第 5 步。
6. 换机器后用真实数据再走查一遍：分页文章翻到第 2 页，回首页应显示「第 2 / M 页」，点「继续阅读」从第 2 页开始。

第 2 步整体审查中未修的小问题（重要问题和页面闪烁已修）：

7. **进度条提前到 100%**：`pageCount` 只统计已准备好的页（`server/sources.mjs` 的 `pageCounts`），正文还在准备时首页会显示「第 2 / 2 页」、进度条满格。应在准备完成前只显示「第 N 页」（`client/library-model.mjs` 的 `pageProgress`）。
8. **书籍页可能出现两条提示**：重命名或调整顺序失败后会重新拉取书籍，如果这次也失败（断网、或书已在别处删除），`App.jsx` 会把服务器原文放进顶部横幅，和书籍页的 `ErrorNotice` 同时出现。改横幅时（第 3 步）一起处理。
9. **手机首页 Tab 顺序**：`welcome.css` 用 `order` 把待处理条排在「继续阅读」前面，但 DOM 和 Tab 顺序仍在后面，应直接调整 DOM 顺序。侧栏只有「任务」设置了 `aria-current`，当前打开的书或文章没有。
10. **死代码**：`App.jsx` 的 `importText` 状态、`openUnifiedImport(text)` 参数和 `UnifiedImport` 的 `initialText` 已经不会是真值；`BookNavigation` 的 `onAddImage` 属性和「导入阅读资料」标签与实际的「添加文章」不一致。
11. **文案**：最近阅读里没打开过的文章也写「继续阅读：…」（`Welcome.jsx`）；任务页还有「导入资料」按钮，应改成「添加」。
12. **缺少浏览器测试**：侧栏任务数字、「N 个导入需要你处理 · 查看」、书籍页「需要处理／准备中」都没有能通过的浏览器测试；`stage1.spec.mjs` 有一个用例假设没打开过的文章能排进最近阅读前 6，前面的用例留下的数据多了会失败。

## 本地预览

`.claude/launch.json` 的 `yohaku-dev` 用 Node 24，强制 `HOST=127.0.0.1`，清空 TLS 设置，使用端口 4317/5173。它会加载 `~/.nvm/nvm.sh` 选 Node 24；没有 nvm 时直接用 PATH 里的 node。依赖装不上或版本不对时先跑 `npm ci`。
