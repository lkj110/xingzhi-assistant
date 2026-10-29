'use strict';
// Preparation only; creates no user authorization and never contacts a provider.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pack,sha,read,runnerSeal}=require('./identity.cjs');
function prepare(){
 assert.ok(!fs.existsSync(path.join(pack,'runner-review.json')),'An independently reviewed preparation cannot be resealed');
 const files=fs.readdirSync(pack).filter(f=>/\.(json|cjs|md)$/.test(f)&&!['seal.json','runner-seal.json','runner-review.json'].includes(f)).sort().map(file=>({path:file,sha256:sha(fs.readFileSync(path.join(pack,file)))}));
 assert.ok(!files.some(f=>/^author-.*\.cjs$/.test(f.path)),'Remove transient author helper before sealing');
 const seal={schema:1,files,identity:sha(JSON.stringify(files)),liveAuthorized:false,realModelCalls:0};
 fs.writeFileSync(path.join(pack,'seal.json'),JSON.stringify(seal,null,2)+'\n');
 const runner=runnerSeal(seal.identity);fs.writeFileSync(path.join(pack,'runner-seal.json'),JSON.stringify(runner,null,2)+'\n');
 return {sampleIdentity:seal.identity,runnerIdentity:runner.identity,sampleFiles:files.length,dependencies:runner.dependencies.length};
}
module.exports={prepare};if(require.main===module)console.log(JSON.stringify(prepare()));
