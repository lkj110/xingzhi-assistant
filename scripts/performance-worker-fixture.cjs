if(!process.env.ASSISTANT_TEST_DATA_DIR||process.env.ASSISTANT_ENGINE_WORKER!=='1')throw Error('Isolated worker profile required');
// The shared bootstrap's legacy stub reads a main-process Assistant. Real-worker
// tests use only the tiny native preference mirror and await durable RPC writes.
require('../desktop/selection-capture.cjs').create=({adapter})=>{
 const status=()=>{const p=adapter.preference();return {selectionEnabled:p.selectionEnabled,screenshotEnabled:p.screenshotEnabled,screenshotRegistered:p.screenshotEnabled,selectionRunning:p.selectionEnabled,screenPermission:'granted',accessibilityTrusted:true,captureError:'',screenshotKey:'⌘ ⇧ 2',captureDiagnostic:{stage:'waiting',events:0,selections:0,reads:0,lastRead:'waiting'}};};
 return {status,reconcile:status,async configure(input){await adapter.configure(input);return status();},dispose(){},resolve(){throw Error('No OS selection in isolated desktop tests');},async screenshot(){throw Error('No OS screenshot in isolated desktop tests');}};
};
require('../desktop/main.cjs');
