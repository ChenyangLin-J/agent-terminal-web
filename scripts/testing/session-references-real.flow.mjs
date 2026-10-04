import assert from 'node:assert/strict';
export const metadata = { name: 'real-session-references', profiles: ['desktop', 'mobile'] };
export default async function ({ page, evidence, baseUrl, profile }) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const list = await page.request.get(`${baseUrl}/api/platform/sessions`).then(response => response.json());
  const target = list.sessions.find(session => session.title === '测试');
  const source = list.sessions.find(session => session.id !== target?.id && session.title.includes('历史有哪些session'));
  assert.ok(source?.reference && target?.reference);
  await page.goto(`${baseUrl}/?attach=${source.id}`);
  const composer = page.locator('.cwu-composer textarea');
  await composer.waitFor();
  await composer.fill('请参考这个会话');
  const toggle = page.locator('.cwu-browser-list-toggle');
  await evidence.chapter('真实会话引用', { description: `${profile} · 真实 Codex 历史，仅验证引用与草稿，不发送模型请求` });
  if (profile === 'desktop') {
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const row = page.locator('.cwu-browser-row').filter({ hasText: '测试' });
    assert.equal(await row.getAttribute('draggable'), 'true');
    await row.dragTo(page.locator('.cwu-composer'));
  } else {
    await composer.fill('请参考这个会话\n@测试');
    await page.getByRole('listbox', { name: '选择 Session' }).getByRole('option').filter({ hasText: '测试' }).click();
  }
  await page.getByLabel('已引用 Sessions').getByText('测试', { exact: true }).waitFor();
  await evidence.checkpoint('真实会话已加入 Composer');
  const resolved = await page.request.post(`${baseUrl}/api/platform/session-references/resolve`, { data: { sourceThreadId: source.reference.threadId, references: [target.reference] } }).then(response => response.json());
  assert.equal(resolved.references[0].threadId, target.reference.threadId);
  assert.equal(resolved.references[0].unavailable, false);
  await page.reload();
  await page.getByLabel('已引用 Sessions').getByText('测试', { exact: true }).waitFor();
  assert.equal((await composer.inputValue()).trim(), '请参考这个会话');
  await evidence.checkpoint('刷新后草稿和引用保留');
  await page.getByRole('button', { name: '移除 Session 引用：测试', exact: true }).click();
  assert.equal(await page.getByLabel('已引用 Sessions').count(), 0);
  await evidence.checkpoint('移除引用不影响正文');
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
