let token;
export const desktop = !!window.assistant?.desktop;
export async function call(action, input = {}) {
  if(!['state','stateView','viewDetail','export'].includes(action)&&!window.assistant?.quickCaptureWindow){input={action,input};action='uiCommand';}
  let result;
  if (window.assistant) result = await window.assistant.call(action, input);
  else {
    if (!token) token = (await (await fetch('/api/session')).json()).token;
    const response = await fetch('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Assistant-Token': token }, body: JSON.stringify({ action, input }) });
    result = await response.json();
  }
  if (result.error) throw Object.assign(new Error(result.error), {...(typeof result.code==='string'?{code:result.code}:{}), ...(typeof result.committed==='boolean'?{committed:result.committed}:{})});
  return result.data;
}
export function download(name, content, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
