import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeHistoryProcessFixture } from './history-process-fixture.mjs';
import { extractSessionConversationFromJsonl } from '../../lib/session-preview.js';
import { extractSessionProcessFromJsonl } from '../../lib/session-process.js';

export const metadata = { name: 'historical-session-process', profiles: ['desktop'] };

export default async function ({ page, evidence, baseUrl }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-process-flow-'));
  const fixtures = await Promise.all([1, 2, 3].map(index => writeHistoryProcessFixture(directory, { index, nativeEvents: index === 3 })));
  const errors = [], unexpected = [], processReads = [];
  let previewReads = 0;
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let body;
      if (url.pathname === '/api/platform/sessions') body = { sessions: fixtures.map(f => ({ id: `history:${f.threadId}`, sessionId: f.threadId, title: f.title, historical: true, updatedAt: new Date().toISOString() })) };
      else if (url.pathname.startsWith('/api/session-preview/')) {
        previewReads++;
        const fixture = fixtures.find(f => url.pathname.endsWith(f.threadId));
        body = { cwd: '/synthetic', conversation: await extractSessionConversationFromJsonl(fixture.file, { limit: 1, offset: Number(url.searchParams.get('before') || 0) }) };
      } else if (url.pathname.includes('/process/')) {
        const [, threadId, turnId] = url.pathname.match(/\/threads\/([^/]+)\/process\/(.+)$/) || [];
        const fixture = fixtures.find(f => f.threadId === threadId);
        if (!fixture?.turnIds.includes(turnId)) {
          errors.push('Invalid historical turn.');
          await route.fulfill({ status: 400, json: { error: 'Invalid historical turn.' } }); return;
        }
        processReads.push(turnId);
        body = { items: await extractSessionProcessFromJsonl(fixture.file, turnId) };
      } else if (url.pathname === '/api/platform/session-metadata') body = { models: [] };
      else if (/\/api\/codex-sessions\/[^/]+\/viewed$/.test(url.pathname)) body = {};
      else if (url.pathname === '/api/projects') body = { projects: [] };
      else if (url.pathname === '/api/codex-updates') body = { notices: [] };
      else if (url.pathname === '/api/memories/status') body = {};
      else { unexpected.push(url.pathname); await route.fulfill({ status: 404, json: { error: 'Unconfigured synthetic endpoint' } }); return; }
      await route.fulfill({ json: body });
    });
    await page.goto(baseUrl);
    for (const [index, fixture] of fixtures.entries()) {
      await evidence.chapter(`${fixture.title} · 历史执行记录`, { description: '实际构建页面 · 合成历史数据' });
      const row = page.locator('.cwu-browser-row-main').filter({ hasText: fixture.title });
      await row.waitFor();
      await evidence.action('打开历史会话', row, locator => locator.click());
      await page.getByText(`${fixture.title}：最新的回复`, { exact: true }).waitFor();
      const toggle = page.locator('.cwu-technical-toggle').last();
      assert.match(await toggle.innerText(), /进度说明/);
      await evidence.action('展开执行记录', toggle, locator => locator.click());
      await page.locator('.cwu-process-card.type-command').waitFor();
      assert.equal(await page.locator('.cwu-process-card.type-assistant').count(), 1);
      await evidence.action('查看命令详情', page.getByRole('button', { name: '查看详情：命令', exact: true }), locator => locator.click());
      await page.getByText('目录：/synthetic/lab', { exact: true }).waitFor();
      await evidence.action('查看命令输出', page.getByRole('button', { name: '查看输出：命令', exact: true }), locator => locator.click());
      await page.getByText(`synthetic-command-output-${index + 1}-1`, { exact: true }).waitFor();
      await evidence.action('查看工具详情', page.getByRole('button', { name: '查看详情：工具', exact: true }), locator => locator.click());
      await page.getByText('{"path":"/synthetic/readme.md"}', { exact: true }).waitFor();
      await evidence.action('查看工具输出', page.getByRole('button', { name: '查看输出：工具', exact: true }), locator => locator.click());
      await page.getByText(`synthetic-tool-output-${index + 1}-1`, { exact: true }).waitFor();
      await evidence.checkpoint('命令和工具详情、输出可展开');
      if (index === 0) {
        const before = previewReads;
        await page.waitForTimeout(5500);
        assert.ok(previewReads > before);
        assert.equal(await page.locator('.cwu-process-card.type-assistant').count(), 1);
        await page.getByText(`synthetic-tool-output-${index + 1}-1`, { exact: true }).waitFor();
        await evidence.checkpoint('自动刷新后输出保留，进度无重复');
      }
      await evidence.action('加载更早消息', page.getByRole('button', { name: '查看更早消息', exact: true }), locator => locator.click());
      await page.getByText(`${fixture.title}：更早的回复`, { exact: true }).waitFor();
      await evidence.action('展开更早的执行记录', page.locator('.cwu-technical-toggle').filter({ hasText: '进度说明' }).last(), locator => locator.click());
      await page.locator('.cwu-process-card.type-command').nth(1).waitFor();
      assert.equal(await page.locator('.cwu-process-card.type-assistant').count(), 2);
      await evidence.checkpoint('更早轮次也能读取执行记录');
      assert.equal(await row.count(), 1);
    }
    assert.equal(processReads.length, 6);
    await page.reload();
    await page.getByText('研究记录：最新的回复', { exact: true }).waitFor();
    // Shared UI restores expansion state, while process data is read on demand.
    const refreshedToggle = page.locator('.cwu-technical-toggle').last();
    if (await refreshedToggle.getAttribute('aria-expanded') === 'true') await refreshedToggle.click();
    await evidence.action('页面刷新后重新展开记录', refreshedToggle, locator => locator.click());
    await page.locator('.cwu-process-card.type-command').waitFor();
    await evidence.checkpoint('页面刷新后仍能展开历史记录');
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
