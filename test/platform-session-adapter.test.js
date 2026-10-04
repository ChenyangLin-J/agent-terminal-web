import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyAgentWebEvent, normalizeSnapshot, previewSnapshot } from "../public/platform-agent-web-adapter.js";
test('historical preview exposes each turn for lazy process loading without a live Runtime',()=>{
 const snapshot=previewSnapshot('history:thread-1',{conversation:{turns:[{id:'turn-1',user:'question',assistant:[{text:'answer'}]}]}});
 assert.deepEqual(snapshot.technicalDetailsAvailable,['turn-1']);
 assert.deepEqual(snapshot.technicalItems,[]);
 assert.equal(snapshot.threadId,'thread-1');
});

test("Platform adapter retains Agent Web session and Codex thread identities", () => {
  const snapshot = normalizeSnapshot({
    session: { id: "web-a", sessionId: "thread-a", title: "Existing", outputRevision: 8, turnState: { turnId: "turn-a" } },
    transcript: { items: [{ id: "item-a" }] },
  });
  assert.equal(snapshot.sessionId, "web-a");
  assert.equal(snapshot.threadId, "thread-a");
  assert.equal(snapshot.activeTurnId, "turn-a");
  assert.equal(snapshot.revision, 8);
});

test("Platform adapter ignores a lower replay revision and targets request state", () => {
  const snapshot = { revision: 12, pendingRequests: [{ requestId: "old" }], items: [] };
  const replayed = applyAgentWebEvent(snapshot, { type: "replay", payload: { revision: 7 } });
  assert.equal(replayed.revision, 12);
  const requested = applyAgentWebEvent(replayed, { type: "agent-request", payload: { requestId: "request-a", turnId: "turn-a" } });
  assert.deepEqual(requested.pendingRequests.map((request) => request.requestId), ["old", "request-a"]);
  const resolved = applyAgentWebEvent(requested, { type: "agent-request-resolved", payload: { requestId: "request-a" } });
  assert.deepEqual(resolved.pendingRequests.map((request) => request.requestId), ["old"]);
});

test('updating a process item retains its original chronological position', () => {
  const snapshot = normalizeSnapshot({ session: { id: 'web-a' }, items: [{ id: 'command-a', type: 'command', text: 'run', turnId: 'turn-a' }, { id: 'comment-b', type: 'assistant', text: 'next', phase: 'commentary', turnId: 'turn-a' }] });
  const updated = applyAgentWebEvent(snapshot, { type: 'app-transcript-upsert', payload: { id: 'command-a', type: 'command', text: 'run', output: 'done', turnId: 'turn-a' } });
  assert.deepEqual(updated.items.map(item => item.id), ['command-a', 'comment-b']);
});

test("server persists bounded idempotency receipts and exposes the Platform snapshot", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const routes = await readFile(new URL('../lib/platform-session-routes.js', import.meta.url), 'utf8');
  assert.match(routes, /app\.get\('\/api\/platform\/sessions\/:id'/);
  assert.match(routes, /app\.post\('\/api\/platform\/sessions'/);
  assert.match(server, /operationReceipts: serializableSessionOperationReceipts/);
  assert.match(server, /isIdempotentSessionMessage\(message\)/);
  assert.match(server, /replayed: true/);
});

test("candidate build never silently bundles the stable package without Session Host", async () => {
  const script = await readFile(new URL("../scripts/build-session-app.mjs", import.meta.url), "utf8");
  assert.match(script, /AGENT_PLATFORM_CANDIDATE/);
  assert.match(script, /src", "session-host\.js/);
  assert.match(script, /entryNames: "session-app"/);
});

test("entry uses the public UI callback shapes and ships its shared styles", async () => {
  const entry = await readFile(new URL("../public/platform-agent-web-entry.jsx", import.meta.url), "utf8");
  assert.match(entry, /\{ prompt, mode, attachments \}/);
  assert.match(entry, /\{ token, decision, answers \}/);
  assert.match(entry, /\{ prompt, turnId, messageId, attachments \}/);
  assert.match(entry, /@agent-workbench\/platform\/styles\.css/);
  assert.match(entry, /katex\/dist\/katex\.min\.css/);
  assert.match(entry, /onUploadAttachments: uploadAgentWebAttachments/);
});
