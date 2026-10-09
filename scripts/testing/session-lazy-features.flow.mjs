import assert from 'node:assert/strict';
export const metadata = { name: 'feature-entry-lazy-load-and-retry', profiles: ['desktop', 'mobile'] };
export default async function ({ page, evidence, baseUrl, profile }) {
  const requests = [], errors = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseUrl}/?new=1`);
  const composer = page.locator('.cwu-composer textarea');
  await composer.fill('功能加载失败也保留这条草稿');
  assert.equal(requests.some(path => /agent-memories|agent-integrations|voice-capture-widget|\/api\/memories|\/api\/integrations/.test(path)), false);
  async function settings() {
    const expand = page.getByRole('button', { name: '展开列表', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.getByLabel('产品设置', { exact: true }).click();
  }
  let first = true;
  await page.route('**/agent-integrations.js?**', async route => {
    if (first) { first = false; await route.abort('failed'); } else await route.continue();
  });
  await settings();
  await page.getByRole('button', { name: '集成', exact: true }).click();
  await page.getByText('功能资源加载失败，请重试。', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), '功能加载失败也保留这条草稿');
  await evidence.checkpoint(`${profile} 功能资源失败不影响草稿输入`);
  await settings();
  const integrationRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/integrations');
  await page.getByRole('button', { name: '集成', exact: true }).click();
  await page.locator('#integrations-dialog[open]').waitFor();
  assert.equal((await integrationRead).ok(), true);
  assert.equal(requests.filter(path => path === '/agent-integrations.js').length, 2);
  await evidence.checkpoint('再次进入集成设置可重试，首次打开才读取数据');
  await page.locator('#integrations-close').click();
  await settings();
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.locator('#memory-dialog[open]').waitFor();
  await page.locator('#memory-refresh:not([disabled])').waitFor();
  assert.equal(requests.filter(path => path === '/agent-memories.js').length, 1);
  assert.equal(requests.filter(path => path === '/api/memories').length, 1);
  await evidence.checkpoint('记忆管理按需打开，执行时的记忆来源保持独立');
  await page.locator('#memory-close').click();
  await settings();
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.locator('#memory-dialog[open]').waitFor();
  await page.locator('#memory-refresh:not([disabled])').waitFor();
  assert.equal(requests.filter(path => path === '/agent-memories.js').length, 1);
  assert.deepEqual(errors, []);
}
