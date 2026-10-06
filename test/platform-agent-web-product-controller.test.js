import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentWebProductController, memorySourceEntriesForMessage, normalizeAgentWebSideChatPanel } from '../public/platform-agent-web-product-controller.js';
test('Side Chat has an editable draft before the product lazily creates its runtime',()=>{
 const empty=normalizeAgentWebSideChatPanel({status:'closed'});
 assert.equal(empty.selectedId,'side-chat-draft');
 assert.equal(empty.sideChats[0].status,'idle');
 assert.deepEqual(empty.sideChats[0].transcript,[]);
 const active=normalizeAgentWebSideChatPanel({id:'side-1',active:true,items:[{id:'reply',text:'answer'}]});
 assert.equal(active.selectedId,'side-1');assert.equal(active.sideChats[0].status,'running');assert.equal(active.sideChats[0].transcript[0].text,'answer');
});
test('product favorite/archive use Codex thread identity and logout follows its product redirect',async()=>{
 const calls=[];const location={};
 const product=createAgentWebProductController({fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({logoutUrl:'/login'}));},locationRef:location});
 await product.favorite('thread-1',true);await product.archive('thread-1',false);await product.logout();
 assert.equal(calls[0].url,'/api/codex-sessions/thread-1/favorite');assert.equal(calls[1].url,'/api/codex-sessions/thread-1/archive');assert.equal(location.href,'/login');
});

test('local preview is latest-request-wins and close clears it', async () => {
 const pending=[];
 const product=createAgentWebProductController({fetchImpl:(url,{signal}={})=>new Promise((resolve,reject)=>{
  pending.push({url,resolve});signal?.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})));
 })});
 const seen=[];product.subscribeDocumentPreview(()=>seen.push(product.getDocumentPreview()));
 const first=product.openLocalDocument('/workspace/first.md');
 const second=product.openLocalDocument('/workspace/second.md');
 assert.equal(pending[0].url,'/api/platform/file-preview?href=%2Fworkspace%2Ffirst.md');
 pending[1].resolve(new Response(JSON.stringify({name:'second.md',path:'/workspace/second.md',format:'markdown',content:'second'})));
 await Promise.all([first,second]);
 assert.equal(product.getDocumentPreview().content,'second');
 product.closeDocument();
 assert.equal(product.getDocumentPreview(),null);
 assert.ok(seen.length>=3);
});

test('authorized artifact image URLs open directly in the shared image preview',()=>{
 const product=createAgentWebProductController();
 product.openArtifact({id:'shot',name:'shot.png',kind:'image',previewUrl:'/api/session-image/shot'});
 assert.deepEqual(product.getDocumentPreview(),{
  name:'shot.png',path:'',format:'image',mimeType:'image/*',size:0,src:'/api/session-image/shot',downloadUrl:'/api/session-image/shot',sourceLabel:'Agent 产物',
 });
});

test('memory sources come only from exact final-answer citations',()=>{
 const citation={entries:[{path:'/workspace/Memory/Core.md'},{note:'missing path'}]};
 const snapshot={messages:[
  {id:'final',phase:'final_answer',memoryCitation:citation},
  {id:'commentary',phase:'commentary',memoryCitation:citation},
  {id:'old',phase:'final_answer'},
 ]};
 assert.deepEqual(memorySourceEntriesForMessage({id:'final',role:'assistant'},snapshot),[{path:'/workspace/Memory/Core.md'}]);
 assert.deepEqual(memorySourceEntriesForMessage({id:'commentary',role:'assistant'},snapshot),[]);
 assert.deepEqual(memorySourceEntriesForMessage({id:'old',role:'assistant'},snapshot),[]);
 assert.deepEqual(memorySourceEntriesForMessage({id:'final',role:'user'},snapshot),[]);
});

test('failed file reads expose a working retry in the raw text rendered by the shared preview', async () => {
 const product=createAgentWebProductController({fetchImpl:async()=>new Response(JSON.stringify({error:'读取失败'}),{status:503})});
 await product.openLocalDocument('/workspace/note.md');
 const preview=product.getDocumentPreview();
 assert.equal(preview.loading,false);
 assert.equal(preview.rawText,preview.content);
 assert.match(preview.rawText,/\[重试\]\(\/workspace\/note\.md\)/);
});
