import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceProcessor, correctionRisk, validateChapterProposal } from '../server/ai/source-processing.mjs';
import { bodyText } from '../shared/article-html.mjs';
import { requiredCapabilities, ROLE_IDS } from '../shared/ai-roles.mjs';

test('校正角色仅需结构化文字能力，独立于图片识别', () => {
  assert.ok(ROLE_IDS.includes('correction'));
  assert.deepEqual(requiredCapabilities('correction'), ['json']);
});

test('来源处理为照片、正文校正、分句及两条注音路径转发状态、取消和分组元数据',async()=>{
  const events=[],onStatus=event=>events.push(event),controller=new AbortController();
  const metadata={onStatus,signal:controller.signal,groupKey:JSON.stringify(['u','article']),getPriority:()=> 'foreground'};
  const check=input=>{for(const key of ['onStatus','signal','groupKey','getPriority'])assert.equal(input[key],metadata[key],key);};
  const processor=createSourceProcessor({
    recognizePhoto:async(_user,_image,options)=>{check(options);options.onStatus({state:'queued',role:'ocr'});return {text:'原文。'};},
    execute:async(_user,role,input)=>{check(input);input.signal.throwIfAborted();input.onStatus({state:'running',role});return {value:role==='correction'?{text:'原文。'}:role==='segmentation'?{sentences:['原文。']}:{blocks:[{words:[{t:'原文',r:'げんぶん'}]}]}};}
  });
  await processor.processSource('u',{source:{type:'photo',original:{imageId:'image'}},step:'extract',...metadata});
  for(const step of ['correct','segment','annotate'])await processor.processSource('u',{step,bodyHtml:'<p>原文。</p>',...metadata});
  assert.deepEqual(events.map(event=>event.role),['ocr','correction','segmentation','annotation']);
  const hybrid=createSourceProcessor({annotateBodies:async(_user,input)=>{check(input);input.onStatus({state:'queued',role:'annotation'});return {items:input.items};}});
  await hybrid.processSource('u',{step:'annotate',bodyHtml:'<p>原文。</p>',...metadata});assert.equal(events.at(-1).state,'queued');
  const cancelled=new DOMException('来源已删除。','AbortError'),before=events.length;controller.abort(cancelled);
  await assert.rejects(processor.processSource('u',{step:'annotate',bodyHtml:'<p>原文。</p>',...metadata}),error=>error===cancelled);
  assert.equal(events.length,before,'取消不能继续进入执行或发布成功状态');
});

test('整句、整段删除与大幅改写必须暂停，少量纠错可以继续', () => {
  assert.equal(correctionRisk('猫。', '').requiresReview, true);
  assert.equal(correctionRisk('一', '  ').requiresReview, true);
  assert.equal(correctionRisk('今日は晴れ。明日は雨。', '今日は晴れ。').requiresReview, true);
  assert.equal(correctionRisk('第一段。\n第二段。', '第一段。').requiresReview, true);
  assert.equal(correctionRisk('長い文章です。', '別の本文でした。').requiresReview, true);
  assert.equal(correctionRisk('今日は晴れです。', '今日は晴です。').requiresReview, false);
  assert.equal(correctionRisk('今日は晴れです。明日は雨です。', '今日は晴です。明日は雨です。').requiresReview, false);
  assert.equal(correctionRisk('今日は晴れです。\n明日は雨です。', '今日は晴です。\n明日は雨です。').requiresReview, false);
  assert.equal(correctionRisk('今日は\n晴れです。\n明日は雨です。', '今日は晴れです。明日は雨です。').requiresReview, false);
});

