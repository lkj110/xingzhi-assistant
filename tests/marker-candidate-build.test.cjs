'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {assertPaths}=require('../scripts/prepare-marker-candidate.cjs'),work=path.resolve(__dirname,'../..');
function options(){const suffix='test-'+crypto.randomUUID();return {executable:path.join(work,'foundation-candidate-bundle-notice-20261028/XingzhiAssistant.exe'),output:path.join(work,'foundation-candidate-bundle-marker-'+suffix),manifest:path.join(work,'foundation-marker-package-'+suffix,'package-manifest.json')};}
test('candidate builder admits only new isolated sibling outputs',()=>{
 const p=options(),result=assertPaths(p);assert.equal(result.out,p.output);assert.equal(result.evidence,path.dirname(p.manifest));
 assert.throws(()=>assertPaths({...p,output:path.join(work,'foundation-candidate-bundle-notice-20261028')}));
 assert.throws(()=>assertPaths({...p,output:path.join(path.dirname(work),'foundation-candidate-bundle-marker-outside')}),/immediate sibling/);
 assert.throws(()=>assertPaths({...p,manifest:path.join(work,'foundation-offline-audit','package-manifest.json')}));
 assert.throws(()=>assertPaths({...p,output:'relative-output'}),/absolute/);
});
test('candidate builder refuses existing outputs and build evidence without touching bytes',t=>{
 const p=options();fs.mkdirSync(p.output);fs.mkdirSync(path.dirname(p.manifest));
 t.after(()=>{for(const dir of [p.output,path.dirname(p.manifest)]){assert.equal(path.dirname(fs.realpathSync.native(dir)),fs.realpathSync.native(work));fs.rmSync(dir,{recursive:true,force:true});}});
 assert.throws(()=>assertPaths(p),/output must be new/);
 fs.writeFileSync(p.manifest,'frozen evidence');const alternate=options();assert.throws(()=>assertPaths({...alternate,manifest:p.manifest}),/Manifest must be new/);assert.equal(fs.readFileSync(p.manifest,'utf8'),'frozen evidence');
});
