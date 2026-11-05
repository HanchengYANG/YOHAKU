# 章节并发与统一后台任务

## 已批准的约束

- 不同文章独立执行；来源提取、正文校对依次执行，之后分句和注音并行。注音内部先本地生成，再远端校对。
- HTTP 每提供方默认四个执行位、同文章最多两个；CLI 默认两个工作进程、同文章最多一个。旧会话保留 worker 0 目录与归属。
- 远端执行超时默认 180 秒，本地解析默认 120 秒，排队与依赖等待另计。429 退避释放执行位。请求独立取消，迟到结果校验版本和代次。
- 当前文章动态优先，同级文章轮转；连续三个前台任务后给后台一次机会。
- 来源、正文版本、阶段及范围共同决定执行锁；分句和读音写回分别合并到最新 HTML，保护人工内容与问答标记。
- 图片批次、文件导入草稿、分章、正文准备统一列在任务页。正文准备按一次请求的页或来源范围归档，后续访问建立新代次。
- 重试只执行失败节点，成功检查点继续复用。运行、排队和自动重试期间不能删除；失败任务软删除后普通心跳与重启不能重建。
- 删除任务保留文章、原件和预览。删除书籍则使关联执行失效，阻止迟到写回。

## 实现与验证位置

- 资源调度：`server/ai/operation-queue.mjs`、`server/providers/openai/pool.mjs`。
- 来源依赖、范围保留、版本与代次：`server/sources.mjs`、`server/source-merge.mjs`。
- 统一任务目录与类型适配：`server/tasks.mjs`、`server/source-task-adapter.mjs`。
- 任务页与导入核对：`client/components/ImageTasks.jsx`、`UnifiedImport.jsx`、`SourceCorrection.jsx`。
- 有界并发、故障隔离及真实 HTTP 提供方回归：`tests/article-provider-limits.test.mjs`、`source-concurrency.test.mjs`、`source-rate-limit.test.mjs`。
- 生命周期与范围归档：`tests/source-task-scope.test.mjs`、`source-workflow-api.test.mjs`、`tasks.test.mjs`。
- 同步读取作用域只在当前调用内复用查询，返回即清理；没有跨请求正文缓存。稳定任务目录轮询不写入未变化的记录。

## GUI 验收工作流

先通过 GUI 删除旧测试书及 18 篇文章，再上传原始 151 页扫描 PDF。全书本地 OCR、AI 分章、原页核对及确认导入均使用真实界面。

验收用 `scripts/acceptance-source-isolation.mjs` 在真实提供方执行位内，仅对指定导入、PDF 页与步骤注入一次受控延迟或错误；其余请求继续使用现有 AI 配置。生产入口不加载此脚本。

截图、时间线和验收报告保存在忽略的 `artifacts/gui-isolation/`。受控故障隔离和真实 AI 服务返回必须分别记录，不能把后台开始执行等同于正文已可阅读。持续使用中继续检查重复 PDF／照片／截图导入、翻页、切章、任务归档及失败恢复。
