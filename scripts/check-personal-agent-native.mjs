// Explicit opt-in smoke: real local App Server/model, synthetic materials only.
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServerClient, CodexAppServerConnection } from '../lib/codex-app-server-client.js';
import { registerPersonalAgentGateway } from '../lib/personal-agent-gateway.js';

const runtime = process.env.PERSONAL_NATIVE_SMOKE_ROOT;
if (!runtime || !path.isAbsolute(runtime)) throw new Error('Set PERSONAL_NATIVE_SMOKE_ROOT to an owned absolute runtime directory.');
await fs.mkdir(runtime, { recursive: true });
const connection = new CodexAppServerConnection({ cwd: runtime, requestTimeoutMs: 30000 });
async function archiveCompletedSmokeThreads() {
  const ledger = JSON.parse(await fs.readFile(path.join(runtime, 'ledger.json'), 'utf8').catch(() => '{"records":{}}'));
  const ids = Object.values(ledger.records).filter(record => record.status === 'completed' && record.requestId?.startsWith('native-smoke-') && record.prompt === '这是合成材料的接口验收，按任务要求生成一两句话。').map(record => record.threadId).filter(Boolean);
  if (!ids.length) return;
  const client = new CodexAppServerClient({ connection, cwd: runtime });
  try { await client.start(); for (const id of ids) await client.setThreadArchived(true, id); }
  finally { client.close(); }
  await fs.writeFile(path.join(runtime, 'cleanup.json'), JSON.stringify({ archivedThreadIds: ids, reason: 'completed synthetic smoke only' }, null, 2));
}
if (process.argv.includes('--cleanup-only')) {
  try { await archiveCompletedSmokeThreads(); } finally { await connection.close(); }
  process.exit(0);
}
const app = express(); app.use(express.json());
registerPersonalAgentGateway(app, {
  cwd: runtime, statePath: path.join(runtime, 'ledger.json'), openingTimeoutMs: 90000,
  createClient: async () => new CodexAppServerClient({ connection, cwd: runtime }),
  listSessions: async () => [], readTurnPage: async () => ({ data: [] }),
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
async function request(endpoint, body) {
  const response = await fetch(origin + '/api/home/agent/' + endpoint, {
    headers: { 'content-type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
}
const sources = [
  { id: 'records:small-practice', kind: 'memo', title: '昨天的小实践', path: 'Life/Records.md', text: '昨天出门散步十分钟，回来感觉脑子更清楚了。', occurredAt: '2026-10-04T12:00:00Z' },
  { id: 'tibetan:tea', kind: 'tibetan', title: '茶', text: 'ཇ་：茶', data: { phrase: 'ཇ་', meaning: '茶' } },
  { id: 'session:practice', kind: 'conversation', title: '昨天的讨论', text: '这次小实践我们还可以继续聊。', href: 'https://agent.chenyanglin.com/?sessionId=synthetic-original' },
];
const summary = { fixture: 'synthetic-only', results: [] };
try {
  const config = await request('personal-config');
  for (const task of config.tasks) task.instructions = '读取小实践的记录，简短自然地接着聊。调用 home_records_search 读取，再调用 home_show_sources 呈现读到的材料，调用 home_show_tibetan 呈现藏语。用 agent_sessions_read 读取 session:practice，再用 home_show_session_action 呈现继续讨论的按钮。这次省略 label，以验证工具默认文案。只返回很短的 text 和 reason。';
  config.preferences['home.show_sources'] = 'required';
  config.preferences['home.show_session_action'] = 'required';
  const saved = await request('personal-config', config);
  for (const period of ['morning', 'evening']) {
    const requestId = 'native-smoke-' + period + '-' + Date.now();
    let job = await request('openings', { requestId, date: '2026-10-05', period, taskId: period, configRevision: saved.revision,
      prompt: '这是合成材料的接口验收，按任务要求生成一两句话。', toolContext: { sources, coverage: [{ source: 'fixture', status: 'partial', detail: 'Synthetic capture only.' }] } });
    const deadline = Date.now() + 100000;
    while (['pending', 'running'].includes(job.status) && Date.now() < deadline) { await delay(500); job = await request('openings/' + requestId); }
    const ledger = JSON.parse(await fs.readFile(path.join(runtime, 'ledger.json'), 'utf8'));
    const record = ledger.records[requestId];
    summary.results.push({ period, status: job.status, threadId: job.threadId, turnId: job.turnId, reason: job.reason, text: job.text,
      tools: record.toolReceipts?.map(receipt => ({ toolId: receipt.toolId, success: receipt.success })), widgets: job.widgets });
    await fs.writeFile(path.join(runtime, 'summary.json'), JSON.stringify(summary, null, 2));
    assert.equal(job.status, 'completed', job.reason);
    assert.ok(record.toolReceipts.some(receipt => receipt.toolId === 'home.records.search' && receipt.success));
    assert.ok(record.toolReceipts.some(receipt => receipt.toolId === 'home.show_tibetan' && receipt.success));
    assert.equal(job.widgets.find(widget => widget.type === 'session_action')?.label, '继续这段讨论');
    console.log(JSON.stringify({ period, status: job.status, tools: summary.results.at(-1).tools }));
  }
  // Resume the actual durable opening after the gateway released its scoped client.
  const threadId = summary.results[0].threadId;
  const client = new CodexAppServerClient({ connection, cwd: runtime });
  await client.start(); await client.resumeThread(threadId, { cwd: runtime });
  let finalText = '', requests = 0;
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Continuation timed out.')), 90000);
    client.on('server-request', message => { requests++; client.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: 'This continuation uses existing context only.' }] }); });
    client.on('notification', message => {
      if (message.params?.threadId !== threadId) return;
      if (message.method === 'item/completed' && message.params.item?.type === 'agentMessage') finalText = message.params.item.text;
      if (message.method === 'turn/completed') { clearTimeout(timer); resolve(message.params.turn); }
    });
  });
  await client.startTurn('我们接着聊刚才十分钟散步这个小实践。只用本会话已有材料，回一句自然的中文，不要调用工具，也不需要 JSON。');
  const turn = await completed;
  assert.equal(turn.status, 'completed'); assert.ok(finalText?.trim()); assert.equal(requests, 0);
  summary.continuation = { threadId, turnId: turn.id, status: turn.status, text: finalText, toolRequests: requests };
  await client.unsubscribeThread(); client.close();
  await fs.writeFile(path.join(runtime, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ continuation: 'completed', toolRequests: requests }));
} finally {
  try { await archiveCompletedSmokeThreads(); }
  finally { await connection.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
