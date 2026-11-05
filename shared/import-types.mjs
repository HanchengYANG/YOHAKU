// Import families are detected locally; confirmation chooses the processing path.
export const IMPORT_TYPES = Object.freeze(['photo', 'screenshot', 'text_pdf', 'scan_pdf', 'epub', 'text']);
export const normalizeImportType = (type) => ({pdf_text:'text_pdf',pdf_scan:'scan_pdf',paste:'text'}[type] || type);
const fail = (message) => Object.assign(new Error(message), {status:400, expose:true});
const family = (type) => ['photo','screenshot'].includes(type) ? 'image' : ['text_pdf','scan_pdf'].includes(type) ? 'pdf' : type;

export function guessImportType({name='',mimeType='',head}={}) {
  const bytes = head ? new Uint8Array(head) : new Uint8Array();
  const prefix = new TextDecoder().decode(bytes.slice(0,32));
  const extension = name.toLowerCase().split('.').at(-1);
  const isPdf = prefix.startsWith('%PDF-');
  const isPng = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value);
  const isJpeg = bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  const isWebp = prefix.startsWith('RIFF') && prefix.slice(8,12)==='WEBP';
  const isZip = bytes[0]===80 && bytes[1]===75 && bytes[2]===3 && bytes[3]===4;
  if (isPdf) return 'text_pdf';
  if (isPng || isJpeg || isWebp) return /screenshot|screen.?shot|截图|截屏/i.test(name) ? 'screenshot' : 'photo';
  if (extension==='epub' && isZip) return 'epub';
  if (['pdf','epub','png','jpg','jpeg','webp'].includes(extension) || /^image\//.test(mimeType) || mimeType==='application/pdf')
    throw fail('文件内容与格式不符，请提供原始 PDF、EPUB 或图片文件。');
  if (mimeType.startsWith('text/') || ['txt','md','text'].includes(extension)) {
    try { new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:true}); } catch { throw fail('纯文本文件需要使用 UTF-8 编码。'); }
    if (bytes.includes(0)) throw fail('不支持含二进制内容的文件。');
    return 'text';
  }
  throw fail('请选择 PNG、JPEG、WebP、PDF、EPUB 或 UTF-8 纯文本文件。');
}

export function assertHomogeneousImport(types) {
  if (!Array.isArray(types) || !types.length) throw fail('请先上传文件或粘贴文字。');
  const normalized = types.map(normalizeImportType);
  if (normalized.some(type=>!IMPORT_TYPES.includes(type))) throw fail('文件类型无效。');
  if (new Set(normalized.map(family)).size!==1) throw fail('不支持混合类型导入，请按文件类型分别导入。');
  if (normalized.includes('text_pdf')) return 'text_pdf';
  if (normalized.includes('photo')) return 'photo';
  return normalized[0];
}

export function validateConfirmedType(detected,confirmed) {
  const type=normalizeImportType(confirmed);
  if (!IMPORT_TYPES.includes(type) || family(type)!==family(normalizeImportType(detected)))
    throw fail('确认的类型与原始文件不符，请重新选择。');
  return type;
}

export function validateChapterRanges(chapters,pageCount) {
  if (!Array.isArray(chapters) || !chapters.length || chapters.length>1000)
    throw fail('请先确认章节标题和 PDF 正文范围。');
  const result=chapters.map((chapter,index)=> {
    if (!chapter || typeof chapter.title!=='string' || !chapter.title.trim() || chapter.title.trim().length>160)
      throw fail('章节标题需要填写，最多 160 个字符。');
    if (!Number.isSafeInteger(chapter.startPage) || !Number.isSafeInteger(chapter.endPage) || chapter.startPage<1 || chapter.endPage<chapter.startPage || chapter.endPage>pageCount)
      throw fail('章节范围需要使用 PDF 实际页码，并处于文件页数之内。');
    for(const key of ['startOffset','endOffset'])if(chapter[key]!==undefined&&(!Number.isSafeInteger(chapter[key])||chapter[key]<0))throw fail('章节局部范围需要使用有效的文字位置。');
    if(chapter.startPage===chapter.endPage&&chapter.endOffset!==undefined&&chapter.endOffset<=(chapter.startOffset||0))throw fail('章节局部范围的结束位置需要大于开始位置。');
    return {...(chapter.startOffset!==undefined?{startOffset:chapter.startOffset}:{}),...(chapter.endOffset!==undefined?{endOffset:chapter.endOffset}:{}),id:typeof chapter.id==='string'?chapter.id:`chapter-${index+1}`,title:chapter.title.trim(),startPage:chapter.startPage,endPage:chapter.endPage,excluded:chapter.excluded===true,needsReview:chapter.needsReview===true};
  });
  const active=result.filter(chapter=>!chapter.excluded).sort((a,b)=>a.startPage-b.startPage||(a.startOffset||0)-(b.startOffset||0));
  if (!active.length) throw fail('请至少保留一个正文章节。');
  for(let i=1;i<active.length;i++) if(active[i].startPage<active[i-1].endPage||(active[i].startPage===active[i-1].endPage&&!(active[i-1].endOffset!==undefined&&active[i].startOffset!==undefined&&active[i-1].endOffset<=active[i].startOffset))) throw fail('章节正文范围不能重叠；请修改、合并或排除重叠章节。');
  return result;
}

export function groupParagraphs(text,target=1000) {
  if(typeof text!=='string') throw fail('原文快照需要是文字。');
  const paragraphs=(text.match(/[^\n]*(?:\n+|$)/g)?.filter(Boolean)||[]).flatMap(paragraph=>{
    if(paragraph.length<=1200)return [paragraph];
    const sentences=[];let start=0;
    for(let index=0;index<paragraph.length;index++) {
      if(!/[。！？!?]/u.test(paragraph[index]) && !(paragraph[index]==='.' && /\s|^$/.test(paragraph[index+1]||'')))continue;
      let end=index+1;
      while(end<paragraph.length && /[。！？!?」』）)\]”’\s]/u.test(paragraph[end]))end++;
      sentences.push(paragraph.slice(start,end));start=end;index=end-1;
    }
    if(start<paragraph.length)sentences.push(paragraph.slice(start));
    return sentences.length?sentences:[paragraph];
  });
  const groups=[];
  let current='',start=0;
  for(const paragraph of paragraphs) {
    if(current && current.length+paragraph.length>target) {
      groups.push({text:current,start,end:start+current.length});start+=current.length;current='';
    }
    current+=paragraph;
  }
  if(current) groups.push({text:current,start,end:start+current.length});
  return groups;
}
