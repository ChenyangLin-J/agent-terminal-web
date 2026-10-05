import { mkdir,writeFile,chmod,copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
const root=process.env.CANDIDATE_PREVIEW_ROOT;
const realBackend=process.argv.includes('--real');
const restoreState=process.argv.includes('--restore-state');
const recovery=process.argv.includes('--recovery')||restoreState;
if(realBackend&&recovery) throw new Error('Recovery fixtures require the synthetic backend.');
if(!root||!path.isAbsolute(root))throw new Error('Set an absolute isolated CANDIDATE_PREVIEW_ROOT.');
for(const dir of ['workspace','codex','integrations']) await mkdir(path.join(root,dir),{recursive:true,mode:0o700});
const recoveryThreads = {};
if(recovery){
 const records={};
 for(const [index,profile] of ['desktop','mobile'].entries()){
  const digit=String(index+1), threadId=`${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const turnId=`old-${profile}`, cwd=path.join(root,'workspace'), timestamp=new Date(Date.now()-(restoreState?86400000:3600000)).toISOString();
  const user=`旧会话问题 ${profile}`, answer=`旧会话回复 ${profile}`;
  recoveryThreads[threadId]=[{id:turnId,status:'completed',startedAt:Math.floor(Date.parse(timestamp)/1000)-30,completedAt:Math.floor(Date.parse(timestamp)/1000),items:[{id:`native-user-${profile}`,type:'userMessage',content:[{type:'text',text:user}]},{id:`native-answer-${profile}`,type:'agentMessage',phase:'final_answer',text:answer}]}];
  records[`recovery-${profile}`]={id:`recovery-${profile}`,sessionId:threadId,cwd,title:`旧会话 ${profile}`,transport:'app-server',runtimeKernel:'platform',mode:'resume-id',access:'full',args:['app-server'],released:true,releaseReason:'idle-ttl',startedAt:timestamp,lastActivityAt:timestamp,turnState:{active:false,lastCompletedTurnId:turnId}};
  if(restoreState) Object.assign(records[`recovery-${profile}`],{released:false,releaseReason:'',turnState:{active:false,interrupted:true,turnId:`outdated-${profile}`,requirements:[{id:'stale',text:'旧连接里的中断要求',kind:'original',status:'interrupted'}]}});
  const directory=path.join(root,'codex','sessions','2026','10','05'); await mkdir(directory,{recursive:true});
  const lines=[{type:'session_meta',payload:{id:threadId,cwd,timestamp}},...[["user",user],["assistant",answer]].map(([role,text])=>({timestamp,type:'response_item',payload:{type:'message',role,phase:role==='assistant'?'final_answer':undefined,internal_chat_message_metadata_passthrough:{turn_id:turnId},content:[{type:role==='user'?'input_text':'output_text',text}]}}))];
  await writeFile(path.join(directory,`rollout-${threadId}.jsonl`),lines.map(JSON.stringify).join('\n')+'\n');
 }
 await writeFile(path.join(root,'codex','agent-web-sessions.json'),JSON.stringify(records));
}
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
const threads=new Map(Object.entries(${JSON.stringify(recoveryThreads)}));
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const p=m.params||{};
if(m.method==='initialize')send({id:m.id,result:{userAgent:'synthetic-candidate'}});
else if(['thread/start','thread/resume','thread/fork'].includes(m.method)){const id=p.threadId||crypto.randomUUID();if(!threads.has(id))threads.set(id,[]);send({id:m.id,result:{thread:{id,turns:[]},initialTurnsPage:{data:threads.get(id),nextCursor:null}}});if(${restoreState}&&m.method==='thread/resume'){send({method:'thread/started',params:{thread:{id}}});send({method:'thread/tokenUsage/updated',params:{threadId:id,tokenUsage:{total:{totalTokens:6000},last:{totalTokens:6000},modelContextWindow:258400}}});}}
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
