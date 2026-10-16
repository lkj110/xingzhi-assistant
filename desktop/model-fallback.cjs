const crypto=require('node:crypto');
const roles=['organize','execute','verify'];
const labels={organize:'信息整理',execute:'事项推进',verify:'结果检查'};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requestConfiguration(p) {
  // Omit new default fields so old saved consent hashes survive this upgrade.
  const fields = [];
  if (p.authMode && p.authMode !== 'auto') fields.push(['auth', p.authMode]);
  if (p.maxOutputTokens) fields.push(['max', p.maxOutputTokens]);
  if (p.tokenParameter && p.tokenParameter !== 'max_tokens') fields.push(['token', p.tokenParameter]);
  if (p.apiVersion) fields.push(['version', p.apiVersion]);
  if (p.workspaceId) fields.push(['workspace', p.workspaceId]);
  if (p.extraBody && Object.keys(p.extraBody).length) fields.push(['extra', p.extraBody]);
  return fields;
}
function configuration(data) {
  return hash({roles:roles.map(role => data.settings?.roles?.[role] || ''), providers:(data.providers || [])
    .map(p => [p.id,p.type,p.baseUrl,p.model,p.reasoning,p.jsonMode,p.sealedKey,p.requestPolicy,...requestConfiguration(p)])
    .sort((a,b) => String(a[0]).localeCompare(String(b[0])))});
}
function empty(){return {version:1,revision:crypto.randomUUID(),roles:Object.fromEntries(roles.map(role=>[role,{enabled:false,providerId:''}]))};}
function revoke(data,reason='configuration'){
  const previous=data.modelFallback,value=empty();
  for(const role of roles){const old=previous?.roles?.[role];value.roles[role]={enabled:false,providerId:data.providers?.some(p=>p.id===old?.providerId)?old.providerId:'',needsSave:!!(old?.enabled||old?.needsSave)};}
  value.reason=reason;value.configuration=configuration(data);data.modelFallback=value;return value;
}
function retain(current,restored){restored.modelFallback=structuredClone(current.modelFallback||empty());revoke(restored,'restore');}
function initialize(a){
  const value=a.data.modelFallback;
  if(!value||value.version!==1||!value.roles||typeof value.revision!=='string'){revoke(a.data,'initial');return;}
  if(value.configuration!==configuration(a.data))revoke(a.data);
  else for(const role of roles){const entry=value.roles[role];if(!entry||typeof entry.enabled!=='boolean'||typeof entry.providerId!=='string'||(entry.enabled&&(!a.data.providers.some(p=>p.id===entry.providerId)||entry.providerId===a.data.settings.roles[role])))revoke(a.data);}
}
function revision(a){return hash({configuration:configuration(a.data),value:a.data.modelFallback});}
function snapshot(a){
  const value=a.data.modelFallback||empty(),valid=value.configuration===configuration(a.data);
  return {revision:revision(a),roles:Object.fromEntries(roles.map(role=>{const row=value.roles[role]||{},primaryId=a.data.settings.roles[role]||'';return [role,{label:labels[role],primaryId,providerId:row.providerId||'',enabled:!!row.enabled&&valid,needsSave:!!row.needsSave||!!row.enabled&&!valid}];})),reason:valid?value.reason:'configuration',providers:a.data.providers.map(p=>({id:p.id,name:p.name,model:p.model,type:p.type})),calls:(a.data.modelCalls||[]).filter(r=>r.attempt===2&&r.fallbackFrom).slice(0,10).map(r=>({id:r.id,at:r.at,role:r.role,providerId:r.providerId,fallbackFrom:r.fallbackFrom,status:r.status,errorCode:r.errorCode,requestId:r.requestId,attempt:r.attempt}))};
}
function selected(a,primary,options){
  if(!roles.includes(options.role)||options.stage==='connection_test'||options.stage==='evaluation'||a.modelBudgetOwner)return null;
  const value=a.data.modelFallback,row=value?.roles?.[options.role];
  if(!row?.enabled||value.configuration!==configuration(a.data)||a.data.settings.roles[options.role]!==primary.id||row.providerId===primary.id)return null;
  return a.data.providers.find(p=>p.id===row.providerId)||null;
}
function changed(a){if(a.data.modelFallback?.configuration!==configuration(a.data))revoke(a.data);}
function dispatch(a,action,input={}){
  if(action==='modelFallbackSnapshot')return snapshot(a);
  if(action!=='modelFallbackSave')throw new Error('未知备用模型操作');
  a.ensureIdle();if(!input||input.revision!==revision(a))throw new Error('模型或备用配置已变化，请刷新后重新选择并保存。');
  if(!input.roles||typeof input.roles!=='object'||Array.isArray(input.roles))throw new Error('请配置三个角色的备用模型');
  const next=empty();next.configuration=configuration(a.data);next.savedAt=new Date().toISOString();
  for(const role of roles){const row=input.roles[role];if(!row||typeof row.enabled!=='boolean'||typeof row.providerId!=='string')throw new Error('备用模型配置无效');
    const primary=a.data.providers.find(p=>p.id===a.data.settings.roles[role]),backup=a.data.providers.find(p=>p.id===row.providerId);
    if(row.providerId&&!backup)throw new Error('所选备用模型不存在');
    if(row.enabled&&(!primary||!backup))throw new Error(`请先为${labels[role]}选择主模型和备用模型`);
    if(row.enabled&&backup.id===primary.id)throw new Error('备用模型必须与主模型使用不同配置');
    next.roles[role]={enabled:row.enabled,providerId:row.providerId,needsSave:false};
  }
  const prior=a.data.modelFallback,events=a.data.events.slice();a.data.modelFallback=next;
  try{a.event('保存备用模型配置',roles.filter(role=>next.roles[role].enabled).map(role=>labels[role]).join('、')||'所有角色均关闭备用接续');a.save();}
  catch(error){a.data.modelFallback=prior;a.data.events=events;throw error;}
  return snapshot(a);
}
module.exports={retain,initialize,snapshot,dispatch,selected,changed,revoke,configuration,revision};
