import test from "node:test";
import assert from "node:assert/strict";
import { pageSelection, readingPageLabel, sourceLabel, splitChapter, moveChapter, mergeChapter } from "../client/source-presentation.mjs";
import * as presentation from "../client/source-presentation.mjs";

test("reading selection keeps article offsets and adds page/source scope", () => {
  const result = pageSelection({start:2,end:4,text:"本文"}, {id:"page-2",start:100,sourceIds:["s1","s2"]});
  assert.deepEqual(result, {start:102,end:104,text:"本文",readingPageId:"page-2",sourceIds:["s1","s2"],pageLocalStart:2,pageLocalEnd:4});
});
test("unknown total is never rendered as a guessed reading count", () => {
  assert.equal(readingPageLabel({index:2,complete:false,totalPages:99}), "第 3 页");
  assert.equal(readingPageLabel({index:2,complete:true,totalPages:4}), "第 3 / 4 页");
});
test("chapter edits keep PDF physical page ranges and selected order", () => {
  const original = [{id:"a",title:"一",startPage:2,endPage:8},{id:"b",title:"二",startPage:9,endPage:10}];
  const split = splitChapter(original, 0, 5);
  assert.deepEqual(split.map(({startPage,endPage}) => [startPage,endPage]), [[2,4],[5,8],[9,10]]);
  assert.equal(moveChapter(split, 2, -1)[1].id, "b");
  const merged = mergeChapter(split, 0);
  assert.deepEqual(merged.map(({startPage,endPage}) => [startPage,endPage]), [[2,8],[9,10]]);
  assert.deepEqual(original[0], {id:"a",title:"一",startPage:2,endPage:8});
});
test("photo first result wording does not imply a separate raw OCR", () => {
  assert.equal(sourceLabel({type:"photo",position:0}), "照片 1");
  assert.equal(sourceLabel({type:"text_pdf",preview:{page:12}}), "PDF 原页 12");
});

test("reading diagnostics distinguish queued work from running work and retain the source", () => {
  assert.equal(typeof presentation.readingPreparation, "function");
  const progress = {stage:"correct",percent:null};
  const queued = presentation.readingPreparation({progress,current:{state:"queued",step:"correct",source:{label:"PDF 第27页"},elapsedMs:65000}});
  assert.equal(queued.stageLabel,"等待正文校正");
  assert.equal(queued.statusLabel,"排队中");
  assert.equal(queued.sourceLabel,"PDF 第27页");
  assert.equal(queued.elapsedLabel,"已排队 1 分 05 秒");
  assert.equal(queued.animate,false);
  const running = presentation.readingPreparation({progress,current:{state:"running",step:"annotate_local:0:100",elapsedMs:2500}});
  assert.equal(running.stageLabel,"正在本地注音");
  assert.equal(running.elapsedLabel,"已运行 2 秒");
  assert.equal(running.animate,true);
});

test("failed and review states never look like a still-running preparation step", () => {
  assert.equal(typeof presentation.readingPreparation, "function");
  const failed = presentation.readingPreparation({progress:{stage:"correct"},current:{state:"failed",step:"correct",error:{message:"服务暂时不可用"}}});
  assert.equal(failed.stageLabel,"正文校正失败");
  assert.equal(failed.statusLabel,"已失败");
  assert.equal(failed.busy,false);
  assert.equal(failed.animate,false);
  assert.equal(failed.errorMessage,"服务暂时不可用");
  const review = presentation.readingPreparation({current:{state:"requires_review",step:"correct"}});
  assert.equal(review.statusLabel,"待核对");
  assert.equal(review.busy,false);
  assert.equal(review.animate,false);
  const editing = presentation.readingPreparation({current:{state:"editing",step:"segment"}});
  assert.equal(editing.stageLabel,"等待人工编辑完成");
  assert.equal(editing.busy,false);
});

test("legacy preparation errors pause the old response without inventing an underlying cause", () => {
  assert.equal(typeof presentation.readingPreparation, "function");
  const failed = presentation.readingPreparation({progress:{stage:"correct"},error:"API 调用失败"});
  assert.equal(failed.stageLabel,"正文校正已暂停");
  assert.equal(failed.statusLabel,"已暂停");
  assert.equal(failed.busy,false);
  assert.equal(failed.animate,false);
  const ordinary = presentation.readingPreparation({progress:{stage:"annotate"}});
  assert.equal(ordinary.stageLabel,"正在注音");
  assert.equal(ordinary.statusLabel,"处理中");
});

test("processing durations render fixed elapsed time and omit missing values", () => {
  assert.equal(typeof presentation.processingDuration, "function");
  assert.equal(presentation.processingDuration(0),"0 秒");
  assert.equal(presentation.processingDuration(2500),"2 秒");
  assert.equal(presentation.processingDuration(65000),"1 分 05 秒");
  assert.equal(presentation.processingDuration(undefined),null);
  assert.equal(presentation.processingDuration(-1),null);
});

test("rate-limit backoff is shown as automatic retry waiting without a running animation", () => {
  const waiting = presentation.readingPreparation({current:{state:"retry_wait",step:"correct",retryWaitMs:1500,elapsedMs:200,source:{label:"PDF 第105页"}}});
  assert.equal(waiting.stageLabel,"等待自动重试正文校正");
  assert.equal(waiting.statusLabel,"等待自动重试");
  assert.equal(waiting.busy,true);
  assert.equal(waiting.animate,false);
  assert.equal(waiting.elapsedLabel,"已等待 1 秒");
  assert.equal(waiting.sourceLabel,"PDF 第105页");
});