test('本地提取不进入AI队列；照片首次结果明确为识别与校正', async () => {
  const calls = [];
  const processor = createSourceProcessor({
    execute: async () => assert.fail('本地提取不应调用AI'),
    extractSource: async () => ({ text: '原文。' }),
    recognizePhoto: async () => ({ blocks: [{ id: 'p', segments: [{ text: '写真。', reading: null }] }], execution: { role: 'ocr' } }),
  });
  const text = await processor.processSource('u', { source: { type: 'text' }, step: 'extract' });
  assert.equal(bodyText(text.bodyHtml), '原文。');
  const photo = await processor.processSource('u', { source: { type: 'photo', original: { imageId: 'img' } }, step: 'extract' });
  assert.equal(photo.firstExtractionLabel, 'AI 识别与校正结果');
  assert.equal(photo.skipCorrection, true);
  assert.deepEqual(calls, []);
});

test('超过校正差异比较上限时暂停，不能放行等长大幅改写', () => {
  const before='あ'.repeat(1000)+'い'.repeat(1000)+'。';
  const after='い'.repeat(1000)+'あ'.repeat(1000)+'。';
  assert.equal(correctionRisk(before,after).requiresReview,true);
});

test('成功提取的空白文字PDF原页跳过校正；空白OCR仍需人工录入', async () => {
  const processor=createSourceProcessor({execute:async()=>assert.fail('空白文字PDF无需AI处理')});
  const result=await processor.processSource('u',{source:{type:'text_pdf'},step:'correct',bodyHtml:'<p></p>'});
  assert.equal(bodyText(result.bodyHtml),'');
  await assert.rejects(processor.processSource('u',{source:{type:'scan_pdf'},step:'correct',bodyHtml:'<p></p>'}),/手动录入/);
});

test('校正只写目标正文，相邻上下文不被保存且危险结果保留原文', async () => {
  let input;
  const processor = createSourceProcessor({ execute: async (_u, role, value) => {
    assert.equal(role, 'correction'); input = value;
    return { value: { text: '今日は晴れ。' }, execution: { role } };
  } });
  const original = '<p data-paragraph-id="p">今日は晴れ。明日は雨。</p>';
  const result = await processor.processSource('u', { step: 'correct', bodyHtml: original, context: { before: '前の文。', after: '後の文。' } });
  assert.equal(bodyText(result.bodyHtml), '今日は晴れ。明日は雨。');
  assert.equal(bodyText(result.proposalHtml), '今日は晴れ。');
  assert.equal(result.requiresReview, true);
  assert.match(input.prompt, /前の文/);
});

test('AI分句和注音不能改动正文，并使用相邻上下文', async () => {
  const calls = [];
  const processor = createSourceProcessor({ execute: async (_u, role, input) => {
    calls.push({ role, input });
    return { value: role === 'segmentation' ? { sentences: ['日本語。', 'かな。'] } : { blocks: [{ words: [{ t: '日本語', r: 'にほんご' }] }] } };
  } });
  const split = await processor.processSource('u', { step: 'segment', bodyHtml: '<p>日本語。かな。</p>', context: { after: '次。' } });
  const result = await processor.processSource('u', { step: 'annotate', bodyHtml: split.bodyHtml, context: { before: '前。' } });
  assert.equal(bodyText(result.bodyHtml), '日本語。かな。');
  assert.match(calls[0].input.prompt, /次。/);
  assert.match(calls[1].input.prompt, /前。/);
  const invalid = createSourceProcessor({ execute: async () => ({ value: { sentences: ['変化。'] } }) });
  await assert.rejects(invalid.processSource('u', { step: 'segment', bodyHtml: '<p>原文。</p>' }), /改动|原文/);
});

test('人工删空来源后跳过分句和注音，不重新识别或校正', async () => {
  const processor=createSourceProcessor({execute:async()=>assert.fail('空来源无需AI处理')});
  for(const step of ['segment','annotate']){
    const result=await processor.processSource('u',{step,bodyHtml:'<p data-paragraph-id="p"></p>'});
    assert.equal(bodyText(result.bodyHtml),'');
  }
});

