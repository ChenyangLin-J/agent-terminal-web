import assert from 'node:assert/strict';

export const metadata = { name: 'real-codex-backend', profiles: ['desktop'] };
export default async function ({ page, evidence, baseUrl }) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseUrl);
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  const composer = page.locator('.cwu-composer textarea');
  await composer.waitFor();
  await evidence.checkpoint('真实后端候选可创建对话');
  await composer.fill('这是网页真实后端的验收。请只运行一次 pwd 来读取当前工作目录，不修改任何文件，不调用其他工具，然后用中文回复“真实后端已连接”并给出 pwd 输出。');
  await page.locator('.cwu-composer button[type=submit]').click();
  await page.locator('.cwu-message.is-assistant').filter({hasText:'真实后端已连接'}).waitFor({timeout:120000});
  await page.getByText('执行记录', { exact: true }).waitFor({timeout:10000});
  await page.locator('.cwu-technical-toggle').click();
  await page.locator('.cwu-process-command').filter({hasText:'pwd'}).first().waitFor();
  await evidence.checkpoint('真实 Codex 执行命令并返回最终回复');
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
