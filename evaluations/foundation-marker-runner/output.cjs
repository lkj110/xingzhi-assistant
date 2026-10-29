'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
function canonicalOutput(value){
 let existing=path.resolve(value);const suffix=[];
 while(!fs.existsSync(existing)){const parent=path.dirname(existing);assert.notEqual(parent,existing);suffix.unshift(path.basename(existing));existing=parent;}
 assert.ok(fs.statSync(existing).isDirectory());return path.join(fs.realpathSync.native(existing),...suffix);
}
const allowed=path.resolve(__dirname,'../../../foundation-marker-runs-20261029');
function validateOutput(output,base=allowed){
 assert.ok(path.isAbsolute(output)&&!fs.existsSync(output),'Output must be a new absolute path');
 const destination=canonicalOutput(output),safeBase=canonicalOutput(base),relative=path.relative(safeBase,destination);
 assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Output must be a new child of '+allowed);
 // Existing aliases must not relocate the dedicated output root outside its parent.
 const parent=fs.realpathSync.native(path.dirname(base));assert.equal(safeBase,path.join(parent,path.basename(base)),'Output root may not be redirected');
 return destination;
}
module.exports={validateOutput,allowed};
