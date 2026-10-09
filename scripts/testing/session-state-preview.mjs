import {mkdir,writeFile,chmod,appendFile} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
const root=process.env.CANDIDATE_PREVIEW_ROOT;
const performanceFixture=process.env.STATE_PERFORMANCE_FIXTURE==='1';
if(!root||!path.isAbsolute(root))throw new Error('An isolated absolute CANDIDATE_PREVIEW_ROOT is required.');
const workspace=path.join(root,'workspace'),codex=path.join(root,'codex'),commands=path.join(root,'commands.jsonl');
await mkdir(workspace,{recursive:true});await mkdir(codex,{recursive:true});await writeFile(commands,'');
const threads={};const records={};
for(const [index,profile]of ['desktop','mobile'].entries()){
 const d=String(index+1),id=`${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
 const timestamp='2026-10-09T00:00:00Z',turnId=performanceFixture?`${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-9${d.repeat(3)}-${d.repeat(12)}`:`old-${profile}`;
 threads[id]=[{id:turnId,status:'completed',items:[{id:`old-user-${profile}`,type:'userMessage',content:[{type:'text',text:`历史问题 ${profile}`}]},{id:`old-answer-${profile}`,type:'agentMessage',phase:'final_answer',text:`历史答复 ${profile}`}]}];
 if(performanceFixture)threads[id][0].items.splice(1,0,...Array.from({length:315},(_,i)=>({id:`command-${i}`,type:'commandExecution',command:`echo fixture-${i}`,cwd:workspace,status:'completed',aggregatedOutput:'synthetic output '.repeat(1000),exitCode:0})));
 records[`old-${profile}`]={id:`old-${profile}`,sessionId:id,cwd:workspace,title:`状态验收 ${profile}`,transport:'app-server',runtimeKernel:'platform',mode:'resume-id',access:'full',args:['app-server'],released:true,releaseReason:'idle-ttl',startedAt:timestamp,lastActivityAt:timestamp,turnState:{active:false,lastCompletedTurnId:turnId}};
 const dir=path.join(codex,'sessions','2026','10','09');await mkdir(dir,{recursive:true});
 const rows=[{type:'session_meta',payload:{id,cwd:workspace,timestamp}},...threads[id][0].items.flatMap(item=>item.type==='commandExecution'?[{timestamp,type:'response_item',payload:{type:'function_call',id:item.id,name:'exec_command',call_id:item.id,arguments:JSON.stringify({cmd:item.command,workdir:workspace}),internal_chat_message_metadata_passthrough:{turn_id:turnId}}},{timestamp,type:'response_item',payload:{type:'function_call_output',call_id:item.id,output:item.aggregatedOutput,internal_chat_message_metadata_passthrough:{turn_id:turnId}}}]:[{timestamp,type:'response_item',payload:{type:'message',role:item.type==='userMessage'?'user':'assistant',phase:item.phase,internal_chat_message_metadata_passthrough:{turn_id:turnId},content:[{type:item.type==='userMessage'?'input_text':'output_text',text:item.text||item.content[0].text}]}}])];
 await writeFile(path.join(dir,`rollout-${id}.jsonl`),rows.map(JSON.stringify).join('\n')+'\n');
}
await writeFile(path.join(codex,'agent-web-sessions.json'),JSON.stringify(records));
const fake=path.join(root,'fake-codex.cjs');
await writeFile(fake,`#!/usr/bin/env node
const fs=require('node:fs'),crypto=require('node:crypto'),readline=require('node:readline');
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n'),threads=new Map(Object.entries(${JSON.stringify(threads)})),attached=new Set(),timers=new Map();let offset=0;
function complete(threadId,turn){if(turn.status!=='inProgress')return;clearTimeout(timers.get(turn.id));turn.status='completed';const item={id:'answer-'+turn.id,type:'agentMessage',phase:'final_answer',text:'已完成 '+turn.id};turn.items.push(item);send({method:'item/completed',params:{threadId,turnId:turn.id,item}});send({method:'turn/completed',params:{threadId,turn}});}
function start(threadId,input){const turn={id:crypto.randomUUID(),status:'inProgress',startedAt:Math.floor(Date.now()/1000),items:[]};threads.get(threadId).push(turn);send({method:'turn/started',params:{threadId,turn}});const user={id:'user-'+turn.id,type:'userMessage',content:input};turn.items.push(user);send({method:'item/completed',params:{threadId,turnId:turn.id,item:user}});timers.set(turn.id,setTimeout(()=>complete(threadId,turn),5000));return turn;}
setInterval(()=>{const rows=fs.readFileSync(${JSON.stringify(commands)},'utf8').trim().split('\\n').filter(Boolean);for(const row of rows.slice(offset)){const c=JSON.parse(row);if(c.type==='external'&&attached.has(c.threadId))start(c.threadId,[{type:'text',text:c.text}]);}offset=rows.length;},100).unref();
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),p=m.params||{};
if(m.method==='initialize')send({id:m.id,result:{userAgent:'state-fixture'}});
else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'fixture',model:'fixture',displayName:'Fixture',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]}});
else if(m.method==='config/read')setTimeout(()=>send({id:m.id,result:{config:{model:'fixture',model_reasoning_effort:'medium'}}}),${performanceFixture?2000:0});
else if(m.method==='thread/start'){const id=crypto.randomUUID();threads.set(id,[]);attached.add(id);send({id:m.id,result:{thread:{id,turns:[]}}});}
else if(m.method==='thread/resume'){attached.add(p.threadId);if(!threads.has(p.threadId))threads.set(p.threadId,[]);send({id:m.id,result:{thread:{id:p.threadId,turns:threads.get(p.threadId)},initialTurnsPage:{data:threads.get(p.threadId),nextCursor:null}}});}
else if(m.method==='thread/read')send({id:m.id,result:{thread:{id:p.threadId,turns:threads.get(p.threadId)||[]}}});
else if(m.method==='thread/unsubscribe'){attached.delete(p.threadId);send({id:m.id,result:{}});}
else if(m.method==='turn/start'){const text=(p.input||[]).map(i=>i.text||'').join('');if(text.includes('启动失败'))send({id:m.id,error:{code:-32000,message:'合成启动失败'}});else{setTimeout(()=>{const turn=start(p.threadId,p.input||[]);setTimeout(()=>send({id:m.id,result:{turn:{...turn,items:[]}}}),500);},1800);}}
else if(m.method==='turn/steer'){const turn=threads.get(p.threadId)?.find(t=>t.id===p.expectedTurnId)||threads.get(p.threadId)?.at(-1);const item={id:'steer-'+crypto.randomUUID(),type:'userMessage',content:p.input||[]};turn.items.push(item);send({method:'item/completed',params:{threadId:p.threadId,turnId:turn.id,item}});complete(p.threadId,turn);setTimeout(()=>send({id:m.id,result:{turnId:turn.id}}),1200);}
else if(m.method==='turn/interrupt'){const turn=threads.get(p.threadId)?.at(-1);if(turn)complete(p.threadId,turn);send({id:m.id,result:{}});}
else if(m.id!==undefined)send({id:m.id,result:{}});
});
`);await chmod(fake,0o755);
const auth=http.createServer((_,res)=>{res.setHeader('content-type','application/json');res.end('{"authenticated":true}');});await new Promise(r=>auth.listen(0,'127.0.0.1',r));
const control=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;await appendFile(commands,JSON.stringify(JSON.parse(data))+'\n');res.end('{}');});await new Promise(r=>control.listen(Number(process.env.STATE_CONTROL_PORT||4310),'127.0.0.1',r));
const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(import.meta.dirname,'../..'),env:{...process.env,HOST:'127.0.0.1',PORT:process.env.AGENT_PREVIEW_PORT||'4309',WORKSPACE_ROOT:workspace,CODEX_HOME:codex,CODEX_APP_SERVER_COMMAND:fake,AGENT_NATIVE_THREAD_CATALOG:'0',AGENT_PLATFORM_KERNEL:'new',AGENT_INTEGRATIONS_DIR:path.join(root,'integrations'),AGENT_SESSION_FAVORITES_FILE:path.join(root,'favorites.json'),AGENT_SESSION_SHARES_FILE:path.join(root,'shares.json'),CODEX_UPDATE_NOTICES_FILE:path.join(root,'notices.json'),PRIVATE_AUTH_VERIFY_URL:'http://127.0.0.1:'+auth.address().port,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on('exit',code=>{auth.close();control.close();process.exit(code||0);});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
