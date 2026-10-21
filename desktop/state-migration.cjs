const fs=require('node:fs'),path=require('node:path');
const version=3;
function prepare(a){
 const current=a.data.runtime?.executionSchema||1;
 if(current>version)throw Error('工作空间来自较新版本，请使用支持该状态格式的行知助手打开');
 // Pin the complete, unnormalized current file before any startup initializer.
 // Recovery explicitly marks backup data so it can never seed authorization.
 a.authorizationMigration=require('./access-policy-store.cjs').initialize(a,{recovered:!!a.recoveryFromBackup});
 if(current===version)return;
 if(fs.existsSync(a.file)){
  const folder=path.join(a.dir,'protocol-migrations');fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const target=path.join(folder,'before-execution-v3.json');
  if(!fs.existsSync(target)){const fd=fs.openSync(target,'wx',0o600);try{fs.writeFileSync(fd,fs.readFileSync(a.file));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}require('./filesystem-platform.cjs').syncDirectory(folder);}
 }
}
function complete(a){
 a.data.runtime ||= {};
 if(a.authorizationMigration){a.data.runtime.authorizationMigration={status:a.authorizationMigration.status,workspaceHash:a.authorizationMigration.workspaceHash};if(a.authorizationMigration.status==='complete')a.data.runtime.authorizationMigrationComplete=true;}
 if(a.data.runtime.executionSchema===version)return;
 const from=a.data.runtime.executionSchema||1;
 a.data.runtime.executionSchema=version;
 a.data.runtime.executionMigration={from,to:version,at:new Date().toISOString(),appVersion:require('../package.json').version,sourceCount:a.data.sources.length,taskCount:a.data.tasks.length};
}
module.exports={prepare,complete,version};
