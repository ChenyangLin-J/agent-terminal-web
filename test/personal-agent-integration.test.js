import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const threadId = '019f9db5-cdfd-7c10-b477-4859c2339901';

test('restricted opening uses the shared protocol and can resume through the existing Home gateway', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'personal-opening-integration-'));
  const workspace = path.join(temp, 'workspace'), state = path.join(temp, 'state'), fake = path.join(temp, 'fake-codex.cjs'), log = path.join(temp, 'calls.jsonl');
  await mkdir(workspace); await mkdir(state);
  await writeFile(fake, fakeAppServer()); await chmod(fake, 0o755);
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    PATH: process.env.PATH, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), WORKSPACE_ROOT: workspace,
    OBSIDIAN_VAULT_PATH: path.join(workspace, 'obsidian'), AGENT_CODEX_STATE_ROOT: state,
    AGENT_INTEGRATIONS_DIR: path.join(temp, 'integrations'), AGENT_CUBOX_CONFIG_DIR: path.join(temp, 'cubox'),
    PRIVATE_AUTH_VERIFY_URL: 'http://127.0.0.1:9/disabled', HOME_AGENT_GATEWAY_TOKEN: 'fixture-only',
    CODEX_APP_SERVER_COMMAND: fake, AGENT_NATIVE_THREAD_CATALOG: '1',
    HOME_PUSH_URL: 'http://127.0.0.1:9/disabled', HOME_PUSH_SUBSCRIBE_URL: 'http://127.0.0.1:9/disabled',
    FAKE_CALLS_FILE: log,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(temp, { recursive: true, force: true });
  });
  await until(() => { if (child.exitCode !== null) throw new Error(output); return output.includes('Agent Terminal Web:'); });
  const base = `http://127.0.0.1:${port}/api/home/agent`;
  const request = (url, body) => fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'x-home-agent-gateway-token': 'fixture-only', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(base + '/openings/test')).status, 404);
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const opening = { requestId: 'opening-fixture', prompt: '用户的今日记录，id:source-1', date, period: 'evening' };
  assert.equal((await request('/openings', opening)).status, 202);
  const completed = await until(async () => { const result = await (await request('/openings/opening-fixture')).json(); return result.status === 'completed' ? result : null; });
  assert.equal(completed.threadId, threadId); assert.equal(completed.text, '今天你说跑通了，想聊聊过程吗？');
  assert.equal(completed.usage.inputTokens, 120);
  const ledger = JSON.parse(await readFile(path.join(state, 'home-personal-agent-openings.json'), 'utf8'));
  assert.equal(ledger.records['opening-fixture'].turnId, completed.turnId);
  const reply = await request('/turns', { sessionId: completed.threadId, text: '今天有点累，但终于跑通很开心', requestId: 'real-reply' });
  assert.equal(reply.status, 202);
  assert.equal((await reply.json()).session.id, threadId);
  await until(async () => (await readFile(log, 'utf8')).includes('thread/resume'));
  await new Promise(resolve => setTimeout(resolve, 120));
  const activity = await (await request('/activity?' + new URLSearchParams({ from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 1000).toISOString(), limit: '40' }))).json();
  assert.ok(activity.items.some(item => item.author === 'user' && item.text.includes('有点累')));
  assert.ok(!activity.items.some(item => item.text.includes('id:source-1')));
  assert.ok(!activity.items.some(item => item.text === completed.text));
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.filter(call => call.method === 'initialize').length, 1, 'generation and catalog reuse one App Server');
  const start = calls.find(call => call.method === 'thread/start');
  const resume = calls.find(call => call.method === 'thread/resume');
  assert.equal(start.params.cwd, path.join(workspace, '.personal-agent-runtime'));
  assert.equal(resume.params.cwd, start.params.cwd);
  assert.equal(start.params.config.features.shell_tool, false);
  const turns = calls.filter(call => call.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].params.sandboxPolicy.type, 'readOnly');
  assert.ok(turns[0].params.outputSchema);
  assert.equal(turns[1].params.outputSchema, undefined, 'opening JSON schema is confined to the initial turn');
});

async function until(read) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Fixture timed out');
}
function fakeAppServer() {
  return `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
const threadId = '${threadId}', turns = [], input = readline.createInterface({input:process.stdin});
let cwd = process.cwd();
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
input.on('line', line => {
 const message = JSON.parse(line), params = message.params || {};
 fs.appendFileSync(process.env.FAKE_CALLS_FILE, JSON.stringify({method:message.method,params})+'\\n');
 if(message.id===undefined) return;
 if(message.method==='initialize') return send({id:message.id,result:{userAgent:'fixture'}});
 if(message.method==='config/read') return send({id:message.id,result:{config:{mcp_servers:{},apps:{},plugins:{}}}});
 if(message.method==='thread/list') return send({id:message.id,result:{data:turns.length?[{id:threadId,cwd,name:'Opening',updatedAt:Math.floor(Date.now()/1000),createdAt:1,status:'idle'}]:[]}});
 if(message.method==='thread/turns/list') return send({id:message.id,result:{data:[...turns].reverse(),nextCursor:null}});
 if(message.method==='thread/read') return send({id:message.id,result:{thread:{id:threadId,cwd,turns}}});
 if(message.method==='thread/start'||message.method==='thread/resume') {cwd=params.cwd; return send({id:message.id,result:{thread:{id:threadId,cwd,turns:[]},initialTurnsPage:{data:[...turns].reverse()}}});}
 if(message.method==='turn/start') {
  const turn={id:'019f9db5-cdfd-7c10-b477-4859c233'+String(9910+turns.length),startedAt:Math.floor(Date.now()/1000),status:'inProgress',items:[{type:'userMessage',content:params.input}]};
  turns.push(turn);send({id:message.id,result:{turn}});
  return setTimeout(()=>{
   const text=params.outputSchema?JSON.stringify({text:'今天你说跑通了，想聊聊过程吗？',sourceIds:['source-1'],reason:'用户记录'}):'接着说说你的感受吧。';
   const item={type:'agentMessage',phase:'final_answer',text,completedAt:new Date().toISOString()};
   turn.items.push(item);turn.status='completed';turn.completedAt=Math.floor(Date.now()/1000);
   send({method:'item/completed',params:{threadId,turnId:turn.id,item}});
   send({method:'thread/tokenUsage/updated',params:{threadId,turnId:turn.id,tokenUsage:{last:{inputTokens:120,outputTokens:20,totalTokens:140},total:{}}}});
   send({method:'turn/completed',params:{threadId,turn}});
  },30);
 }
 send({id:message.id,result:{}});
});
`;
}
