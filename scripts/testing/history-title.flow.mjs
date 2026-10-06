import assert from 'node:assert/strict';

export const metadata = { name: 'historical-session-title', profiles: ['desktop'] };

export default async function ({ page, evidence, baseUrl }) {
  const title = 'Task: 晚间 Goal: 回看当天一件具体经历';
  const threadId = 'synthetic-evening';
  const errors = [];
  const unexpected = [];
  let previewReads = 0;
  page.on('pageerror', error => errors.push(error.message));
  // Serve the real built application with synthetic API responses only.
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === '/api/platform/sessions') body = { sessions: [{ id: `history:${threadId}`, sessionId: threadId, title, historical: true, updatedAt: new Date().toISOString() }] };
    else if (url.pathname === `/api/session-preview/${threadId}`) {
      previewReads++;
      const earlier = url.searchParams.has('before');
      body = { cwd: '/synthetic', conversation: { turns: [{ id: earlier ? 'older' : 'latest', user: earlier ? '更早的问题' : title, assistant: [{ text: earlier ? '更早的回复' : '晚间回顾已完成。' }] }], nextCursor: earlier ? null : '10', hasEarlier: !earlier } };
    } else if (url.pathname === '/api/platform/session-metadata') body = { models: [] };
    else if (url.pathname === `/api/codex-sessions/${threadId}/viewed`) body = {};
    else if (url.pathname === '/api/projects') body = { projects: [] };
    else if (url.pathname === '/api/codex-updates') body = { notices: [] };
    else if (url.pathname === '/api/memories/status') body = {};
    else { unexpected.push(url.pathname); await route.fulfill({ status: 404, json: { error: 'Unconfigured synthetic endpoint' } }); return; }
    await route.fulfill({ json: body });
  });
  await page.goto(baseUrl);
  const row = page.locator('.cwu-browser-row-main').filter({ hasText: title });
  const heading = page.locator('.cwu-session-header').getByRole('heading', { name: title, exact: true });
  await row.waitFor();
  await evidence.chapter('历史会话标题保留', { description: '构建后页面 · 合成晚间会话' });
  await evidence.checkpoint('打开前：侧栏保留 Task 晚间原标题');
  await evidence.action('打开晚间历史会话', row, locator => locator.click());
  await heading.waitFor();
  await page.getByText('晚间回顾已完成。', { exact: true }).waitFor();
  assert.equal(await row.count(), 1);
  await evidence.checkpoint('打开后：侧栏与详情标题一致');
  const beforeRefresh = previewReads;
  await page.waitForTimeout(5500);
  assert.equal(previewReads, beforeRefresh, 'Completed historical preview does not poll');
  assert.equal(await row.count(), 1);
  assert.equal(await heading.count(), 1);
  await evidence.checkpoint('空闲等待后：原标题保持不变');
  await evidence.action('加载更早消息', page.getByRole('button', { name: '查看更早消息', exact: true }), locator => locator.click());
  await page.getByText('更早的回复', { exact: true }).waitFor();
  assert.equal(await row.count(), 1);
  assert.equal(await heading.count(), 1);
  await evidence.checkpoint('更早消息加载后：原标题保持不变');
  await page.reload();
  await heading.waitFor();
  assert.equal(await row.count(), 1);
  await evidence.checkpoint('页面刷新后：原标题保持不变');
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
}
