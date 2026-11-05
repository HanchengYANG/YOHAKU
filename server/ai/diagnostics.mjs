import {
  APICallError, StreamProviderError, JSONParseError, TypeValidationError,
  InvalidResponseDataError, EmptyResponseBodyError, NoObjectGeneratedError,
  NoOutputGeneratedError, NoContentGeneratedError,
} from 'ai';

const categories = Object.freeze({
  AI_TIMEOUT:'timeout', AI_CANCELLED:'cancelled', AI_AUTH_ERROR:'auth',
  AI_AUTH_REQUIRED:'auth', AI_ROLE_NOT_READY:'configuration', AI_RATE_LIMIT:'rate_limit',
  AI_UPSTREAM_HTTP:'upstream_http', AI_NETWORK_ERROR:'network',
  AI_INVALID_JSON:'invalid_json', AI_INVALID_RESPONSE:'invalid_response',
  AI_INCOMPLETE_OUTPUT:'incomplete_output', AI_UNKNOWN_ERROR:'unknown',
});
const networkCodes = new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','EPIPE','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
const finishReasons = new Set(['stop','length','content-filter','tool-calls','error','other','unknown']);
const sdkTypes = [APICallError, StreamProviderError, JSONParseError, TypeValidationError,
  InvalidResponseDataError, EmptyResponseBodyError, NoObjectGeneratedError,
  NoOutputGeneratedError, NoContentGeneratedError];
const errorTypes = new Set(['Error','TypeError','SyntaxError','AbortError','TimeoutError',...sdkTypes.map(type => `AI_${type.name}`)]);
const diagnostic = (code, details = {}) => ({code,category:categories[code],...details});
const nativeType = error => error instanceof TypeError ? { errorType: 'TypeError' }
  : error instanceof Error ? { errorType: 'Error' } : {};

// Deliberately never copy messages, URLs, headers, response data or stacks.
// SDK errors commonly include credentials and the complete learning material.
export function sanitizeDiagnostic(input) {
  if(!input || typeof input!=='object' || !Object.hasOwn(categories,input.code) || categories[input.code]!==input.category)return null;
  const result=diagnostic(input.code);
  if(errorTypes.has(input.errorType))result.errorType=input.errorType;
  if(Number.isInteger(input.httpStatus)&&input.httpStatus>=100&&input.httpStatus<=599)result.httpStatus=input.httpStatus;
  if(networkCodes.has(input.networkCode))result.networkCode=input.networkCode;
  if(finishReasons.has(input.finishReason))result.finishReason=input.finishReason;
  return result;
}

export function diagnosticForError(error,{signal,timeoutSignal}={}) {
  const chain=[],seen=new Set();let current=error;
  while(current&&typeof current==='object'&&!seen.has(current)&&chain.length<12){chain.push(current);seen.add(current);current=current.cause;}
  const saved=sanitizeDiagnostic(error?.diagnostic);
  if(saved)return saved;
  // AbortSignal.any preserves the first reason; a later timeout cannot turn a
  // caller cancellation into a timeout while the rejected request unwinds.
  const aborted=signal?.aborted?signal:!signal&&timeoutSignal?.aborted?timeoutSignal:null;
  if(aborted)return aborted.reason instanceof DOMException&&aborted.reason.name==='TimeoutError'
    ?diagnostic('AI_TIMEOUT',{errorType:'TimeoutError'}):diagnostic('AI_CANCELLED',{errorType:'AbortError'});
  for(const cause of chain){
    if(cause.code==='AI_AUTH_REQUIRED'||cause.code==='AI_ROLE_NOT_READY')return diagnostic(cause.code);
    if(cause instanceof DOMException && cause.name==='TimeoutError')return diagnostic('AI_TIMEOUT',{errorType:'TimeoutError'});
    if(cause instanceof DOMException && cause.name==='AbortError')return diagnostic('AI_CANCELLED',{errorType:'AbortError'});
  }
  const http=chain.find(cause=>(APICallError.isInstance(cause)||StreamProviderError.isInstance(cause))&&Number.isInteger(cause.statusCode)&&cause.statusCode>=400&&cause.statusCode<=599);
  if(http){
    const code=[401,403].includes(http.statusCode)?'AI_AUTH_ERROR':http.statusCode===429?'AI_RATE_LIMIT':'AI_UPSTREAM_HTTP';
    return diagnostic(code,{httpStatus:http.statusCode,errorType:APICallError.isInstance(http)?'AI_APICallError':'AI_StreamProviderError'});
  }
  const transport=chain.find(cause=>networkCodes.has(cause.code));
  if(transport)return diagnostic('AI_NETWORK_ERROR',{networkCode:transport.code,...nativeType(transport)});
  const incomplete=chain.find(cause=>NoObjectGeneratedError.isInstance(cause)&&finishReasons.has(cause.finishReason)&&cause.finishReason!=='stop');
  if(incomplete)return diagnostic('AI_INCOMPLETE_OUTPUT',{errorType:'AI_NoObjectGeneratedError',finishReason:incomplete.finishReason});
  const invalidJson=chain.find(cause=>JSONParseError.isInstance(cause)||cause instanceof SyntaxError);
  if(invalidJson)return diagnostic('AI_INVALID_JSON',{errorType:JSONParseError.isInstance(invalidJson)?'AI_JSONParseError':'SyntaxError'});
  for(const type of [TypeValidationError,InvalidResponseDataError,EmptyResponseBodyError,NoObjectGeneratedError,NoOutputGeneratedError,NoContentGeneratedError]){
    if(chain.some(cause=>type.isInstance(cause)))return diagnostic('AI_INVALID_RESPONSE',{errorType:`AI_${type.name}`});
  }
  return diagnostic('AI_UNKNOWN_ERROR',nativeType(error));
}
