import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { registerPersonalAgentGateway } from "../lib/personal-agent-gateway.js";

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-agent-gateway-"));
  const app = express(); app.use(express.json());
  const clients = [];
  const createClient = options.createClient || (() => { const client = new FakeClient(); clients.push(client); return client; });
  const gateway = registerPersonalAgentGateway(app, {
    createClient, listSessions: options.listSessions || (async () => []), readTurnPage: options.readTurnPage || (async () => ({ data: [] })),
    statePath: path.join(root, "opening-ledger.json"), openingTimeoutMs: options.openingTimeoutMs || 200,
    isInteractiveBusy: options.isInteractiveBusy, backgroundThreadIds: options.backgroundThreadIds,
  });
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { root, clients, gateway, statePath: path.join(root, "opening-ledger.json"), url: `http://127.0.0.1:${server.address().port}`, close: async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); } };
}
async function request(fixture, pathname, method = "GET", body) { const response = await fetch(fixture.url + pathname, { method, headers: body ? { "content-type": "application/json" } : {}, body: body && JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
async function eventually(fn) { for (let i = 0; i < 30; i += 1) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Timed out"); }

class FakeClient extends EventEmitter {
  constructor() { super(); this.threadId = ""; this.closed = false; this.calls = []; }
  async start() { this.calls.push(["start"]); }
  async readConfig() { return { mcp_servers: { calendar: {}, drive: {} }, apps: { calendar_app: {} }, plugins: { plugin_a: { mcp_servers: { plugin_tool: {} } } } }; }
  async startThread(params) { this.calls.push(["thread", params]); this.threadId = "opening-thread"; return { id: this.threadId }; }
  async startTurn(_text, params) { this.calls.push(["turn", params]); const turn = { id: "opening-turn" }; setTimeout(() => { this.emit("notification", { method: "item/completed", params: { threadId: this.threadId, item: { type: "agentMessage", phase: "final_answer", text: '{"text":"hello","sourceIds":["s1"],"reason":"prompt"}' } } }); this.emit("notification", { method: "turn/completed", params: { threadId: this.threadId, turn: { id: turn.id, status: "completed" } } }); }, 5); return turn; }
  async unsubscribeThread() { this.calls.push(["unsubscribe"]); this.threadId = ""; }
  close() { this.closed = true; this.calls.push(["close"]); }
}

test("openings are idempotent, durable, and pin the restricted App Server settings", async (t) => {
  const f = await fixture(); t.after(f.close);
  const body = { requestId: "same-id", prompt: "say hello", date: "2026-10-04", period: "morning" };
  const [one, two] = await Promise.all([request(f, "/api/home/agent/openings", "POST", body), request(f, "/api/home/agent/openings", "POST", body)]);
  assert.equal(one.status, 202); assert.equal(two.status, 202);
  await eventually(async () => (await request(f, "/api/home/agent/openings/same-id")).body.status === "completed");
  const status = await request(f, "/api/home/agent/openings/same-id");
  assert.deepEqual(status.body, { requestId: "same-id", status: "completed", threadId: "opening-thread", turnId: "opening-turn", text: "hello", sourceIds: ["s1"], reason: "prompt" });
  assert.equal(f.clients.length, 1);
  const thread = f.clients[0].calls.find(([kind]) => kind === "thread")[1];
  const turn = f.clients[0].calls.find(([kind]) => kind === "turn")[1];
  assert.equal(thread.sandbox, "read-only"); assert.equal(thread.approvalPolicy, "never");
  assert.deepEqual(thread.config.mcp_servers, { calendar: { enabled: false }, drive: { enabled: false } });
  assert.equal(thread.config.apps._default.enabled, false); assert.equal(thread.config.apps.calendar_app.enabled, false); assert.equal(thread.config.plugins.plugin_a.enabled, false); assert.equal(thread.config.features.shell_tool, false); assert.equal(thread.config.features.unified_exec, false); assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  await eventually(() => f.clients[0].calls.some(([kind]) => kind === "close"));
  assert.deepEqual(f.clients[0].calls.map(([kind]) => kind), ["start", "thread", "turn", "unsubscribe", "close"]);
  const changed = await request(f, "/api/home/agent/openings", "POST", { ...body, prompt: "different" });
  assert.equal(changed.status, 409);
  assert.match(await readFile(f.statePath, "utf8"), /same-id/);
  const history = f.gateway.presentConversation('opening-thread', { messages: [
    { id: 'machine', role: 'user', text: 'private machine context', turnId: 'opening-turn' },
    { id: 'json', role: 'assistant', text: '{"text":"hello"}', turnId: 'opening-turn' },
    { id: 'real', role: 'user', text: 'My own reply', turnId: 'next-turn' },
  ], hasEarlier: false });
  assert.deepEqual(history.messages.map(message => message.text), ['hello', 'My own reply']);
  assert.equal(f.gateway.sessionTitle('opening-thread'), '2026-10-04 · 晨间开场');
  assert.equal(f.gateway.sessionTitle('ordinary-thread'), '');
});

test('accepts a full 350-character opening without truncation', async t => {
  const text = '开'.repeat(349) + '😀';
  const f = await fixture({ createClient: () => {
    const client = new FakeClient();
    client.startTurn = async (_text, params) => {
      assert.equal(params.outputSchema.properties.text.maxLength, 350);
      setTimeout(() => {
        client.emit('notification', { method: 'item/completed', params: { threadId: client.threadId, item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ text, sourceIds: [], reason: 'grounded' }) } } });
        client.emit('notification', { method: 'turn/completed', params: { threadId: client.threadId, turn: { id: 'opening-turn', status: 'completed' } } });
      }, 5);
      return { id: 'opening-turn' };
    };
    return client;
  } }); t.after(f.close);
  await request(f, '/api/home/agent/openings', 'POST', { requestId: 'full-length', prompt: 'x', date: '2026-10-04', period: 'evening' });
  const result = await eventually(async () => {
    const value = await request(f, '/api/home/agent/openings/full-length');
    return value.body.status === 'completed' && value;
  });
  assert.equal(result.body.text, text);
});

test("interactive busy rejects new work and a restart keeps uncertain work fail closed", async (t) => {
  const busy = await fixture({ isInteractiveBusy: () => true }); t.after(busy.close);
  assert.equal((await request(busy, "/api/home/agent/openings", "POST", { requestId: "busy", prompt: "x", date: "2026-10-04", period: "morning" })).status, 409);
  const first = await fixture({ createClient: () => new FakeClient() });
  const pending = { records: { restart: { requestId: "restart", fingerprint: "x", status: "running", threadId: "durable-thread", turnId: "expected-turn", prompt: "x", date: "2026-10-04", period: "morning" } } };
  await (await import("node:fs/promises")).writeFile(first.statePath, JSON.stringify(pending), { mode: 0o600 });
  // A new registration reads the same ledger and must never resend it.
  const app = express(); app.use(express.json()); let created = 0;
  registerPersonalAgentGateway(app, { createClient: () => { created += 1; return new FakeClient(); }, listSessions: async () => [], readTurnPage: async () => ({ data: [
    { id: "other-turn", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: '{"text":"wrong","sourceIds":[],"reason":"wrong"}' }] },
    { id: "expected-turn", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: '{"text":"recovered","sourceIds":["s"],"reason":"durable"}' }] },
  ] }), statePath: first.statePath });
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await first.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/home/agent/openings/restart`);
  const recovered = await response.json();
  assert.deepEqual(recovered, { requestId: "restart", status: "completed", threadId: "durable-thread", turnId: "expected-turn", text: "recovered", sourceIds: ["s"], reason: "durable" }); assert.equal(created, 0);
});

test("a deterministic pre-thread failure preserves its source for polling", async (t) => {
  const f = await fixture({ createClient: () => ({ start: async () => { throw new Error("shared App Server unavailable"); }, close() {} }) }); t.after(f.close);
  await request(f, "/api/home/agent/openings", "POST", { requestId: "failed", prompt: "x", date: "2026-10-04", period: "morning" });
  const outcome = await eventually(async () => { const value = await request(f, "/api/home/agent/openings/failed"); return value.body.status === "failed" ? value : null; });
  assert.equal(outcome.body.reason, "shared App Server unavailable");
});

test("accepts Home-sized context and identifiers, but validates real date and period", async (t) => {
  const f = await fixture(); t.after(f.close);
  const accepted = await request(f, "/api/home/agent/openings", "POST", { requestId: "home.opening:2026-10-04_1", prompt: "x".repeat(24_000), date: "2026-02-28", period: "evening" });
  assert.equal(accepted.status, 202);
  await eventually(async () => (await request(f, "/api/home/agent/openings/home.opening:2026-10-04_1")).body.status === "completed");
  assert.equal((await request(f, "/api/home/agent/openings", "POST", { requestId: "invalid", prompt: "x", date: "2026-02-30", period: "morning" })).status, 400);
  assert.equal((await request(f, "/api/home/agent/openings", "POST", { requestId: "invalid2", prompt: "x", date: "2026-02-28", period: "night" })).status, 400);
});

test("configuration discovery is required and only one reservation may generate", async (t) => {
  let releaseConfig;
  const blocked = new Promise((resolve) => { releaseConfig = resolve; });
  const clients = [];
  const f = await fixture({ createClient: () => { const client = new FakeClient(); client.readConfig = async () => blocked; clients.push(client); return client; } }); t.after(f.close);
  const first = await request(f, "/api/home/agent/openings", "POST", { requestId: "first", prompt: "x", date: "2026-10-04", period: "morning" });
  const second = await request(f, "/api/home/agent/openings", "POST", { requestId: "second", prompt: "x", date: "2026-10-04", period: "morning" });
  assert.equal(first.status, 202); assert.equal(second.status, 409);
  await eventually(() => clients.length === 1);
  releaseConfig({ mcp_servers: {} });
  await eventually(async () => (await request(f, "/api/home/agent/openings/first")).body.status === "completed");

  const missing = await fixture({ createClient: () => ({ start: async () => {}, readConfig: async () => { throw new Error("config/read failed"); }, close() {} }) }); t.after(missing.close);
  await request(missing, "/api/home/agent/openings", "POST", { requestId: "no-config", prompt: "x", date: "2026-10-04", period: "morning" });
  const outcome = await eventually(async () => { const value = await request(missing, "/api/home/agent/openings/no-config"); return value.body.status === "failed" ? value : null; });
  assert.match(outcome.body.reason, /config\/read failed/);
});

test("invalid oversized schema output is uncertain instead of silently truncated", async (t) => {
  const f = await fixture({ createClient: () => {
    const client = new FakeClient();
    client.startTurn = async () => { const turn = { id: "bad-output" }; setTimeout(() => {
      client.emit("notification", { method: "item/completed", params: { threadId: client.threadId, item: { type: "agentMessage", phase: "final_answer", text: JSON.stringify({ text: "😀".repeat(351), sourceIds: ["s1"], reason: "x" }) } } });
      client.emit("notification", { method: "turn/completed", params: { threadId: client.threadId, turn: { id: turn.id, status: "completed" } } });
    }, 5); return turn; }; return client;
  } }); t.after(f.close);
  await request(f, "/api/home/agent/openings", "POST", { requestId: "bad-output", prompt: "x", date: "2026-10-04", period: "morning" });
  const outcome = await eventually(async () => { const value = await request(f, "/api/home/agent/openings/bad-output"); return value.body.status === "uncertain" ? value : null; });
  assert.match(outcome.body.reason, /required JSON result/);
});

test("activity preserves user and final-answer source dates and reports partial coverage", async (t) => {
  const f = await fixture({
    backgroundThreadIds: new Set(["job-thread"]),
    listSessions: async () => [{ id: "good", title: "Good", updatedAt: "2026-10-04T10:00:00Z" }, { id: "bad", updatedAt: "2026-10-04T09:00:00Z" }, { id: "job-thread" }],
    readTurnPage: async (id) => { if (id === "bad") throw new Error("offline"); return { data: [{ id: "t1", status: "completed", startedAt: "2026-10-04T08:00:00Z", completedAt: "2026-10-04T08:05:00Z", items: [{ type: "userMessage", content: [{ type: "text", text: "question" }] }, { type: "agentMessage", phase: "commentary", text: "skip" }, { type: "agentMessage", phase: "final_answer", text: "answer" }] }] }; },
  }); t.after(f.close);
  const response = await request(f, "/api/home/agent/activity?from=2026-10-04T07:00:00Z&to=2026-10-04T09:00:00Z");
  assert.equal(response.status, 200); assert.equal(response.body.coverage.status, "partial");
  assert.deepEqual(response.body.items.map((item) => [item.author, item.text, item.occurredAt]), [["assistant", "answer", "2026-10-04T08:05:00.000Z"], ["user", "question", "2026-10-04T08:00:00.000Z"]]);
});

test('pure generated openings cannot crowd real conversations out of the activity budget', async t => {
  const f = await fixture(); t.after(f.close);
  const records = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`job-${i}`, { requestId: `job-${i}`, status: 'completed', threadId: `generated-${i}`, turnId: `initial-${i}`, date: '2026-10-04', period: 'morning' }]));
  await writeFile(f.statePath, JSON.stringify({ records }));
  const app = express();
  registerPersonalAgentGateway(app, {
    createClient: () => { throw Error('activity must not start a client'); }, statePath: f.statePath,
    listSessions: async () => [...Array.from({ length: 12 }, (_, i) => ({ id: `generated-${i}`, updatedAt: '2026-10-04T09:00:00Z' })), { id: 'real-thread', updatedAt: '2026-10-04T08:00:00Z' }],
    readTurnPage: async id => ({ data: [{ id: id === 'real-thread' ? 'real-turn' : 'initial-'+id.split('-').at(-1), status: 'completed', startedAt: '2026-10-04T08:00:00Z', items: [{ type: 'userMessage', content: [{ type: 'text', text: id === 'real-thread' ? 'real user experience' : 'machine input' }] }] }] }),
  });
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/home/agent/activity?from=2026-10-04T07:00:00Z&to=2026-10-04T10:00:00Z`);
  const result = await response.json();
  assert.deepEqual(result.items.map(item => item.text), ['real user experience']);
  assert.equal(result.coverage.scanned, 13); assert.equal(result.coverage.selected, 1);
  assert.equal(result.coverage.candidateLimit, 36);
});

