const {test}=require('node:test'),assert=require('node:assert/strict');
const {cliFailure}=require('../desktop/subscription.cjs');
for(const [input,code,retry] of [
 [{code:'context_length_exceeded'},'MODEL_CONFIG',false],
 [{message:'maximum context length is 123 tokens PRIVATE'},'MODEL_CONFIG',false],
 [{code:'usage_limit_reached'},'MODEL_QUOTA',false],
 [{message:"You've hit your usage limit PRIVATE"},'MODEL_QUOTA',false],
 [{code:'token_expired'},'MODEL_AUTH',false],
 [{code:'model_not_found'},'MODEL_CONFIG',false],
 [{code:'server_error'},'MODEL_HTTP',true],
 [{code:'rate_limit_exceeded'},'MODEL_HTTP',true],
 [{message:'stream disconnected before completion: error sending request for url (PRIVATE)'},'MODEL_NETWORK',true],
 [{code:'ECONNRESET'},'MODEL_NETWORK',true],
 [{code:'content_policy_violation',message:'stream disconnected before completion: PRIVATE'},'MODEL_BLOCKED',false],
 [{message:'network timeout 503 PRIVATE'},'MODEL_CLI',true],
 [{},'MODEL_CLI',true],
])test(`Subscription failure classification ${JSON.stringify(input)}`,()=>{const e=cliFailure(input);assert.equal(e.code,code);assert.equal(e.automaticRetry,retry);assert.ok(!e.message.includes('PRIVATE'));});
