import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createSessionHostController } from '@agent-workbench/platform/session-host';
import { registerPlatformSessionRoutes } from '../lib/platform-session-routes.js';
import { extractSessionConversationFromJsonl } from '../lib/session-preview.js';
import { extractSessionProcessFromJsonl } from '../lib/session-process.js';
import { createAgentWebSessionAdapter, normalizeSnapshot } from '../public/platform-agent-web-adapter.js';
import { writeHistoryProcessFixture } from '../scripts/testing/history-process-fixture.mjs';

test('disk history uses native process IDs through the actual route, with refresh and pagination', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-process-adapter-'));
  const fixtures = await Promise.all([1, 2, 3].map(index => writeHistoryProcessFixture(directory, { index, nativeEvents: index === 3 })));
  const app = express();
  registerPlatformSessionRoutes(app, {
    validThread: id => fixtures.some(f => f.threadId === id),
    validTurn: id => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id),
    readProcess: ({ sessionId }, turnId) => extractSessionProcessFromJsonl(fixtures.find(f => f.threadId === sessionId).file, turnId),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  const processRequests = [];
  globalThis.fetch = async raw => {
    const url = new URL(raw, origin);
    if (url.pathname === '/api/platform/sessions') return Response.json({ sessions: fixtures.map(f => ({ id: `history:${f.threadId}`, sessionId: f.threadId, title: f.title })) });
    if (url.pathname.startsWith('/api/session-preview/')) {
      const fixture = fixtures.find(f => url.pathname.endsWith(f.threadId));
      return Response.json({ conversation: await extractSessionConversationFromJsonl(fixture.file, { limit: 1, offset: Number(url.searchParams.get('before') || 0) }) });
    }
    if (url.pathname === '/api/platform/session-metadata') return Response.json({});
    if (url.pathname === '/api/platform/sessions/web-restored') return Response.json({
      session: { id: 'web-restored', sessionId: fixtures[0].threadId, ready: true, turnState: { active: true, turnId: fixtures[0].turnIds[1] } },
      items: [
        { id: 'native-completed-progress', type: 'assistant', phase: 'commentary', text: 'Task: 晚间：检查执行结果 0', turnId: fixtures[0].turnIds[0] },
        { id: 'native-current-progress', type: 'assistant', phase: 'commentary', text: 'Task: 晚间：检查执行结果 1', turnId: fixtures[0].turnIds[1], status: 'inProgress' },
      ],
    });
    processRequests.push(url.pathname);
    return originalFetch(url);
  };
  const adapter = createAgentWebSessionAdapter({ clientId: 'history-process-regression' });
  t.after(async () => {
    adapter.dispose(); globalThis.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await adapter.listSessions();
  for (const fixture of fixtures) {
    const id = `history:${fixture.threadId}`;
    const latest = fixture.turnIds[1];
    const snapshot = await adapter.readSession(id);
    assert.deepEqual(snapshot.technicalDetailsAvailable, [latest]);
    assert.equal(snapshot.title, fixture.title);
    assert.equal(snapshot.technicalItems[0].title, '进度说明');
    if (fixture !== fixtures[2]) assert.equal(snapshot.messages[0].id, 'disk-response-user-2-user');
    await adapter.execute(id, 'loadTechnicalDetails', { turnId: latest });
    for (const refreshed of [await adapter.readSession(id), await adapter.readSession(id)]) {
      assert.equal(refreshed.messages.length, 2);
      assert.equal(refreshed.technicalItems.filter(item => item.type === 'assistant').length, 1);
      assert.deepEqual(refreshed.technicalItems.map(item => item.type), ['assistant', 'command', 'tool']);
      assert.equal(refreshed.technicalItems[1].detail, '目录：/synthetic/lab');
      assert.equal(refreshed.technicalItems[1].output, `synthetic-command-output-${fixtures.indexOf(fixture) + 1}-1`);
    }
    const earlier = await adapter.loadHistory(id);
    assert.deepEqual(earlier.technicalDetailsAvailable, fixture.turnIds);
    assert.equal(earlier.messages.length, 4);
    assert.equal(earlier.technicalItems.filter(item => item.turnId === latest).length, 3);
    assert.equal(earlier.hasEarlierTurns, false);
    const focused = await adapter.readSession(id);
    assert.equal(focused.messages.length, 4, 'focus refresh retains already loaded earlier pages');
    assert.equal(focused.hasEarlierTurns, false);
    assert.equal(focused.turnsCursor, null);
    await adapter.execute(id, 'loadTechnicalDetails', { turnId: fixture.turnIds[0] });
    assert.equal((await adapter.loadHistory(id)).technicalItems.length, 6);
  }
  assert.equal(processRequests.length, 6);
  assert.ok(processRequests.every(url => !url.includes('disk-response-user')));
  const freshAdapter = createAgentWebSessionAdapter({ clientId: 'history-process-controller' });
  const controller = createSessionHostController({ adapter: freshAdapter });
  t.after(() => { controller.dispose(); freshAdapter.dispose(); });
  await controller.select(`history:${fixtures[0].threadId}`);
  assert.equal(controller.getSnapshot().session.technicalItems.length, 1);
  await controller.execute('loadTechnicalDetails', { turnId: fixtures[0].turnIds[1] });
  assert.equal(controller.getSnapshot().session.technicalItems.filter(item => item.turnId === fixtures[0].turnIds[1]).length, 3);
  await freshAdapter.execute('web-restored', 'loadTechnicalDetails', { turnId: fixtures[0].turnIds[0] });
  const restored = await freshAdapter.readSession('web-restored');
  assert.equal(restored.technicalItems.filter(item => item.type === 'assistant' && item.turnId === fixtures[0].turnIds[0]).length, 1);
  assert.equal(restored.technicalItems.find(item => item.id === 'native-current-progress').status, 'inProgress');
});


test('historical viewed images use authenticated workspace resources without an attached web Session', () => {
  const image = {id:'old-image',type:'tool',label:'查看图片',text:'/workspace/uploads/image.png',turnId:'old-turn'};
  for (const session of [{}, {id:'history:thread'}]) {
    const view=normalizeSnapshot({session,items:[image]});
    const media=view.technicalItems[0].media[0];
    assert.equal(media.name,'image.png');
    assert.equal(media.src,'/api/platform/file-resource?href=%2Fworkspace%2Fuploads%2Fimage.png');
    assert.doesNotMatch(media.src,/undefined|history%3A/);
  }
  const live=normalizeSnapshot({session:{id:'web-live'},items:[image]});
  assert.equal(live.technicalItems[0].media[0].src,'/api/session-image/web-live/old-image?turnId=old-turn');
});