test('分章使用PDF实际页码并拒绝越界，缺少边界证据标为待核对', () => {
  const result = validateChapterProposal({ chapters: [{ title: '第一章', startPage: 3, endPage: 8 }] }, { pageCount: 10 });
  assert.equal(result.chapters[0].needsReview, true);
  assert.throws(() => validateChapterProposal({ chapters: [{ title: '错', startPage: 0, endPage: 4 }] }, { pageCount: 10 }));
  assert.throws(() => validateChapterProposal({ chapters: [{ title: '错', startPage: 3, endPage: 11 }] }, { pageCount: 10 }));
});

test('分章向OCR角色传递全书逐页OCR原文，只返回章节和非正文排除范围',async()=>{
  const pages=[{page:1,text:'封面'},{page:2,text:'页眉\n叙事正文。\n'},{page:3,text:'最后一页正文。'}],before=JSON.stringify(pages);
  const processor=createSourceProcessor({execute:async(_user,role,input)=>{
    assert.equal(role,'ocr');assert.equal(input.document,undefined);assert.equal(input.image,undefined);
    assert.match(input.prompt,/全书/);assert.match(input.prompt,/禁止.*改写|不得.*改写/);assert.match(input.prompt,/叙事/);
    const sent=JSON.parse(input.prompt.split('全书逐页原文：\n')[1]);
    assert.deepEqual(sent.pages.map(({page,lines})=>({page,text:lines.map(line=>line.text).join('\n')})),pages);
    assert.deepEqual(sent.pages[1].lines.map(line=>line.line),[1,2,3]);
    assert.ok(input.schema.required.includes('exclusions'));assert.ok(input.schema.properties.chapters.items.required.includes('excluded'));
    return {value:{chapters:[{title:'封面',startPage:1,endPage:1,excluded:true,needsReview:false},{title:'正文',startPage:2,endPage:3,excluded:false,needsReview:true}],exclusions:[{page:2,startLine:1,endLine:1,reason:'页眉'}]},execution:{role:'ocr'}};
  }});
  const result=await processor.proposeChapters('u',{metadata:{pageCount:3},pages});
  assert.equal(result.chapters[0].excluded,true);assert.deepEqual(result.exclusions,[{page:2,startLine:1,endLine:1,reason:'页眉'}]);assert.equal(result.execution.role,'ocr');assert.equal(JSON.stringify(pages),before);
});

test('分章排除范围严格对应已提供原文的实际页码与闭区间行号',()=>{
  const pages=[{page:1,text:'页眉\n叙事正文。\n页脚'},{page:2,text:'正文继续。'}],metadata={pageCount:2};
  const base={chapters:[{title:'正文',startPage:1,endPage:2,excluded:false,needsReview:true}],exclusions:[]};
  for(const exclusion of [
    {page:0,startLine:1,endLine:1,reason:'错页'},
    {page:3,startLine:1,endLine:1,reason:'越界'},
    {page:1,startLine:0,endLine:1,reason:'错行'},
    {page:1,startLine:2,endLine:1,reason:'倒序'},
    {page:1,startLine:1,endLine:4,reason:'越界'},
    {page:2,startLine:1.5,endLine:2,reason:'小数'},
    {page:1,startLine:1,endLine:1,reason:''},
  ])assert.throws(()=>validateChapterProposal({...base,exclusions:[exclusion]},metadata,pages),/排除|行号|页码/);
  assert.throws(()=>validateChapterProposal({...base,exclusions:[{page:1,startLine:1,endLine:2,reason:'页眉'},{page:1,startLine:2,endLine:3,reason:'页脚'}]},metadata,pages),/重叠/);
  assert.throws(()=>validateChapterProposal({...base,text:'改写后的正文'},metadata,pages),/结构|正文/);
  assert.throws(()=>validateChapterProposal({...base,chapters:[...base.chapters,{title:'重叠章',startPage:2,endPage:2,excluded:false,needsReview:true}]},metadata,pages),/重叠/);
  assert.deepEqual(validateChapterProposal({...base,exclusions:[{page:1,startLine:3,endLine:3,reason:'页脚'}]},metadata,pages).exclusions,[{page:1,startLine:3,endLine:3,reason:'页脚'}]);
});

