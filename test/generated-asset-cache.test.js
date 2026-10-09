import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { registerGeneratedEntryRoutes, setGeneratedAssetCacheHeaders } from '../lib/generated-asset-cache.js';

test('generated content hashes cache immutably while manifest and unversioned startup revalidate', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-generated-cache-'));
  const hashed = ['session-app-2DNXCXIG.js', 'session-app-M47JG2KY.css', 'chunk-W72QAH86.js', 'font-8D5G1E2F.woff2'];
  const unversioned = ['manifest.json', 'session-app.js', 'session-app.css', 'startup.js', 'index.html', 'chunk-deadbeef.html', 'session-app-deadbeef00.js'];
  await Promise.all([...hashed, ...unversioned].map(name => writeFile(path.join(root, name), 'fixture')));
  const app = express(); app.use('/generated', express.static(root, { setHeaders: setGeneratedAssetCacheHeaders }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  for (const name of [...hashed, ...unversioned]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/generated/${name}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), hashed.includes(name) ? 'public, max-age=31536000, immutable' : ['manifest.json', 'index.html'].includes(name) ? 'no-cache' : 'public, max-age=0');
    await response.text();
  }
});

test('entry routes serve activated HTML, resolve compatibility assets per request and fail closed before a build', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-generated-entry-'));
  const app = express(); registerGeneratedEntryRoutes(app, root);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const request = pathname => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { redirect: 'manual' });
  for (const url of ['/', '/index.html', '/generated/session-app.js', '/generated/session-app.css']) assert.equal((await request(url)).status, 503);
  await writeFile(path.join(root, 'index.html'), '<script src="/generated/session-app-ABCDEFGH.js"></script>');
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ js: '/generated/session-app-ABCDEFGH.js', css: '/generated/session-app-12345678.css' }));
  for (const url of ['/', '/index.html']) {
    const response = await request(url); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.match(await response.text(), /session-app-ABCDEFGH\.js/);
  }
  const javascript = await request('/generated/session-app.js');
  assert.equal(javascript.status, 307); assert.equal(javascript.headers.get('location'), '/generated/session-app-ABCDEFGH.js');
  assert.equal(javascript.headers.get('cache-control'), 'no-cache');
  assert.equal((await request('/generated/session-app.css')).headers.get('location'), '/generated/session-app-12345678.css');
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ js: '/generated/session-app-IJKLMNOP.js' }));
  assert.equal((await request('/generated/session-app.js')).headers.get('location'), '/generated/session-app-IJKLMNOP.js');
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ js: 'https://outside.invalid/session-app-ABCDEFGH.js' }));
  assert.equal((await request('/generated/session-app.js')).status, 503);
});
