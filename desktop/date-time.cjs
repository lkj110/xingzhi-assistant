// Accept explicit instants at input boundaries; Date.parse alone rolls an
// impossible date such as February 30 into March and accepts local wall times.
function optionalISO(value,label='日期时间') {
  if(value===null||value===undefined||value==='')return null;
  const error=()=>new Error(`${label}须为有效且带时区的 ISO 日期时间（Z 或 ±HH:mm），不设置时留空`);
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value))throw error();
  const wall=value.slice(0,16),naive=Date.parse(wall+'Z'),at=Date.parse(value);
  if(!Number.isFinite(naive)||new Date(naive).toISOString().slice(0,16)!==wall||!Number.isFinite(at))throw error();
  const iso=new Date(at).toISOString();
  if(!/^\d{4}-/.test(iso))throw error();
  return iso;
}
function optionalDate(value,label='日期') {
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error(`${label}须为有效日期`);
  const at=Date.parse(value+'T00:00:00Z');
  if(!Number.isFinite(at)||new Date(at).toISOString().slice(0,10)!==value)throw Error(`${label}须为有效日期`);
  return value;
}
function optionalTimeZone(value) {
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string')throw Error('时区无效');
  try{return new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone;}catch{throw Error('时区无效');}
}
// Explicit offset selects a repeated wall time. A nonexistent local time or an
// offset inconsistent with the named zone is rejected rather than shifted.
function assertOffsetInZone(value,timeZone) {
  const instant=optionalISO(value),zone=optionalTimeZone(timeZone);
  if(!instant||!zone)return;
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  if(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`!==value.slice(0,16))throw Error('截止时刻与指定时区不一致，请明确选择有效时刻和偏移');
}
module.exports={optionalISO,optionalDate,optionalTimeZone,assertOffsetInZone};
