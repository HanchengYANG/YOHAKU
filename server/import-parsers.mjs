import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeImportType } from '../shared/import-types.mjs';
const script=fileURLToPath(new URL('../scripts/document-extract.py',import.meta.url));
const configuredPython=()=>process.env.DOCUMENT_PYTHON || [
  fileURLToPath(new URL('../.venv-documents/bin/python',import.meta.url)),
  process.env.NDLOCR_PYTHON,
  fileURLToPath(new URL('../.venv-ndlocr/bin/python',import.meta.url)),
].find(value=>value && existsSync(value)) || 'python3';
const fail=(status,message)=>Object.assign(new Error(message),{status,expose:true});

function runParser(operation,filePath,{page,output,signal}={}) {
  return new Promise((resolve,reject)=>{
    const args=[script,operation,filePath];
    if(page!==undefined) args.push('--page',String(page));
    if(output) args.push('--output',output);
    const process=spawn(configuredPython(),args,{stdio:['ignore','pipe','pipe'],signal});
    let stdout='',stderr='',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const timer=setTimeout(()=>{process.kill('SIGTERM');finish(fail(504,'本地文件解析超时，请重试或按章节拆分。'));},120000);
    process.stdout.setEncoding('utf8');process.stderr.setEncoding('utf8');
    process.stdout.on('data',chunk=>{
      stdout+=chunk;
      if(Buffer.byteLength(stdout)>40*1024*1024){process.kill('SIGTERM');finish(fail(413,'提取内容过大，请拆分文件后导入。'));}
    });
    process.stderr.on('data',chunk=>{if(stderr.length<4000)stderr+=chunk;});
    process.on('error',()=>finish(fail(503,'本地文件解析环境不可用，请运行 scripts/install-document-runtime.sh。')));
    process.on('exit',code=>{
      let result;try{result=JSON.parse(stdout);}catch{finish(fail(502,'本地文件解析未返回有效结果，请检查解析环境。'));return;}
      if(code!==0 || result.error) finish(fail(422,result.error || '本地文件提取失败，请对照来源人工录入。'));
      else finish(null,result);
    });
  });
}

export async function inspectImportFile({filePath,type,signal}) {
  type=normalizeImportType(type);
  if(type==='text_pdf'||type==='scan_pdf') return runParser('inspect-pdf',filePath,{signal});
  if(type==='epub') return runParser('inspect-epub',filePath,{signal});
  if(type==='text') {
    const bytes=await readFile(filePath);let text;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw fail(422,'纯文本文件需要使用 UTF-8 编码。');}
    if(text.includes('\0'))throw fail(422,'纯文本文件包含二进制内容。');
    return {detectedType:'text',text};
  }
  return {detectedType:type};
}

export async function extractImportedSource(source,{signal}={}) {
  const type=normalizeImportType(source.type),original=source.original||{};
  if(type==='text_pdf') return runParser('extract-pdf',original.filePath,{page:original.page,signal});
  if(type==='epub') return {text:original.snapshot||'',bodyHtml:original.html,firstExtractionLabel:'EPUB 首次提取结果'};
  if(type==='text') return {text:original.snapshot||'',firstExtractionLabel:'首次提取结果'};
  throw fail(400,'该来源需要先执行图片识别或本地 OCR。');
}

export async function renderImportedSource(source,{signal}={}) {
  const original=source.original||{},type=normalizeImportType(source.type);
  if(type==='screenshot'||type==='photo') return {path:original.filePath,cleanup:async()=>{}};
  if(type!=='scan_pdf'&&type!=='text_pdf') throw fail(400,'这个来源没有可渲染的 PDF 原页。');
  const directory=await mkdtemp(join(tmpdir(),'yohaku-source-page-'));
  const path=join(directory,'source.png'),cleanup=()=>rm(directory,{recursive:true,force:true});
  try{await runParser('render-pdf',original.filePath,{page:original.page,output:path,signal});return {path,cleanup};}
  catch(error){await cleanup();throw error;}
}
