import test from 'node:test';
import assert from 'node:assert/strict';
import { APICallError, JSONParseError, TypeValidationError, NoObjectGeneratedError } from 'ai';
import { diagnosticForError, sanitizeDiagnostic } from '../server/ai/diagnostics.mjs';

const secret='sk-private-key-and-learning-body';
test('local status and forged SDK names do not masquerade as upstream HTTP errors',()=>{
  const error=Object.assign(new Error(secret),{status:503,name:'AI_APICallError',responseHeaders:{Authorization:secret}});
  assert.deepEqual(diagnosticForError(error),{code:'AI_UNKNOWN_ERROR',category:'unknown',errorType:'Error'});
  const network=Object.assign(new Error(secret),{code:'ENOTFOUND'});
  const call=new APICallError({message:secret,url:`https://example.invalid/${secret}`,requestBodyValues:{secret},cause:network});
  assert.deepEqual(diagnosticForError(call),{code:'AI_NETWORK_ERROR',category:'network',networkCode:'ENOTFOUND',errorType:'Error'});
});

test('SDK cause chains distinguish invalid JSON, schema validation and truncated output',()=>{
  const parse=new JSONParseError({text:secret,cause:new SyntaxError(secret)});
  assert.equal(diagnosticForError(new NoObjectGeneratedError({message:secret,cause:parse,text:secret,response:{},usage:{},finishReason:'stop'})).category,'invalid_json');
  const validation=new TypeValidationError({value:{secret},cause:new Error(secret)});
  assert.equal(diagnosticForError(validation).category,'invalid_response');
  const truncated=new NoObjectGeneratedError({cause:parse,text:secret,response:{},usage:{},finishReason:'length'});
  assert.deepEqual(diagnosticForError(truncated),{code:'AI_INCOMPLETE_OUTPUT',category:'incomplete_output',errorType:'AI_NoObjectGeneratedError',finishReason:'length'});
});

test('safe diagnostic serialization rejects arbitrary names, payloads and nested fields',()=>{
  const input={code:'AI_UNKNOWN_ERROR',category:'unknown',message:secret,stack:secret,url:secret,headers:{Authorization:secret},responseBody:secret,errorType:secret,httpStatus:secret,networkCode:secret,finishReason:secret};
  assert.deepEqual(sanitizeDiagnostic(input),{code:'AI_UNKNOWN_ERROR',category:'unknown'});
  assert.equal(sanitizeDiagnostic({...input,code:secret}),null);
  assert.equal(sanitizeDiagnostic({...input,category:'network'}),null);
  const cycle=new Error(secret);cycle.cause=cycle;
  assert.doesNotMatch(JSON.stringify(diagnosticForError(cycle)),new RegExp(secret));
  assert.deepEqual(diagnosticForError({message:secret}),{code:'AI_UNKNOWN_ERROR',category:'unknown'});
});

test('explicit cancellation with an arbitrary timeout-looking reason stays cancelled',()=>{
  const controller=new AbortController();controller.abort({name:'TimeoutError',message:secret});
  assert.equal(diagnosticForError(new Error(secret),{signal:controller.signal}).category,'cancelled');
});

test('the first combined signal reason wins over a later timeout',()=>{
  const cancelled=new AbortController(),timeout=new AbortController();
  const combined=AbortSignal.any([cancelled.signal,timeout.signal]);
  cancelled.abort();timeout.abort(new DOMException(secret,'TimeoutError'));
  assert.equal(diagnosticForError(new Error(secret),{signal:combined,timeoutSignal:timeout.signal}).category,'cancelled');
  assert.equal(diagnosticForError(new Error(secret),{timeoutSignal:timeout.signal}).category,'timeout');
});

test('concrete transport causes take precedence over generic SDK output failure',()=>{
  const http=new APICallError({message:secret,url:'https://example.invalid',requestBodyValues:{},statusCode:503});
  const network=Object.assign(new Error(secret),{code:'ECONNRESET'});
  const wrapper=cause=>new NoObjectGeneratedError({message:secret,cause,text:secret,response:{},usage:{},finishReason:'error'});
  assert.equal(diagnosticForError(wrapper(http)).category,'upstream_http');
  assert.equal(diagnosticForError(wrapper(network)).category,'network');
});
