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

test('parallel typed replies settle only their operation, in either reply order', async () => {
 const connection=createAgentWebConnection('parallel',{WebSocketClass:Loopback,origin:{protocol:'http:',host:'example.invalid'}});
 await connection.ready; const socket=Loopback.sockets.at(-1);socket.send=()=>{};
 const received=[];
 connection.listeners.add(event=>received.push(event));
 const results=[];
 const one=connection.send({type:'side-chat-open'},{idempotencyKey:'one',responseTypes:['side-chat-state']}).then(value=>{results.push('one');return value;});
 const two=connection.send({type:'side-chat-open'},{idempotencyKey:'two',responseTypes:['side-chat-state']}).then(value=>{results.push('two');return value;});
 await Promise.resolve();
 const reply=payload=>socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'side-chat-state',payload})}));
 reply({broadcast:true}); await Promise.resolve();assert.deepEqual(results,[]);
 reply({idempotencyKey:'two',owner:'two'});assert.equal((await two).owner,'two');assert.deepEqual(results,['two']);
 reply({idempotencyKey:'unknown'});await Promise.resolve();assert.deepEqual(results,['two']);
 reply({idempotencyKey:'one',owner:'one'});assert.equal((await one).owner,'one');
 assert.equal(received.length,4);connection.dispose();
});

test('an unrelated acknowledgement cannot settle a typed request, and a scoped error rejects only its owner', async () => {
 const connection=createAgentWebConnection('scoped',{WebSocketClass:Loopback,origin:{protocol:'http:',host:'example.invalid'}});
 await connection.ready;const socket=Loopback.sockets.at(-1);socket.send=()=>{};
 const one=connection.send({type:'command'},{idempotencyKey:'command-one',responseTypes:['app-command-result']});
 const two=connection.send({type:'command'},{idempotencyKey:'command-two',responseTypes:['app-command-result']});
 const rejected=assert.rejects(two,error=>error.message==='failed two'&&error.knownResult===true);
 await Promise.resolve();
 const reply=(type,payload)=>socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type,payload})}));
 reply('control-ack',{idempotencyKey:'command-one'});
 reply('error',{idempotencyKey:'command-two',message:'failed two',receiptState:'failed'});
 reply('app-command-result',{idempotencyKey:'command-one',owner:'one'});
 assert.equal((await one).owner,'one');await rejected;connection.dispose();
});

test('duplicate pending IDs and synchronous send failures do not orphan operations', async () => {
 const connection=createAgentWebConnection('ids',{WebSocketClass:Loopback,origin:{protocol:'http:',host:'example.invalid'}});
 await connection.ready;const socket=Loopback.sockets.at(-1);socket.send=()=>{};
 const first=connection.send({type:'submit'},{idempotencyKey:'same'});await Promise.resolve();
 await assert.rejects(connection.send({type:'submit'},{idempotencyKey:'same'}),/already pending/);
 socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'control-ack',payload:{idempotencyKey:'same'}})}));await first;
 socket.send=()=>{throw new Error('cannot write');};
 await assert.rejects(connection.send({type:'submit'},{idempotencyKey:'retry'}),/cannot write/);
 socket.send=Loopback.prototype.send;assert.equal((await connection.send({type:'submit'},{idempotencyKey:'retry'})).accepted,true);
 connection.dispose();
});

test('a socket that never opens has a bounded handshake and cannot send after cancellation',async()=>{
 class Silent extends EventTarget {readyState=0;send(){throw new Error('unexpected write');}close(){this.readyState=3;this.dispatchEvent(new Event('close'));}}
 const timers=[];const connection=createAgentWebConnection('silent',{WebSocketClass:Silent,origin:{protocol:'http:',host:'test.invalid'},schedule:fn=>{timers.push(fn);return fn;},cancel:()=>{}});
 const waiting=assert.rejects(connection.ready,/超时/);timers[0]();await waiting;connection.dispose();
 const live=createAgentWebConnection('cancelled',{WebSocketClass:Loopback,origin:{protocol:'http:',host:'test.invalid'}});await live.ready;
 const abort=new AbortController();abort.abort();await assert.rejects(live.send({type:'submit'},{signal:abort.signal}),{name:'AbortError'});live.dispose();
});
