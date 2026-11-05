import test from 'node:test';
import assert from 'node:assert/strict';
import {executionUsage,summarizeExecutionUsage,usageFromSDK} from '../server/ai/execution-usage.mjs';

test('execution usage projects only safe integer counters and actual parameter metadata',()=>{
  assert.deepEqual(executionUsage({usage:{inputTokens:0,outputTokens:2,totalTokens:2,reasoningTokens:1,cachedInputTokens:0,raw:{secret:'hidden'},headers:'hidden'},maxOutputTokens:32768,reasoningParameterSent:true,reasoningEffort:'none',prompt:'hidden',authorization:'hidden'}),{usage:{inputTokens:0,outputTokens:2,totalTokens:2,reasoningTokens:1,cachedInputTokens:0},maxOutputTokens:32768,reasoningParameterSent:true,reasoningEffort:'none'});
  for(const invalid of [-1,0.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,'42',null])assert.deepEqual(executionUsage({usage:{inputTokens:invalid},maxOutputTokens:invalid}),{});
  assert.deepEqual(executionUsage({usage:[],reasoningParameterSent:'true',reasoningEffort:'invalid\nsecret'}),{});
});

test('SDK usage keeps missing raw counters unknown instead of SDK synthesized zeros',()=>{
  assert.deepEqual(usageFromSDK({inputTokens:7,outputTokens:0,totalTokens:7,inputTokenDetails:{cacheReadTokens:0},outputTokenDetails:{reasoningTokens:0},raw:{prompt_tokens:7,secret:'hidden'}}),{inputTokens:7});
  assert.deepEqual(usageFromSDK({inputTokens:10,outputTokens:4,totalTokens:14,inputTokenDetails:{cacheReadTokens:3},outputTokenDetails:{reasoningTokens:2}}),{inputTokens:10,outputTokens:4,totalTokens:14,reasoningTokens:2,cachedInputTokens:3});
  assert.equal(usageFromSDK(undefined),undefined);
});

test('multiple execution usage sums reported counters and uses the last actual request parameters',()=>{
  assert.deepEqual(summarizeExecutionUsage([{usage:{inputTokens:10,outputTokens:20,reasoningTokens:15},maxOutputTokens:32768,reasoningParameterSent:true,reasoningEffort:'low'},{usage:{inputTokens:3,outputTokens:4,totalTokens:7},maxOutputTokens:16384,reasoningParameterSent:false}]),{usage:{inputTokens:13,outputTokens:24,totalTokens:7,reasoningTokens:15},maxOutputTokens:16384,reasoningParameterSent:false});
  assert.deepEqual(summarizeExecutionUsage([{usage:{inputTokens:Number.MAX_SAFE_INTEGER}},{usage:{inputTokens:1}}]),{});
  assert.deepEqual(summarizeExecutionUsage([{},null,undefined]),{});
});
