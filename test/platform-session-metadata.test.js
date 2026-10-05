import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionMetadataReader } from '../lib/platform-session-metadata.js';

test('shared metadata deduplicates model/config reads and scopes config by cwd', async () => {
  let models = 0, configs = 0, clock = 0;
  const reader = createSessionMetadataReader({ now: () => clock, ttlMs: 10, withClient: async run => run({
    listModels: async () => { models++; return { data: [{ id: 'configured' }] }; },
    readConfig: async ({ cwd }) => { configs++; return { config: { model: cwd } }; },
  }) });
  const values = await Promise.all([reader.config('/a'), reader.config('/a'), reader.config('/b'), reader.models(), reader.models()]);
  assert.deepEqual(values.slice(0, 3).map(value => value.model), ['/a', '/a', '/b']);
  assert.equal(configs, 2); assert.equal(models, 1);
  await reader.config('/a'); assert.equal(configs, 2);
  clock = 11; await reader.config('/a'); assert.equal(configs, 3);
});

test('metadata timeout is bounded and the next read recovers', async () => {
  let blocked = true;
  const reader = createSessionMetadataReader({ timeoutMs: 10, withClient: async run => blocked ? new Promise(() => {}) : run({ readConfig: async () => ({ config: { model: 'recovered' } }) }) });
  await assert.rejects(reader.config('/a'), /timed out/);
  blocked = false;
  assert.equal((await reader.config('/a')).model, 'recovered');
});