test("activity retains user input from failed turns and uses a half-open date range", async (t) => {
  const f = await fixture({
    listSessions: async () => [{ id: "thread", title: "Thread" }],
    readTurnPage: async () => ({ data: [
      { id: "failed", status: "failed", startedAt: "2026-10-04T23:59:00Z", items: [{ type: "userMessage", createdAt: "2026-10-04T23:59:30Z", content: [{ type: "text", text: "keep me" }] }, { type: "agentMessage", phase: "final_answer", text: "do not show" }] },
      { id: "midnight", status: "completed", startedAt: "2026-10-05T00:00:00Z", completedAt: "2026-10-05T00:00:01Z", items: [{ type: "userMessage", createdAt: "2026-10-05T00:00:00Z", content: [{ type: "text", text: "next day" }] }] },
    ] }),
  }); t.after(f.close);
  const response = await request(f, "/api/home/agent/activity?from=2026-10-04T00:00:00Z&to=2026-10-05T00:00:00Z");
  assert.deepEqual(response.body.items.map((item) => [item.author, item.text, item.status]), [["user", "keep me", "failed"]]);
});

test('a recovered exact failed turn becomes a durable known failure without resubmission', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opening-failed-recovery-'));
  const statePath = path.join(root, 'ledger.json');
  await writeFile(statePath, JSON.stringify({ records: { original: { requestId: 'original', fingerprint: 'x', status: 'running', threadId: 'thread', turnId: 'exact-turn' } } }));
  const app = express(); app.use(express.json()); let reads = 0, created = 0;
  registerPersonalAgentGateway(app, { statePath, createClient: () => { created++; return new FakeClient(); }, listSessions: async () => [], readTurnPage: async () => { reads++; return { data: [{ id: 'exact-turn', status: 'failed', error: { message: 'known provider failure' } }] }; } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/api/home/agent/openings/original`;
  const result = await (await fetch(url)).json();
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'known provider failure');
  assert.equal((await (await fetch(url)).json()).status, 'failed');
  assert.equal(reads, 1); assert.equal(created, 0);
});
