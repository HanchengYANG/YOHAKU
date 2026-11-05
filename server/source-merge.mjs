import * as body from '../shared/article-html.mjs';

// Merge only ruby into the latest document. Sentence/source/QA marks belong to
// that document, and human or source readings always win over generated ruby.
export function mergeReadings(latest, proposed) {
  if(body.bodyText(latest)!==body.bodyText(proposed))throw new Error('注音与当前正文版本不一致。');
  const ranges=html=>{
    const result=[];let offset=0;
    for(const block of body.htmlToBlocks(html)){
      for(const segment of block.segments){if(segment.reading)result.push({...segment,start:offset,end:offset+segment.text.length});offset+=segment.text.length;}
      offset++;
    }
    return result;
  };
  const protectedRanges=ranges(latest).filter(r=>['manual','source'].includes(r.origin));
  const readings=[...ranges(proposed).filter(r=>!protectedRanges.some(p=>r.start<p.end&&r.end>p.start)),...protectedRanges].sort((a,b)=>a.start-b.start);
  let offset=0;
  const blocks=body.htmlToBlocks(latest).map(block=>{
    const text=block.segments.map(s=>s.text).join(''),end=offset+text.length,segments=[];let cursor=offset;
    for(const range of readings.filter(r=>r.start>=offset&&r.end<=end)){
      if(range.start>cursor)segments.push({text:text.slice(cursor-offset,range.start-offset)});
      segments.push({text:text.slice(range.start-offset,range.end-offset),reading:range.reading,origin:range.origin});cursor=range.end;
    }
    if(cursor<end)segments.push({text:text.slice(cursor-offset)});
    offset=end+1;return {...block,segments};
  });
  return body.syncBodyReadings(latest,blocks);
}
