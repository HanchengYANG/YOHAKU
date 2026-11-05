import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import express from 'express';
import {attachReadingObserver} from '../scripts/acceptance-reading-observer.mjs';

async function fixture(t,respond,options={}) {
  assert.equal(typeof attachReadingObserver,'function','the optional acceptance reading observer exists');
  const events=[],control={readingDocumentIds:['allowed']};
  const app=express();app.use(respond);
  const server=createServer(app);
  const detach=attachReadingObserver(server,{control:()=>control,record:event=>events.push(event),...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{detach();await new Promise(resolve=>server.close(resolve));});
  const get=(path,method='GET')=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{'x-private':'never-record-this'}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));
    });req.on('error',reject);req.end();
  });
  return {get,events,control};
}

test('whitelisted empty reading response records only metadata without changing bytes',async t=>{
  const text=' {"pages":[],"currentPage":null,"index":0,"complete":false,"preparation":{"stage":"segment"},"bodyHash":"'+'a'.repeat(64)+'","bodyHtml":"private-body","prompt":"private-prompt"} ';
  const f=await fixture(t,(req,res)=>res.status(200).type('json').end(text));
  const actual=await f.get('/api/documents/allowed/reading-pages?index=0');
  assert.equal(actual.status,200);assert.deepEqual(actual.body,Buffer.from(text));
  assert.equal(f.events.length,1);
  const {at,...event}=f.events[0];assert.ok(Number.isFinite(Date.parse(at)));
  assert.deepEqual(event,{event:'reading_response',documentId:'allowed',method:'GET',status:200,index:0,currentPage:{index:null,ready:null},pagesCount:0,complete:false,progress:{stage:'segment'},bodyHash:'a'.repeat(64)});
  assert.doesNotMatch(JSON.stringify(f.events),/private-body|private-prompt|never-record-this/);
});

test('ready heartbeat response is observed across write and end with its original status and bytes',async t=>{
  const text=JSON.stringify({index:1,currentPage:{index:1,ready:true,bodyHtml:'正文不可记入日志'},pages:[{index:0},{index:1}],complete:true,preparation:{stage:'ready'},bodyHash:'b'.repeat(64)});
  const bytes=Buffer.from(text),f=await fixture(t,(req,res)=>{res.status(201).type('json');res.write(bytes.subarray(0,91));res.end(bytes.subarray(91));});
  const actual=await f.get('/api/documents/allowed/reading-session','POST');
  assert.equal(actual.status,201);assert.deepEqual(actual.body,bytes);
  assert.equal(f.events.length,1);assert.equal(f.events[0].currentPage.ready,true);assert.equal(f.events[0].currentPage.index,1);assert.equal(f.events[0].pagesCount,2);assert.equal(f.events[0].complete,true);
  assert.doesNotMatch(JSON.stringify(f.events),/正文不可记入日志/);
});

test('failed JSON responses record status without error content or invented progress',async t=>{
  const text=JSON.stringify({error:'private-server-error',headers:{authorization:'private-token'}});
  const f=await fixture(t,(req,res)=>res.status(409).type('json').end(text));
  const actual=await f.get('/api/documents/allowed/reading-pages');
  assert.equal(actual.status,409);assert.deepEqual(actual.body,Buffer.from(text));assert.equal(f.events.length,1);
  assert.deepEqual({...f.events[0],at:null},{at:null,event:'reading_response',documentId:'allowed',method:'GET',status:409,index:null,currentPage:{index:null,ready:null},pagesCount:null,complete:null,progress:{stage:null},bodyHash:null});
  assert.doesNotMatch(JSON.stringify(f.events),/private-server-error|private-token|authorization/);
});

test('disabled or nonwhitelisted documents and other method routes are passed through without events',async t=>{
  const text='{"pages":[],"complete":false}',f=await fixture(t,(req,res)=>res.status(200).end(text));
  for(const [path,method] of [['/api/documents/other/reading-pages','GET'],['/api/documents/allowed/reading-pages','POST'],['/api/documents/allowed/reading-session','GET'],['/api/documents/allowed/sources','GET']])assert.deepEqual((await f.get(path,method)).body,Buffer.from(text));
  delete f.control.readingDocumentIds;assert.deepEqual((await f.get('/api/documents/allowed/reading-pages')).body,Buffer.from(text));
  assert.equal(f.events.length,0);
});

test('oversized and invalid JSON responses and observer errors never affect the real HTTP response',async t=>{
  let text='{"index":0,"bodyHtml":"'+'.'.repeat(500)+'"}';
  const f=await fixture(t,(req,res)=>res.status(202).end(text),{maxBytes:128});
  assert.deepEqual((await f.get('/api/documents/allowed/reading-pages')).body,Buffer.from(text));assert.equal(f.events.length,0);
  text='not JSON';assert.deepEqual((await f.get('/api/documents/allowed/reading-pages')).body,Buffer.from(text));assert.equal(f.events.length,0);
  const throwing=await fixture(t,(req,res)=>res.status(200).end('{"index":0}'),{record:()=>{throw new Error('local log unavailable');}});
  assert.deepEqual((await throwing.get('/api/documents/allowed/reading-pages')).body,Buffer.from('{"index":0}'));
});
