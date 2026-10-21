'use strict';
const fs=require('node:fs'),path=require('node:path');
// Directory junctions exercise Windows reparse-point checks without enabling
// Developer Mode or requiring administrator privileges. File symlinks require
// an OS privilege; report that fixture as skipped instead of changing the OS.
function link(t,target,destination,type){
 if(process.platform==='win32'){
  const resolved=path.resolve(path.dirname(destination),target);
  try{if(type==='dir'||fs.statSync(resolved).isDirectory()){fs.symlinkSync(resolved,destination,'junction');return true;}}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 try{fs.symlinkSync(target,destination,type);return true;}
 catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('File symlink fixture requires Windows Developer Mode or SeCreateSymbolicLinkPrivilege');return false;}throw error;}
}
module.exports={link};