test('分章拒绝缺页或重复页的全书原文，不静默裁剪后发给LLM',async()=>{
  const processor=createSourceProcessor({execute:async()=>assert.fail('原文不全不能调用AI')});
  for(const pages of [[{page:1,text:'只有一页。'}],[{page:1,text:'重复。'},{page:1,text:'重复。'}],[{page:1,text:'第一页。'},{page:3,text:'越界。'}]]){
    await assert.rejects(processor.proposeChapters('u',{metadata:{pageCount:2},pages}),/全书|逐页|页码/);
  }
});

test('全书分章返回必须显式覆盖首尾和中间每页，不默默排除遗漏页',async()=>{
  const pages=Array.from({length:4},(_,index)=>({page:index+1,text:`第${index+1}页原文。`}));
  for(const ranges of [ [[2,4]], [[1,3]], [[1,1],[3,4]] ]){
    const processor=createSourceProcessor({execute:async()=>({value:{chapters:ranges.map(([startPage,endPage])=>({title:'正文',startPage,endPage,excluded:false,needsReview:true})),exclusions:[]}})});
    await assert.rejects(processor.proposeChapters('u',{metadata:{pageCount:4},pages}),/覆盖|遗漏|缺少/);
  }
  const complete=createSourceProcessor({execute:async()=>({value:{chapters:[
    {title:'封面',startPage:1,endPage:1,excluded:true,needsReview:false},
    {title:'正文',startPage:2,endPage:3,excluded:false,needsReview:true},
    {title:'封底',startPage:4,endPage:4,excluded:true,needsReview:false},
  ],exclusions:[]}})});
  const result=await complete.proposeChapters('u',{metadata:{pageCount:4},pages});
  assert.equal(result.chapters.length,3);assert.equal(result.chapters[0].excluded,true);
});

test('invalid segmentation retains only the expected text, model value and execution for diagnosis',async()=>{
  const value={sentences:['原文。','余分。']},execution={role:'segmentation',providerId:'api_base',model:'deepseek'};
  const processor=createSourceProcessor({execute:async()=>({value,execution,requestHeaders:{authorization:'fixture-secret-never-persist'}})});
  const input={step:'segment',bodyHtml:'<p data-paragraph-id="unchanged">原文。</p>'},before=JSON.stringify(input);
  await assert.rejects(processor.processSource('u',input),error=>{
    assert.match(error.message,/改动|原文/);
    assert.deepEqual(error.result,{kind:'invalid_segmentation',expectedText:'原文。',value,execution});
    assert.equal(JSON.stringify(error.result).includes('fixture-secret-never-persist'),false);
    return true;
  });
  assert.equal(JSON.stringify(input),before);
});

test('来源注音交由混合批次服务处理，正文校正仍由独立角色完成',async()=>{
  const calls=[];
  const processor=createSourceProcessor({
    execute:async(_user,role,input)=>{assert.equal(role,'correction');return {value:{text:'日本語。'},execution:{role}};},
    annotateBodies:async(user,input)=>{
      calls.push({user,input});
      return {items:input.items.map(item=>({...item,bodyHtml:item.bodyHtml,uncertain:[]})),execution:{role:'annotation',annotationMode:'proofread'},metrics:{llmCalls:1}};
    },
  });
  await processor.processSource('owner',{step:'correct',bodyHtml:'<p>日本語。</p>'});
  const result=await processor.processSource('owner',{source:{id:'source-a'},step:'annotate',bodyHtml:'<p>日本語。</p>',context:{before:'前文。',after:'後文。'},priority:'foreground'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].user,'owner');
  assert.equal(calls[0].input.items.length,1);
  assert.equal(bodyText(calls[0].input.items[0].bodyHtml),'日本語。');
  assert.deepEqual(calls[0].input.context,{before:'前文。',after:'後文。'});
  assert.equal(result.execution.annotationMode,'proofread');
  assert.equal(bodyText(result.bodyHtml),'日本語。');
});
