import fs from 'node:fs/promises';
import path from 'node:path';

// Synthetic disk formats observed in older and newer Codex histories.
export async function writeHistoryProcessFixture(directory, { index = 1, nativeEvents = false } = {}) {
  const threadId = `019f8d05-7a2d-7f43-a52c-${String(index).padStart(12, '0')}`;
  const turnIds = [1, 2].map(turn => `019f8d05-7a2d-7f43-a52d-${String(index * 10 + turn).padStart(12, '0')}`);
  const title = ['Task: 晚间', '下午讨论', '研究记录'][index - 1];
  const records = [];
  for (const [offset, turnId] of turnIds.entries()) {
    const meta = { turn_id: turnId };
    const response = (type, payload) => records.push({ timestamp: `2026-10-05T10:0${offset}:00.000Z`, type: 'response_item', payload: { type, ...payload, internal_chat_message_metadata_passthrough: meta } });
    const question = `${title}：${offset ? '最新' : '更早'}的问题`;
    if (nativeEvents) records.push({ timestamp: '2026-10-05T10:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: question } });
    response('message', { role: 'user', content: [{ type: 'input_text', text: question }] });
    response('message', { id: `progress-${index}-${offset}`, role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: `${title}：检查执行结果 ${offset}` }] });
    response('function_call', { name: 'exec_command', call_id: `command-${index}-${offset}`, arguments: JSON.stringify({ cmd: 'printf synthetic-output', workdir: '/synthetic/lab' }) });
    response('function_call_output', { call_id: `command-${index}-${offset}`, output: `synthetic-command-output-${index}-${offset}` });
    response('function_call', { name: 'read_file', call_id: `tool-${index}-${offset}`, arguments: JSON.stringify({ path: '/synthetic/readme.md' }) });
    response('function_call_output', { call_id: `tool-${index}-${offset}`, output: `synthetic-tool-output-${index}-${offset}` });
    response('message', { role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: `${title}：${offset ? '最新' : '更早'}的回复` }] });
  }
  const file = path.join(directory, `${threadId}.jsonl`);
  await fs.writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
  return { threadId, turnIds, title, file };
}
