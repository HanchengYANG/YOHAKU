export function pageSelection(selection, page) {
  if (!page) return selection;
  return { ...selection, start: page.start + selection.start, end: page.start + selection.end,
    readingPageId: page.id, sourceIds: page.sourceIds || [],
    pageLocalStart:selection.start,pageLocalEnd:selection.end,
    ...(page.sourceVersions ? {sourceVersions:page.sourceVersions} : {}) };
}

export function readingPageLabel({ index = 0, complete, totalPages }) {
  return complete && totalPages ? `第 ${index + 1} / ${totalPages} 页` : `第 ${index + 1} 页`;
}

const preparationNames = {extract:"正文提取",correct:"正文校正",segment:"分句",annotate:"注音",annotate_local:"本地注音"};
const preparationRunning = {extract:"正在提取正文",correct:"正在校正正文",segment:"正在分句",annotate:"正在注音",annotate_local:"正在本地注音",ready:"准备完成"};
const preparationStates = {queued:"排队中",retry_wait:"等待自动重试",running:"处理中",failed:"已失败",requires_review:"待核对",pending:"等待处理",editing:"编辑中",ready:"已完成",paused:"已暂停"};

export function processingStepLabel(step) {
  return preparationNames[String(step || "").split(":")[0]] || "正文准备";
}

export function processingDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2,"0")} 秒`;
}

export function readingPreparation({progress,current,error} = {}) {
  const step = String(current?.step || progress?.stage || "").split(":")[0];
  let state = preparationStates[current?.state] ? current.state : progress?.stage === "ready" ? "ready" : "running";
  if (error && !["failed","requires_review"].includes(state)) state = "paused";
  const name = processingStepLabel(step);
  const stageLabel = state === "failed" ? `${name}失败` : state === "requires_review" ? `${name}待核对`
    : state === "paused" ? `${name}已暂停` : state === "editing" ? "等待人工编辑完成"
      : state === "retry_wait" ? `等待自动重试${name}` : ["queued","pending"].includes(state) ? `等待${name}` : state === "ready" ? "准备完成"
        : preparationRunning[step] || "正在准备本页";
  const elapsedMs = state === "retry_wait" ? current?.retryWaitMs : state === "queued" ? current?.queueMs ?? current?.elapsedMs : current?.elapsedMs;
  const elapsedLabel = Number.isFinite(elapsedMs) && elapsedMs >= 0 && ["queued","running","retry_wait"].includes(state)
    ? `${state === "queued" ? "已排队" : state === "retry_wait" ? "已等待" : "已运行"} ${processingDuration(elapsedMs)}` : "";
  return {state,stageLabel,statusLabel:preparationStates[state],busy:["queued","running","pending","retry_wait"].includes(state),
    animate:state === "running",paused:["failed","requires_review","paused","editing"].includes(state),
    sourceLabel:current?.source ? current.source.label || sourceLabel(current.source) : "",elapsedLabel,
    errorMessage:error || current?.error?.message || ""};
}

export function sourceLabel(source) {
  const position = (source.position ?? 0) + 1;
  if (["text_pdf", "scan_pdf", "pdf_text", "pdf_scan"].includes(source.type))
    return `PDF 原页 ${source.page ?? source.preview?.page ?? source.original?.page ?? position}`;
  return `${({photo:"照片",screenshot:"截图",epub:"EPUB 段落组",text:"文字段落组",legacy_text:"历史正文快照"})[source.type] || "来源"} ${position}`;
}

export function splitChapter(chapters, index, page) {
  const chapter = chapters[index];
  if (!Number.isInteger(page) || page <= chapter.startPage || page > chapter.endPage) return chapters;
  return chapters.flatMap((item, i) => i !== index ? [item] : [
    {...item,endPage:page - 1},
    {...item,id:`${item.id}-split-${page}`,title:`${item.title}（续）`,startPage:page,needsReview:true},
  ]);
}
export function moveChapter(chapters, index, direction) {
  const destination = index + direction;
  if (destination < 0 || destination >= chapters.length) return chapters;
  const next = [...chapters];
  [next[index], next[destination]] = [next[destination],next[index]];
  return next;
}
export function mergeChapter(chapters, index) {
  if (!chapters[index + 1]) return chapters;
  const first = chapters[index], second = chapters[index + 1];
  return chapters.flatMap((item,i) => i === index ? [{...first,
    startPage:Math.min(first.startPage,second.startPage),endPage:Math.max(first.endPage,second.endPage),needsReview:true}]
    : i === index + 1 ? [] : [item]);
}
