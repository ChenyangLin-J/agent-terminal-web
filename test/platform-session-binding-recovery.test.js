import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentWebSessionAdapter } from '../public/platform-agent-web-adapter.js';
const {createSessionHostController}=await import(process.env.AGENT_PLATFORM_CANDIDATE ? pathToFileURL(path.join(process.env.AGENT_PLATFORM_CANDIDATE,'src/session-host.js')).href : '@agent-workbench/platform/session-host');
class Socket extends EventTarget {
 static values=[];readyState=0;
 constructor(url){super();this.url=url;Socket.values.push(this);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
 close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}
test('released selected attachment follows the same native thread to a new transport and reconciles external messages',async t=>{
 const original=Object.fromEntries(['fetch','WebSocket','location','sessionStorage'].map(key=>[key,globalThis[key]]));
 const store=new Map();globalThis.sessionStorage={getItem:key=>store.get(key),setItem:(key,value)=>store.set(key,value)};globalThis.WebSocket=Socket;globalThis.location={protocol:'http:',host:'fixture.invalid'};
 let live=false;const requests=[];const native='native-thread';
 const old={id:'old-web',sessionId:native,title:'Task',released:true,ready:true,lastActivityAt:'2026-10-09T07:00:00Z',sessionRevision:20,turnState:{active:false,turnId:'old-turn'}};
 const next={...old,id:'new-web',released:false,lastActivityAt:'2026-10-09T07:01:00Z',sessionRevision:2,turnState:{active:true,turnId:'new-turn'}};
 globalThis.fetch=async raw=>{requests.push(raw);const url=new URL(raw,'http://fixture.invalid');
  if(url.pathname==='/api/platform/sessions')return Response.json({sessions:[live?next:old]});
  if(url.pathname==='/api/session-preview/'+native)return Response.json({conversation:{turns:[{id:'old-turn',user:'old question',assistant:[{text:'done'}]}]}});
  if(url.pathname==='/api/platform/sessions/new-web')return Response.json({session:next,transcript:{items:[{id:'external-user',type:'user',text:'external question',turnId:'new-turn'}]}});
  throw new Error('unexpected request '+raw);
 };
 const adapter=createAgentWebSessionAdapter({clientId:'test',lazyMetadata:true});const host=createSessionHostController({adapter,initialSessionId:'old-web',submissionFeedback:true});
 t.after(()=>{host.dispose();adapter.dispose();for(const[key,value]of Object.entries(original)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 await host.start();assert.equal(host.getSnapshot().session.preview,true);assert.equal(Socket.values.length,0);
 live=true;const rows=adapter.applyCatalogEvent(host.getSnapshot().sessions,{type:'session-summary',revision:2,summary:next});host.updateSessions(rows);await host.reconcileSelectedSession();
 assert.equal(host.getSnapshot().selectedId,'old-web');assert.equal(host.getSnapshot().session.webSessionId,'new-web');assert.equal(host.getSnapshot().session.status,'running');
 assert.deepEqual(host.getSnapshot().session.messages.map(item=>item.id),['external-user']);
 assert.equal(Socket.values.length,1);assert.equal(new URL(Socket.values[0].url).searchParams.get('attach'),'new-web');
 assert.equal(requests.some(url=>url.includes('/sessions/old-web')),false,'released preview does not spawn a Runtime');
 await host.reconcileSelectedSession({refresh:true});assert.equal(Socket.values.length,1,'focus reads only selected Session, without rebuilding its connection');
});
test('old deep link resolves to the actual reusable live attachment before subscribing',async t=>{
 const original=Object.fromEntries(['fetch','WebSocket','location','sessionStorage'].map(key=>[key,globalThis[key]]));globalThis.sessionStorage={getItem:()=>null,setItem:()=>{}};globalThis.WebSocket=Socket;globalThis.location={protocol:'http:',host:'fixture.invalid'};
 globalThis.fetch=async raw=>Response.json({session:{id:'new-binding',sessionId:'native',ready:true,turnState:{active:false}},transcript:{items:[]}});
 const adapter=createAgentWebSessionAdapter({clientId:'deep-link',lazyMetadata:true});const snapshot=await adapter.readSession('old-binding');const cleanup=adapter.subscribeSession('old-binding');
 t.after(()=>{cleanup();adapter.dispose();for(const[key,value]of Object.entries(original)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 assert.equal(snapshot.webSessionId,'new-binding');assert.equal(new URL(Socket.values.at(-1).url).searchParams.get('attach'),'new-binding');
});

test('native client user identity resolves feedback even when native formatting or metadata changes',()=>{
 const adapter=createAgentWebSessionAdapter({clientId:'echo'});
 try {
  const submission={idempotencyKey:'send:stable',baseline:['earlier'],message:{content:'original',attachments:[],references:[]}};
  assert.equal(adapter.isSubmissionEcho({messages:[{id:'earlier',role:'user',content:'original'}]},submission),false);
  assert.equal(adapter.isSubmissionEcho({messages:[{id:'send:stable',role:'user',content:'wrapped original',attachments:[{id:'native'}]}]},submission),true);
 }finally{adapter.dispose();}
});
