/** Bounded, deduplicated product metadata reads over the shared App Server. */
export function createSessionMetadataReader({ withClient, ttlMs = 30_000, timeoutMs = 4_000, now = Date.now }) {
  const cache = new Map();
  function read(key, run) {
    const previous = cache.get(key);
    if (previous?.pending) return previous.pending;
    if (previous && previous.expires > now()) return Promise.resolve(previous.value);
    const entry = { value: previous?.value, expires: 0 };
    let timer;
    const pending = Promise.race([
      Promise.resolve().then(() => withClient(run)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Session metadata timed out.')), timeoutMs); }),
    ]).then(value => { entry.value = value; entry.expires = now() + ttlMs; return value; }, error => {
      // Failed reads retry soon; a stale successful value remains useful.
      entry.expires = now() + 1_000;
      if (entry.value !== undefined) return entry.value;
      cache.delete(key); throw error;
    }).finally(() => { clearTimeout(timer); entry.pending = null; });
    entry.pending = pending; cache.set(key, entry);
    if (cache.size > 100) for (const [id, value] of cache) { if (!value.pending && id !== key) { cache.delete(id); break; } }
    return pending;
  }
  return {
    config: cwd => read(`config:${cwd}`, async client => (await client.readConfig({ cwd, includeLayers: false }))?.config || {}),
    models: () => read('models', async client => (await client.listModels())?.data || []),
  };
}
