import { mkdir,writeFile,chmod,copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
const root=process.env.CANDIDATE_PREVIEW_ROOT;
const realBackend=process.argv.includes('--real');
if(!root||!path.isAbsolute(root))throw new Error('Set an absolute isolated CANDIDATE_PREVIEW_ROOT.');
for(const dir of ['workspace','codex','integrations']) await mkdir(path.join(root,dir),{recursive:true,mode:0o700});
if(realBackend){
 const authSource=process.env.AGENT_PREVIEW_AUTH_SOURCE||path.join(os.homedir(),'.codex','auth.json');
 await copyFile(authSource,path.join(root,'codex','auth.json'));
 await chmod(path.join(root,'codex','auth.json'),0o600);
 await writeFile(path.join(root,'codex','config.toml'),'cli_auth_credentials_store = "file"\n',{mode:0o600});
 console.log('Real Codex backend; isolated Session state and workspace; loopback-only preview.');
}
const fake=path.join(root,'fake-codex.cjs');
if(!realBackend){
await writeFile(fake,`#!/usr/bin/env node
const readline=require('node:readline'); const crypto=require('node:crypto'); const send=v=>process.stdout.write(JSON.stringify(v)+'\\n'); let n=0;
const threads=new Map();
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const p=m.params||{};
if(m.method==='initialize')send({id:m.id,result:{userAgent:'synthetic-candidate'}});
else if(['thread/start','thread/resume','thread/fork'].includes(m.method)){const id=p.threadId||crypto.randomUUID();threads.set(id,[]);send({id:m.id,result:{thread:{id,turns:[]},initialTurnsPage:{data:[],nextCursor:null}}});}
else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',displayName:'GPT 6.1',isDefault:true,defaultReasoningEffort:'xhigh',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'},{reasoningEffort:'xhigh'}]},{id:'codex',model:'codex',displayName:'Codex',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}]}});
else if(m.method==='config/read')send({id:m.id,result:{config:{model:'gpt-6.1-sol',model_reasoning_effort:'xhigh'}}});
else if(m.method==='thread/list'||m.method==='thread/turns/list')send({id:m.id,result:{data:[],nextCursor:null}});
else if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt',email:'synthetic@example.invalid'},requiresOpenaiAuth:false}});
else if(m.method==='account/rateLimits/read')send({id:m.id,result:{rateLimits:null}});
else if(m.method==='turn/start'){const id=crypto.randomUUID(); const threadId=p.threadId;
send({id:m.id,result:{turn:{id,status:'inProgress',items:[]}}});
setTimeout(()=>send({method:'turn/started',params:{threadId,turn:{id,status:'inProgress'}}}),10);
setTimeout(()=>send({method:'thread/tokenUsage/updated',params:{threadId,turnId:id,tokenUsage:{total:{totalTokens:6000,inputTokens:5000,outputTokens:1000},last:{totalTokens:6000,inputTokens:5000,outputTokens:1000},modelContextWindow:258400}}}),100);
setTimeout(()=>send({method:'item/completed',params:{threadId,turnId:id,item:{id:'user-'+id,type:'userMessage',content:p.input||[]}}}),30);
setTimeout(()=>send({method:'item/completed',params:{threadId,turnId:id,item:{id:'comment-'+id,type:'agentMessage',phase:'commentary',text:'正在检查附件预览和输入布局。'}}}),250);
setTimeout(()=>send({method:'item/completed',params:{threadId,turnId:id,item:{id:'cmd-'+id,type:'commandExecution',command:'node inspect.js',status:'completed',aggregatedOutput:Array.from({length:90},(_,i)=>'输出 '+(i+1)+': 合成验收数据').join('\\n')}}}),550);
setTimeout(()=>{send({method:'item/completed',params:{threadId,turnId:id,item:{id:'final-'+id,type:'agentMessage',phase:'final_answer',text:'已检查布局。\\n\\n'+Array.from({length:25},(_,i)=>'第 '+(i+1)+' 段：这是完整展开的最终回复，用于确认正文没有内部滚动条。').join('\\n\\n')}}});send({method:'turn/completed',params:{threadId,turn:{id,status:'completed'}}});},7500);
}else if(m.id!==undefined)send({id:m.id,result:{}});
});
`);await chmod(fake,0o755);
}
const auth=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"authenticated":true}');});
await new Promise(resolve=>auth.listen(0,'127.0.0.1',resolve));
const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'../..'),env:{...process.env,HOST:'127.0.0.1',PORT:process.env.AGENT_PREVIEW_PORT||'0',WORKSPACE_ROOT:path.join(root,'workspace'),CODEX_HOME:path.join(root,'codex'),AGENT_MEMORY_SYSTEM_ROOT:process.env.AGENT_MEMORY_SYSTEM_ROOT,AGENT_INTEGRATIONS_DIR:path.join(root,'integrations'),AGENT_SESSION_FAVORITES_FILE:path.join(root,'favorites.json'),AGENT_SESSION_SHARES_FILE:path.join(root,'shares.json'),CODEX_UPDATE_NOTICES_FILE:path.join(root,'notices.json'),PRIVATE_AUTH_VERIFY_URL:'http://127.0.0.1:'+auth.address().port,CODEX_APP_SERVER_COMMAND:realBackend?(process.env.CODEX_APP_SERVER_COMMAND||'codex'):fake,AGENT_NATIVE_THREAD_CATALOG:realBackend?'1':'0',AGENT_RUNTIME_KERNEL:'legacy',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on('exit',code=>{auth.close();process.exit(code||0);});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
