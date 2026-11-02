'use strict';
// Offline-only negative probe; never changes sealed sample/gold files.
const assert=require('node:assert/strict');
function threeParagraphs(text){const at=text.indexOf('\n');assert.ok(at>0&&text[at+1]!=='\n');assert.equal(text.trim().split(/\n\s*\n/u).length,2);return text.slice(0,at)+'\n'+text.slice(at);}
function createFixture(options){
 const inherited=require('../foundation-business-runner/fixture.cjs').createFixture(options);
 return async call=>{
  const result=await inherited(call);
  if(options.fault!=='body-three-paragraphs'||call.context.id!=='F05-jianping-revision'||!call.context.revised)return result;
  if(result.kind==='patch'){assert.equal(result.edits.length,1);result.edits[0].after=threeParagraphs(result.edits[0].after);}
  if(result.groundingReview){const claim=result.groundingReview.claims.find(c=>c.id==='c1');assert.ok(claim);claim.text=threeParagraphs(claim.text);}
  return result;
 };
}
module.exports={createFixture,threeParagraphs};
