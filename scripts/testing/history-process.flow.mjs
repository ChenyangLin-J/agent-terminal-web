import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeHistoryProcessFixture } from './history-process-fixture.mjs';
import { extractSessionConversationFromJsonl } from '../../lib/session-preview.js';
import { extractSessionProcessFromJsonl } from '../../lib/session-process.js';

export const metadata = { name: 'historical-session-process', profiles: ['desktop', 'mobile'] };

export default async function ({ page, evidence, baseUrl, profile }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-process-flow-'));
  const fixtures = await Promise.all([1, 2, 3].map(index => writeHistoryProcessFixture(directory, { index, nativeEvents: index === 3 })));
  const errors = [], unexpected = [], processReads = [];
  let previewReads = 0, failedOnce = false;
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
        if (fixture === fixtures[2]) body.transcript = { items: body.conversation.turns.flatMap(turn => [
          { id: `${turn.id}-user`, type: 'user', text: turn.user, turnId: turn.id, historical: true },
          ...turn.assistant.map((item, index) => ({ ...item, id: `native-${turn.id}-${index}`, type: 'assistant', turnId: turn.id, historical: item.phase !== 'commentary' })),
        ]) };
      } else if (url.pathname.includes('/process/')) {
        const [, threadId, turnId] = url.pathname.match(/\/threads\/([^/]+)\/process\/(.+)$/) || [];
        const fixture = fixtures.find(f => f.threadId === threadId);
        if (!fixture?.turnIds.includes(turnId)) {
          errors.push('Invalid historical turn.');
          await route.fulfill({ status: 400, json: { error: 'Invalid historical turn.' } }); return;
        }
        processReads.push(turnId);
        if (fixture === fixtures[1] && !failedOnce) {
          failedOnce = true; await route.fulfill({ status: 500, json: { error: '执行记录暂时无法读取。' } }); return;
        }
        await new Promise(resolve => setTimeout(resolve, 400));
        body = { items: fixture === fixtures[2] && turnId === fixture.turnIds[0] ? [] : await extractSessionProcessFromJsonl(fixture.file, turnId) };
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
      if (profile === 'mobile' && await page.locator('.cwu-browser-list-toggle').getAttribute('aria-expanded') === 'false') await page.locator('.cwu-browser-list-toggle').click();
      await row.waitFor();
      await evidence.action('打开历史会话', row, locator => locator.click());
      await page.getByText(`${fixture.title}：最新的回复`, { exact: true }).waitFor();
      const toggle = page.locator('.cwu-technical-toggle').last();
      assert.match((await toggle.innerText()).trim(), /^›\s*执行记录$/);
      assert.equal(await page.locator('.cwu-process-row').count(), 0);
      const previewBefore = previewReads;
      await evidence.action('展开执行记录', toggle, locator => locator.click());
      if (index === 1) {
        await page.getByRole('alert').getByText('执行记录暂时无法读取。', { exact: true }).waitFor();
        assert.equal(await page.locator('.cwu-process-count').count(), 0);
        await evidence.action('原位重试执行记录', page.getByRole('button', { name: '重试', exact: true }), locator => locator.click());
      }
      await page.getByRole('status').getByText('正在读取执行记录…', { exact: true }).waitFor();
      assert.equal(await page.locator('.cwu-process-count').count(), 0);
      assert.equal(await page.locator('.cwu-process-row').count(), 0);
      await page.getByText('3 项执行记录', { exact: true }).waitFor();
      assert.equal(await page.locator('.cwu-process-row.type-assistant').count(), 1);
      assert.equal(await page.locator('.cwu-process-body').count(), 0);
      assert.equal(previewReads, previewBefore, 'process load does not read the whole session');
      const command = page.locator('.cwu-process-row.type-command .cwu-process-summary');
      await evidence.action('展开命令详情和输出', command, locator => locator.click());
      await page.getByText('目录：/synthetic/lab', { exact: true }).waitFor();
      await page.getByText(`synthetic-command-output-${index + 1}-1`, { exact: true }).waitFor();
      const tool = page.locator('.cwu-process-row.type-tool .cwu-process-summary');
      await evidence.action('展开工具详情和输出', tool, locator => locator.click());
      await page.getByText('{"path":"/synthetic/readme.md"}', { exact: true }).waitFor();
      await page.getByText(`synthetic-tool-output-${index + 1}-1`, { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: /查看详情|查看输出/ }).count(), 0);
      await evidence.checkpoint('两层展开：参数和输出在同一区域');
      const processBefore = processReads.length;
      await evidence.action('收起执行记录', toggle, locator => locator.click());
      await evidence.action('重新展开缓存记录', toggle, locator => locator.click());
      await page.getByText(`synthetic-tool-output-${index + 1}-1`, { exact: true }).waitFor();
      assert.equal(processReads.length, processBefore);
      assert.equal(previewReads, previewBefore);
      if (index === 0) {
        await page.waitForTimeout(5500);
        assert.equal(previewReads, previewBefore, 'completed history has no fixed polling');
        await evidence.checkpoint('反复展开无请求，已完成历史停止轮询');
      }
      await evidence.action('加载更早消息', page.getByRole('button', { name: '查看更早消息', exact: true }), locator => locator.click());
      await page.getByText(`${fixture.title}：更早的回复`, { exact: true }).waitFor();
      const earlierRecord = page.locator('.cwu-message').filter({ hasText: `${fixture.title}：更早的回复` }).locator('xpath=following-sibling::section[1]').locator('.cwu-technical-toggle');
      await evidence.action('展开更早的执行记录', earlierRecord, locator => locator.click());
      if (index === 2) {
        await page.getByText('没有可展示的执行记录。', { exact: true }).waitFor();
        assert.equal(await page.locator('.cwu-process-count').count(), 1);
      } else {
        await page.locator('.cwu-process-row.type-command').nth(1).waitFor();
        assert.equal(await page.locator('.cwu-process-row.type-assistant').count(), 2);
      }
      await evidence.checkpoint('更早轮次也能读取执行记录');
      assert.equal(await row.count(), 1);
    }
    assert.equal(processReads.length, 7);
    const beforeFocus = previewReads;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(600);
    assert.equal(previewReads, beforeFocus + 1);
    await page.getByText('研究记录：更早的回复', { exact: true }).waitFor();
    assert.equal(processReads.length, 7);
    await evidence.checkpoint('重新聚焦补读一次，已加载历史和缓存仍保留');
    await page.reload();
    await page.getByText('研究记录：最新的回复', { exact: true }).waitFor();
    await page.locator('.cwu-process-row.type-command').waitFor();
    assert.equal(await page.locator('.cwu-technical-toggle').last().getAttribute('aria-expanded'), 'true');
    await evidence.checkpoint('刷新恢复展开，缺失数据自动读取');
    const command = page.locator('.cwu-process-row.type-command .cwu-process-summary');
    await command.focus(); await page.keyboard.press('Enter');
    await page.getByText('synthetic-command-output-3-1', { exact: true }).waitFor();
    await page.keyboard.press('Enter');
    assert.equal(await command.getAttribute('aria-expanded'), 'false');
    assert.equal(await command.evaluate(element => element.getBoundingClientRect().height >= 44), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await evidence.checkpoint('键盘展开收起，窄屏无溢出');
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
