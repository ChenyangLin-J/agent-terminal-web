import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const threadId = '019f9db4-cdfd-7c10-b477-4859c23313be';
const headId = '019f9db5-cdfd-7c10-b477-4859c23313be';
const oldId = '019f9db5-cdfd-7c10-b477-4859c23313bf';
const completedAt = 1791167786;
const activityAt = new Date(completedAt * 1000).toISOString();

for (const kernelMode of ['legacy', 'new']) {
  test(`${kernelMode}: opening an older attachment reconciles the native head without changing Recent`, async t => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-resume-state-'));
    const workspace = path.join(temporaryRoot, 'workspace');
    const stateRoot = path.join(temporaryRoot, 'state');
    const codex = path.join(stateRoot, 'codex');
    await mkdir(workspace, { recursive: true }); await mkdir(codex, { recursive: true });
    const record = { id: 'old-attachment', sessionId: threadId, cwd: workspace, transport: 'app-server', mode: 'resume-id', access: 'full', args: ['app-server'], title: 'Existing conversation',
      startedAt: '2026-10-04T00:00:00Z', lastActivityAt: '2026-10-04T15:04:48Z', turnState: { active: false, interrupted: true, turnId: oldId, requirements: [{ id: 'old-requirement', text: 'outdated request', kind: 'original', status: 'interrupted' }] } };
    await writeFile(path.join(codex, 'agent-web-sessions.json'), JSON.stringify({ [record.id]: record }));
    const turns = [
      { id: headId, status: 'completed', startedAt: completedAt - 30, completedAt, items: [{ id: 'latest-user', type: 'userMessage', content: [{ type: 'text', text: 'latest request' }] }, { id: 'latest-answer', type: 'agentMessage', phase: 'final_answer', text: 'latest answer' }] },
      { id: oldId, status: 'interrupted', startedAt: completedAt - 3600, completedAt: completedAt - 3590, items: [] },
    ];
    const fakeCodex = path.join(temporaryRoot, 'fake-codex.cjs');
    const callsFile = path.join(temporaryRoot, 'calls.jsonl');
    await writeFile(fakeCodex, `#!/usr/bin/env node
const readline = require('node:readline'), fs = require('node:fs');
const turns = ${JSON.stringify(turns)};
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line); fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({method:m.method})+'\\n');
 if(m.method==='initialize') send({id:m.id,result:{userAgent:'fixture'}});
 else if(m.method==='thread/resume') {
   send({id:m.id,result:{thread:{id:m.params.threadId,updatedAt:Math.floor(Date.now()/1000),turns:[]},initialTurnsPage:{data:turns,nextCursor:null}}});
   send({method:'thread/started',params:{thread:{id:m.params.threadId}}});
   send({method:'thread/tokenUsage/updated',params:{threadId:m.params.threadId,tokenUsage:{last:{totalTokens:100},total:{totalTokens:100},modelContextWindow:1000}}});
   send({method:'thread/status/changed',params:{threadId:m.params.threadId,status:{type:'idle'}}});
 } else if(m.method==='thread/turns/list') send({id:m.id,result:{data:turns,nextCursor:null}});
 else if(m.method==='thread/read') send({id:m.id,result:{thread:{id:m.params.threadId,turns}}});
 else if(m.method==='config/read') send({id:m.id,result:{config:{model:'gpt-6.1-sol',model_reasoning_effort:'xhigh',model_context_window:1000}}});
 else if(m.id!==undefined) send({id:m.id,result:{}});
});
`);
    await chmod(fakeCodex, 0o755);
    const auth = http.createServer((_req,res) => { res.writeHead(200, {'content-type':'application/json'}); res.end('{"authenticated":true}'); });
    await new Promise(resolve => auth.listen(0,'127.0.0.1',resolve));
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOST:'127.0.0.1', PORT:String(port), WORKSPACE_ROOT:workspace, AGENT_STATE_ROOT:stateRoot, CODEX_APP_SERVER_COMMAND:fakeCodex, AGENT_NATIVE_THREAD_CATALOG:'0', AGENT_PLATFORM_KERNEL:kernelMode, PRIVATE_AUTH_VERIFY_URL:`http://127.0.0.1:${auth.address().port}` }, stdio:['ignore','pipe','pipe'] });
    let output=''; child.stdout.on('data',chunk => output+=chunk); child.stderr.on('data',chunk => output+=chunk);
    t.after(async () => { if(child.exitCode===null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit',resolve)); } auth.close(); await rm(temporaryRoot,{recursive:true,force:true}); });
    await waitFor(() => output.includes('Agent Terminal Web:'), 5000);
    const snapshot = async () => { const r=await fetch(`http://127.0.0.1:${port}/api/platform/sessions/${record.id}`); assert.equal(r.status,200); return r.json(); };
    let restored;
    await waitFor(async () => { restored=await snapshot(); return restored.session.ready; }, 5000);
    assert.equal(restored.session.turnState.interrupted, false);
    assert.equal(restored.session.turnState.active, false);
    assert.equal(restored.session.turnState.turnId, headId);
    assert.equal(restored.session.turnState.lastCompletedTurnId, headId);
    assert.equal(restored.session.turnState.requirements[0]?.text, 'latest request');
    assert.equal(restored.session.lastActivityAt, activityAt);
    assert.equal(restored.transcript.items.filter(item => item.id==='latest-user').length,1);
    const rows=(await (await fetch(`http://127.0.0.1:${port}/api/platform/sessions`)).json()).sessions;
    assert.equal(rows.find(row => row.id===record.id).lastActivityAt, activityAt);
    assert.equal((await snapshot()).session.lastActivityAt, activityAt);
    const persisted=JSON.parse(await readFile(path.join(codex,'agent-web-sessions.json'),'utf8'));
    assert.equal(persisted[record.id].sessionId,threadId);
    assert.equal(persisted[record.id].turnState.interrupted,false);
    assert.equal(persisted[record.id].lastActivityAt,activityAt);
    const calls=(await readFile(callsFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line).method);
    assert.equal(calls.filter(method=>method==='thread/resume').length,1);
    assert.equal(calls.includes('thread/start'),false);
    assert.equal(calls.includes('turn/start'),false);
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) { if(await predicate()) return; await new Promise(resolve=>setTimeout(resolve,20)); }
  throw new Error('Timed out waiting for restored state');
}
