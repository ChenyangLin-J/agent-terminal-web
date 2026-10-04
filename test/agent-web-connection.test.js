import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentWebConnection } from '../public/agent-web-connection.js';
class Loopback extends EventTarget {
 static sockets=[]; readyState=0;
 constructor(){super();Loopback.sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
 send(raw){const message=JSON.parse(raw);this.sent=message;const type=message.type==='side-chat-open'?'side-chat-state':'control-ack';this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type,payload:{idempotencyKey:message.idempotencyKey,accepted:true}})}));}
 close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}
test('transport registers both mutation receipts and read replies before a synchronous response',async()=>{
 const connection=createAgentWebConnection('web-1',{clientId:'test',WebSocketClass:Loopback,origin:{protocol:'http:',host:'example.invalid'}});
 await connection.ready;
 assert.equal((await connection.send({type:'submit',data:'draft'},{idempotencyKey:'turn:unique-123'})).accepted,true);
 assert.equal((await connection.send({type:'side-chat-open'},{responseTypes:['side-chat-state']})).accepted,true);
 connection.dispose();
});
test('releasing a Session closes its transport and rejects unknown pending operations',async()=>{
 const connection=createAgentWebConnection('web-2',{clientId:'test',WebSocketClass:Loopback,origin:{protocol:'http:',host:'example.invalid'}});
 await connection.ready;const socket=Loopback.sockets.at(-1);socket.send=()=>{};
 const operation=connection.send({type:'submit',data:'draft'},{idempotencyKey:'turn:unknown-123'});await Promise.resolve();
 connection.dispose();await assert.rejects(operation,/released/);assert.equal(socket.readyState,3);
});
