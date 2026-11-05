const tokenKeys=['inputTokens','outputTokens','totalTokens','reasoningTokens','cachedInputTokens'];
const count=value=>Number.isSafeInteger(value)&&value>=0;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

// Only provider-reported counters and actual request controls may cross the
// execution boundary. Never retain a raw usage object, response or request.
export function executionUsage(value){
  const result={};if(!object(value))return result;
  if(object(value.usage)){
    const usage=Object.fromEntries(tokenKeys.filter(key=>count(value.usage[key])).map(key=>[key,value.usage[key]]));
    if(Object.keys(usage).length)result.usage=usage;
  }
  if(count(value.maxOutputTokens))result.maxOutputTokens=value.maxOutputTokens;
  if(typeof value.reasoningParameterSent==='boolean')result.reasoningParameterSent=value.reasoningParameterSent;
  if(value.reasoningParameterSent!==false&&typeof value.reasoningEffort==='string'&&/^[a-z][a-z0-9_-]{0,30}$/.test(value.reasoningEffort))result.reasoningEffort=value.reasoningEffort;
  return result;
}

export function usageFromSDK(value){
  if(!object(value))return undefined;
  const raw=object(value.raw)?value.raw:null;
  const usage=raw?{
    inputTokens:raw.prompt_tokens??raw.input_tokens,outputTokens:raw.completion_tokens??raw.output_tokens,totalTokens:raw.total_tokens,
    reasoningTokens:raw.completion_tokens_details?.reasoning_tokens??raw.output_tokens_details?.reasoning_tokens,
    cachedInputTokens:raw.prompt_tokens_details?.cached_tokens??raw.input_tokens_details?.cached_tokens,
  }:{inputTokens:value.inputTokens,outputTokens:value.outputTokens,totalTokens:value.totalTokens,reasoningTokens:value.outputTokenDetails?.reasoningTokens,cachedInputTokens:value.inputTokenDetails?.cacheReadTokens};
  return executionUsage({usage}).usage;
}

export function summarizeExecutionUsage(values){
  const entries=values.map(executionUsage),result={};
  const parameters=entries.findLast(value=>['maxOutputTokens','reasoningParameterSent','reasoningEffort'].some(key=>Object.hasOwn(value,key)));
  if(parameters)for(const key of ['maxOutputTokens','reasoningParameterSent','reasoningEffort'])if(Object.hasOwn(parameters,key))result[key]=parameters[key];
  const usage={};
  for(const key of tokenKeys){
    const counts=entries.map(value=>value.usage?.[key]).filter(count);
    if(counts.length){const total=counts.reduce((sum,value)=>sum+value,0);if(count(total))usage[key]=total;}
  }
  return {...(Object.keys(usage).length?{usage}:{}),...result};
}
