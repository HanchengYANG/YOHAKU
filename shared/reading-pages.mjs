import { normalizeBodyHtml } from './article-html.mjs';

// Offsets are UTF-16, matching the editor, source ranges and question snapshots.
export function paginateReadingText(text, sentences, {target=1000,min=800,max=1200,complete=true}={}) {
  if (typeof text !== 'string' || !Array.isArray(sentences)) throw new TypeError('正文与分句范围无效。');
  let cursor=0;
  for(const sentence of sentences) {
    if(sentence.start!==cursor || !Number.isInteger(sentence.end) || sentence.end<=cursor || sentence.end>text.length)
      throw new Error('分句必须按顺序逐字覆盖正文。');
    cursor=sentence.end;
  }
  if(cursor!==text.length) throw new Error('分句未覆盖正文。');
  const pages=[]; let start=0,end=0;
  const publish=()=>{if(end>start) pages.push({start,end});start=end;};
  for(let i=0;i<sentences.length;i++) {
    const unit=sentences[i], length=unit.end-unit.start;
    if(length>max) {publish();end=unit.end;publish();continue;}
    const current=end-start, combined=unit.end-start;
    if(current && combined>max) publish();
    else if(current>=min && combined>=min && Math.abs(current-target)<=Math.abs(combined-target)) publish();
    end=unit.end;
    if(end-start>=target && end-start<=max) publish();
  }
  if(complete || end-start>=min) publish();
  return pages;
}

const decode=(text)=>text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(all,value)=>{
  if(value[0]==='#')return String.fromCodePoint(value[1].toLowerCase()==='x'?parseInt(value.slice(2),16):Number(value.slice(1)));
  return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'}[value.toLowerCase()];
});
const escape=(text)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

// Slice the closed, normalized article grammar while retaining marks and ruby.
// No browser DOM or HTML interpolation is needed on the server.
export function sliceReadingHtml(input,start,end) {
  const html=normalizeBodyHtml(input), root={children:[]}, stack=[root];
  for(const token of html.match(/<[^>]*>|[^<]+/g)||[]) {
    if(token.startsWith('</')) {stack.pop();continue;}
    if(token.startsWith('<')) {
      const tag=/^<([a-z]+)/.exec(token)[1],node={tag,open:token,children:[]};
      stack.at(-1).children.push(node);
      if(tag!=='br') stack.push(node);
    } else stack.at(-1).children.push({text:decode(token)});
  }
  const length=(node)=>Object.hasOwn(node,'text')?node.text.length:['rt','rp'].includes(node.tag)?0:node.tag==='br'?1:node.children.reduce((n,c)=>n+length(c),0);
  let offset=0;
  const render=(node)=> {
    if(Object.hasOwn(node,'text')) {
      const from=Math.max(0,start-offset),to=Math.min(node.text.length,end-offset);offset+=node.text.length;
      return to>from?escape(node.text.slice(from,to)):'';
    }
    if(['rt','rp'].includes(node.tag))return '';
    if(node.tag==='br'){const included=offset>=start&&offset<end;offset++;return included?'<br>':'';}
    const begin=offset,size=length(node);
    if(node.tag==='ruby' && begin>=start && begin+size<=end) {
      offset+=size;
      const full=(n)=>Object.hasOwn(n,'text')?escape(n.text):n.tag==='br'?'<br>':n.open+n.children.map(full).join('')+`</${n.tag}>`;
      return full(node);
    }
    const content=node.children.map(render).join('');
    if(!content)return '';
    return node.tag==='ruby'?content:node.open+content+`</${node.tag}>`;
  };
  const paragraphs=[];
  root.children.forEach((paragraph,i)=>{
    const begin=offset,size=length(paragraph),content=render(paragraph);
    const separator=i<root.children.length-1;
    // A selected separator belongs to both adjacent paragraphs. Retain their
    // empty edges too: two empty paragraphs represent a newline-only slice.
    if(end>start&&start<=begin+size&&end>=begin)paragraphs.push(content||paragraph.open+'</p>');
    if(separator)offset++;
  });
  return paragraphs.length?normalizeBodyHtml(paragraphs.join('')):'<p></p>';
}

export function changedTextRange(before,after) {
  let start=0;
  while(start<before.length&&start<after.length&&before[start]===after[start])start++;
  let oldEnd=before.length,newEnd=after.length;
  while(oldEnd>start&&newEnd>start&&before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}
  return {start,oldEnd,newEnd,delta:after.length-before.length};
}
export function remapReadingRanges(pages,{sourceId,paragraphId,before,after}) {
  const change=changedTextRange(before,after);
  const anchor=(offset,isEnd)=>!isEnd&&offset===0?0:offset<change.start?offset:offset>=change.oldEnd?offset+change.delta:isEnd?change.newEnd:change.start;
  return pages.map(page=>({...page,ranges:(page.ranges||[]).map(range=>range.sourceId!==sourceId||(paragraphId&&range.paragraphId!==paragraphId)?{...range}:{...range,start:Math.max(0,anchor(range.start,false)),end:Math.max(0,anchor(range.end,true))})}));
}
