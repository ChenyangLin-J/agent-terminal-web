import assert from 'node:assert/strict';
export const metadata = { name: 'session-draft-lifecycle', profiles: ['desktop', 'mobile'] };
export default async function ({ page, evidence, baseUrl, profile }) {
  const errors = [];
  const creates = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/platform/sessions') creates.push(request.postDataJSON());
  });
  await page.goto(baseUrl);
  const create = page.getByRole('button', { name: '新建对话', exact: true });
  await create.waitFor();
  // New draft paint must be independent of the unrelated server history roundtrip.
  await page.route('**/api/platform/sessions?*', async route => {
    await new Promise(resolve => setTimeout(resolve, 1600));
    await route.continue();
  });
  await create.click();
  const composer = page.locator('.cwu-composer textarea');
  await composer.waitFor({ timeout: 1000 });
  assert.equal(creates.length, 0);
  assert.match(page.url(), /draftId=/);
  await evidence.checkpoint('新对话即时打开且没有后端创建');
  await page.unroute('**/api/platform/sessions?*');
  async function showSettings() {
    const model = page.locator('select[aria-label="模型"]:visible');
    if (!await model.isVisible()) await page.getByRole('button', { name: '输入选项', exact: true }).click();
    await model.waitFor({ state: 'visible' });
    return model;
  }
  const model = await showSettings();
  await page.waitForFunction(() => document.querySelector('select[aria-label="模型"]')?.value === 'gpt-6.1-sol');
  assert.equal(await page.locator('select[aria-label="思考强度"]:visible').inputValue(), 'xhigh');
  assert.match(await page.locator('button[aria-label="查看上下文"]:visible').innerText(), /未开始/);
  await evidence.checkpoint('读取真实默认模型及思考强度');
  await model.selectOption('codex');
  await page.locator('select[aria-label="思考强度"]:visible').selectOption('high');
  await page.locator('select[aria-label="权限"]:visible').selectOption('restricted');
  await page.locator('button[aria-label="Fast 模式"]:visible').click();
  if (await page.getByRole('button', { name: '关闭输入选项', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭输入选项', exact: true }).click();
  await composer.fill('保留这个未发送的草稿');
  assert.equal(creates.length, 0);
  await page.reload();
  await composer.waitFor();
  await showSettings();
  assert.equal(await page.locator('select[aria-label="模型"]:visible').inputValue(), 'codex');
  assert.equal(await page.locator('select[aria-label="思考强度"]:visible').inputValue(), 'high');
  assert.equal(await page.locator('select[aria-label="权限"]:visible').inputValue(), 'restricted');
  assert.equal(await page.locator('button[aria-label="Fast 模式"]:visible').getAttribute('aria-pressed'), 'true');
  assert.equal(await composer.inputValue(), '保留这个未发送的草稿');
  assert.equal(creates.length, 0);
  await evidence.checkpoint('发送前可配置并在刷新后保留');
  if (await page.getByRole('button', { name: '关闭输入选项', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭输入选项', exact: true }).click();
  const toggle = page.getByRole('button', { name: /展开列表|收起列表/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const archive = page.getByRole('button', { name: '归档：新对话', exact: true });
  await archive.locator('..').hover();
  await archive.click();
  await page.getByRole('button', { name: '归档：新对话', exact: true }).waitFor({ state: 'detached' });
  assert.equal(creates.length, 0);
  await evidence.checkpoint('空草稿可归档并从最近列表消失');
  await page.getByRole('button', { name: '搜索与历史', exact: true }).click();
  const finder = page.getByRole('dialog', { name: '搜索与历史', exact: true });
  await finder.getByLabel('包含已归档', { exact: true }).check();
  await finder.getByRole('button').filter({ hasText: '新对话' }).filter({ hasText: '已归档' }).waitFor();
  await evidence.checkpoint('归档草稿仍可在历史中查阅');
  await finder.getByRole('button', { name: '关闭搜索与历史', exact: true }).click();
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
