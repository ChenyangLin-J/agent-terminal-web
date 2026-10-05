import assert from 'node:assert/strict';
export const metadata = { name: 'session-context-projection', profiles: ['desktop', 'mobile'] };
export default async function ({ page, evidence, baseUrl }) {
  const errors = [], creates = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/platform/sessions') creates.push(request); });
  await page.goto(baseUrl);
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  const composer = page.locator('.cwu-composer textarea');
  await composer.waitFor();
  assert.equal(creates.length, 0);
  await evidence.checkpoint('发送前仍是本地草稿');
  await composer.fill('检查隔离会话的上下文投影');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  if (!await page.locator('button[aria-label="查看上下文"]:visible').isVisible()) await page.getByRole('button', { name: '输入选项', exact: true }).click();
  await page.locator('button[aria-label="查看上下文"]:visible').filter({ hasText: '2%' }).waitFor();
  assert.equal(creates.length, 1);
  await evidence.checkpoint('原生通知的用量进入Composer');
  await page.locator('button[aria-label="查看上下文"]:visible').click();
  await page.getByText('6,000 / 258,400 tokens · 2%', { exact: true }).waitFor();
  await evidence.checkpoint('上下文弹窗使用相同报告数据');
  await page.getByRole('button', { name: '关闭上下文', exact: true }).click();
  assert.deepEqual(errors, []);
}
