import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { registerPlatformFilePreviewRoutes } from '../lib/platform-file-preview.js';

async function fixture(t, authenticated = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-file-preview-'));
  const docs = path.join(root, 'docs');
  await fs.mkdir(docs);
  await fs.writeFile(path.join(docs, 'note.md'), '# Note\n\n![pixel](pixel.png)\n');
  await fs.writeFile(path.join(docs, 'page.html'), '<script>parent.document.title = \"unsafe\"</script>');
  await fs.writeFile(path.join(docs, 'code.js'), 'const value = 1;\n');
  await fs.writeFile(path.join(docs, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-file-outside-'));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(docs, 'escape.txt'));
  const app = express();
  registerPlatformFilePreviewRoutes(app, { workspaceRoot: root, isAuthenticated: async () => authenticated });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  return { base, root };
}

test('authenticated descriptor classifies Markdown and code and resolves relative links from a document', async (t) => {
  const { base, root } = await fixture(t);
  const markdown = await fetch(`${base}/api/platform/file-preview?${new URLSearchParams({ href: path.join(root, 'docs/note.md') })}`);
  assert.equal(markdown.status, 200);
  const descriptor = await markdown.json();
  assert.equal(descriptor.format, 'markdown');
  assert.equal(descriptor.content, '# Note\n\n![pixel](pixel.png)\n');
  assert.match(descriptor.downloadUrl, /^\/api\/platform\/file-resource\?/);

  const code = await fetch(`${base}/api/platform/file-preview?${new URLSearchParams({ href: './code.js', base: path.join(root, 'docs/note.md') })}`);
  assert.equal(code.status, 200);
  assert.equal((await code.json()).format, 'code');
  const fromDirectory = await fetch(`${base}/api/platform/file-preview?${new URLSearchParams({ href: './code.js', base: path.join(root, 'docs') })}`);
  assert.equal(fromDirectory.status, 200);
  assert.equal((await fromDirectory.json()).format, 'code');
});

test('raw resources keep their media type and never return a decorated HTML viewer', async (t) => {
  const { base, root } = await fixture(t);
  const query = new URLSearchParams({ href: path.join(root, 'docs/pixel.png') });
  const descriptor = await (await fetch(`${base}/api/platform/file-preview?${query}`)).json();
  assert.equal(descriptor.format, 'image');
  const resource = await fetch(new URL(descriptor.src, base));
  assert.equal(resource.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await resource.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
});

test('preview routes enforce authentication and the realpath workspace boundary', async (t) => {
  const denied = await fixture(t, false);
  const unauthenticated = await fetch(`${denied.base}/api/platform/file-preview?href=${encodeURIComponent(path.join(denied.root, 'docs/note.md'))}`);
  assert.equal(unauthenticated.status, 401);

  const allowed = await fixture(t);
  const escaped = await fetch(`${allowed.base}/api/platform/file-preview?href=${encodeURIComponent(path.join(allowed.root, 'docs/escape.txt'))}`);
  assert.equal(escaped.status, 404);
  assert.doesNotMatch(await escaped.text(), /secret/);
});

test('HTML uses a sandbox descriptor while the raw endpoint cannot run same-origin scripts', async (t) => {
  const { base, root } = await fixture(t);
  const query = new URLSearchParams({ href: path.join(root, 'docs/page.html') });
  const descriptor = await (await fetch(`${base}/api/platform/file-preview?${query}`)).json();
  assert.equal(descriptor.format, 'html');
  assert.match(descriptor.content, /<script>/);
  const raw = await fetch(`${base}/api/platform/file-resource?${query}`);
  assert.match(raw.headers.get('content-type'), /^text\/plain/);
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  const download = await fetch(new URL(descriptor.downloadUrl, base));
  assert.match(download.headers.get('content-disposition'), /^attachment/);
});
