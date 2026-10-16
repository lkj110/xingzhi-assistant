// The generic UI fixture only replaces Codex discovery. Model calls use each
// scenario's loopback mock server, never the user's subscription or API account.
if(!process.env.ASSISTANT_TEST_DATA_DIR)throw Error('Isolated data required');
const subscription=require('../desktop/subscription.cjs');
subscription.status=async()=>({available:true,loggedIn:true,message:'已使用 ChatGPT 登录，可使用订阅额度',version:'fixture-cli',model:'gpt-6-astra',economical:'gpt-6-luna',models:[{id:'gpt-6-luna',name:'gpt-6-luna'},{id:'gpt-6-astra',name:'gpt-6-astra'}]});
require('../desktop/main.cjs');
