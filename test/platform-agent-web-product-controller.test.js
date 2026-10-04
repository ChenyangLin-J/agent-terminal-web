import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentWebProductController, normalizeAgentWebSideChatPanel } from '../public/platform-agent-web-product-controller.js';
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
