import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createSourceService} from '../server/sources.mjs';
import {blocksToHtml,applySentenceBoundaries,bodyText} from '../shared/article-html.mjs';
import {parseText} from '../shared/document.mjs';

function fixture(t){
  const database=new DatabaseSync(':memory:');let fragmentReads=0;
  database.exec('CREATE TABLE documents(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,kind TEXT,orientation TEXT,blocks_json TEXT,plain_text TEXT,body_html TEXT,body_hash TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,source_images_json TEXT,source_image_id TEXT,recognition_json TEXT)');
  const tracked={exec:sql=>database.exec(sql),prepare(sql){const statement=database.prepare(sql);return new Proxy(statement,{get(target,key){const value=target[key];if(typeof value!=='function')return value;return(...args)=>{if(key==='all'&&sql==='SELECT * FROM source_fragments WHERE scope_id=? ORDER BY position')fragmentReads++;return value.apply(target,args);};}});}};
  const service=createSourceService({database:tracked,requireDocument:(user,id)=>{
    const row=database.prepare('SELECT * FROM documents WHERE id=? AND owner_id=?').get(id,user);if(!row)throw Object.assign(new Error('missing'),{status:404});return row;
  },fromRow:row=>({id:row.id,bodyHtml:row.body_html,revision:row.revision})});
  service.stop();
  const text='日本語を読みます。'.repeat(30),bodyHtml=applySentenceBoundaries(blocksToHtml(parseText(text)),text.match(/[^。]*。/g));
  for(let index=0;index<3;index++){
    const id='document-'+index;
    database.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)').run(id,'owner',id,'article','horizontal','[]','',blocksToHtml(parseText('')),'hash',new Date().toISOString(),new Date().toISOString(),'[]',null,null);
    service.createArticleSources('owner',id,Array.from({length:3},(_,source)=>({id:id+'-source-'+source,type:'text',bodyHtml,needsCorrection:false})));
    database.prepare("UPDATE article_sources SET next_step=3,status='pending' WHERE document_id=?").run(id);
    service.heartbeat('owner',id,{index:0});
  }
  t.after(()=>{service.close();database.close();});
  return {database,service,reset:()=>fragmentReads=0,reads:()=>fragmentReads};
}

test('listing preparation tasks loads each source fragment set once per synchronous read',t=>{
  const f=fixture(t);f.reset();
  const first=f.service.taskAdapter.list('owner');assert.equal(first.length,3);
  assert.ok(f.reads()<=9,`expected at most 9 source loads, received ${f.reads()}`);
  f.reset();f.service.taskAdapter.list('owner');
  assert.ok(f.reads()>0,'the next request reads fresh database state');
  assert.ok(f.reads()<=9);
});

test('document hydration reuses source reads but a later manual edit immediately changes reading output',t=>{
  const f=fixture(t);f.reset();
  const before=f.service.hydrateDocument('owner','document-0');
  assert.ok(f.reads()<=3,`expected at most 3 source loads, received ${f.reads()}`);
  const source=f.service.getSource('owner','document-0','document-0-source-0');
  const edited='更新した本文です。'+bodyText(source.bodyHtml);
  f.service.saveSource('owner','document-0',source.id,{version:source.version,text:edited});
  const after=f.service.hydrateDocument('owner','document-0');
  assert.notEqual(after.bodyHash,before.bodyHash);
  assert.ok(bodyText(after.bodyHtml).startsWith('更新した本文です。'));
  assert.ok(after.sources.find(item=>item.id===source.id).bodyHtml.includes('更新した本文です。'));
});
