'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const environmentKeys=['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','PATHEXT','TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ'];
function environment(extra=[]){const env={};for(const key of [...environmentKeys,...extra])if(process.env[key])env[key]=process.env[key];return env;}
function runtimeRoot(){return path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'Programs','XingzhiAssistantTools');}
function directories(){const runtime=runtimeRoot();return [...String(process.env.PATH||'').split(path.delimiter),...(process.platform==='win32'?[path.join(runtime,'node'),path.join(runtime,'python'),path.join(runtime,'git','cmd'),path.join(runtime,'npm')]:[]),...(process.platform==='win32'?[path.join(process.env.APPDATA||os.homedir(),'npm'),path.join(process.env.LOCALAPPDATA||os.homedir(),'Microsoft','WinGet','Links')]:['/opt/homebrew/bin','/usr/local/bin','/usr/bin']),path.join(os.homedir(),'.local','bin')].filter(p=>path.isAbsolute(p));}
function executable(name,{dirs=directories(),candidates=[]}={}){
  for(const file of [...candidates,...dirs.flatMap(dir=>process.platform==='win32'?[path.join(dir,name+'.exe'),path.join(dir,name+'.com')]:[path.join(dir,name)])]){
    try{if(fs.statSync(file).isFile()){if(process.platform==='win32'&&/^python[\d.]*$/i.test(name)&&/[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(file))continue;fs.accessSync(file,fs.constants.X_OK);return file;}}catch{}
  }
  return null;
}
function terminate(child,signal='SIGTERM'){
  if(!child||!Number.isSafeInteger(child.pid))return;
  if(process.platform==='win32'){
    if(require('./windows-process.cjs').managed(child)){child.kill(signal);return;}
    // taskkill gets a numeric PID, never user text or a shell command.
    cp.spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:5000});
    try{child.kill(signal);}catch{}
  }else try{process.kill(-child.pid,signal);}catch{try{child.kill(signal);}catch{}}
}
function npmScript(name,dirs=directories()){
 if(process.platform!=='win32'||!/^[a-z0-9_-]+$/i.test(name))return null;
 for(const dir of dirs)try{
  const shim=path.join(dir,name+'.cmd');if(fs.statSync(shim).size>65536)continue;
  const text=fs.readFileSync(shim,'utf8');
  // Inspect the standard npm shim only; never evaluate batch syntax.
  const matches=[...text.matchAll(/"%dp0%[\\/]([^"\r\n]+\.[cm]?js)"/g)];
  if(matches.length!==1)continue;
  const base=fs.realpathSync(path.join(dir,'node_modules')),file=fs.realpathSync(path.resolve(dir,matches[0][1]));
  const relative=path.relative(base,file);if(relative.startsWith('..')||path.isAbsolute(relative)||!fs.statSync(file).isFile())continue;
  return file;
 }catch{}
 return null;
}
module.exports={environment,directories,executable,terminate,npmScript,runtimeRoot};
