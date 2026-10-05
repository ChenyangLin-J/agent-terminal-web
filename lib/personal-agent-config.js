import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const TOOL_IDS = Object.freeze(['personal.context.read', 'home.records.search', 'vault.notes.search', 'vault.notes.read', 'bookmarks.search', 'bookmarks.read', 'agent.sessions.search', 'agent.sessions.read', 'home.show_session_action', 'home.show_sources', 'home.show_tibetan']);
export const PRESENTATION_IDS = Object.freeze(TOOL_IDS.slice(8));
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
const string = (value, max) => typeof value === 'string' && value.trim() && Array.from(value).length <= max;
export function defaultPersonalConfig() {
  return { revision: 0, tasks: [
    { id: 'morning', name: '晨间', goal: '接续一两件今天值得继续的事', instructions: '从昨日与近期真实经历中接续今天；按需联系计划或收藏。简短自然，缺少材料时说明读取范围，不推断没有实践。', allowedToolIds: [...TOOL_IDS] },
    { id: 'evening', name: '晚间', goal: '回看当天一件具体经历', instructions: '回看当天一件具体经历，感受使用本人表述，不强迫成功总结或逐项盘问。简短自然，区分用户原话与 Agent 结果。', allowedToolIds: [...TOOL_IDS] },
  ], preferences: { 'home.show_tibetan': 'required', 'home.show_sources': 'preferred', 'home.show_session_action': 'optional' } };
}
export function validatePersonalConfig(value) {
  if (!keys(value, ['revision', 'tasks', 'preferences']) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.tasks) || value.tasks.length !== 2 || !keys(value.preferences, PRESENTATION_IDS) || PRESENTATION_IDS.some(id => !['required', 'preferred', 'optional'].includes(value.preferences[id]))) return false;
  const ids = new Set();
  for (const task of value.tasks) {
    if (!keys(task, ['id', 'name', 'goal', 'instructions', 'allowedToolIds']) || !['morning', 'evening'].includes(task.id) || ids.has(task.id) || !string(task.name, 80) || !string(task.goal, 1000) || !string(task.instructions, 8000) || !Array.isArray(task.allowedToolIds) || task.allowedToolIds.length > TOOL_IDS.length || new Set(task.allowedToolIds).size !== task.allowedToolIds.length || task.allowedToolIds.some(id => !TOOL_IDS.includes(id))) return false;
    ids.add(task.id);
    if (PRESENTATION_IDS.some(id => value.preferences[id] === 'required' && !task.allowedToolIds.includes(id))) return false;
  }
  return true;
}
export function createPersonalConfigStore(file) {
  let writes = Promise.resolve();
  async function read() {
    try { const value = JSON.parse(await fs.readFile(file, 'utf8')); if (!validatePersonalConfig(value)) throw new Error('Invalid personal config.'); return value; }
    catch (error) { if (error.code === 'ENOENT') { const defaults = defaultPersonalConfig(); await atomicWrite(defaults); return defaults; } throw error; }
  }
  async function atomicWrite(value) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.chmod(temporary, 0o600); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  function serialize(operation) { const result = writes.then(operation); writes = result.catch(() => {}); return result; }
  return { read: () => serialize(read), save(value) {
    return serialize(async () => {
      if (!validatePersonalConfig(value)) throw Object.assign(new Error('Invalid personal config.'), { status: 400 });
      const current = await read();
      if (value.revision !== current.revision) throw Object.assign(new Error('Personal config revision conflict.'), { status: 409 });
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Personal config revision exhausted.');
      const next = structuredClone({ ...value, revision: current.revision + 1 });
      await atomicWrite(next);
      return next;
    });
  } };
}
