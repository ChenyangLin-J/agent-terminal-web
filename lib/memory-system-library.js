import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Memory System is a product dependency, supplied independently of the UI package. */
export function loadMemorySystemLibrary(file) {
  if (!['markdown-memory.js', 'legacy-adapter.js', 'change-ledger.js', 'knowledge-actions.js'].includes(file)) throw new Error('Unsupported Memory System library.');
  const root = process.env.AGENT_MEMORY_SYSTEM_ROOT;
  return import(root ? pathToFileURL(path.resolve(root, 'lib', file)).href : new URL(`../../memory-system/lib/${file}`, import.meta.url).href);
}
