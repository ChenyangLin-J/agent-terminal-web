import assert from 'node:assert/strict';
export const metadata = { name: 'released-session-recovery', profiles: ['desktop', 'mobile'] };
// Run against candidate-preview.mjs --recovery; all messages and state are synthetic.
export default async function ({ page, evidence, baseUrl, profile }) {
  const errors = [], creates = [], profiles = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === '/api/platform/sessions') creates.push(request.postDataJSON());
    if (pathname.endsWith('/actions/executionProfile')) profiles.push(request);
  });
  await page.addInitScript(() => {
    window.recoveryAlerts = [];
    addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
      for (const element of document.querySelectorAll('.cwu-host-error')) if (element.textContent) window.recoveryAlerts.push(element.textContent);
    }).observe(document.body, { childList: true, subtree: true, characterData: true }));
  });
  await page.goto(`${baseUrl}?attach=recovery-${profile}`);
  await page.getByText(`旧会话回复 ${profile}`, { exact: true }).waitFor();
  await evidence.checkpoint('已释放的旧会话保留历史和输入框');
  const composer = page.locator('.cwu-composer textarea');
  await composer.fill(`续发第一条 ${profile}`);
  await page.locator('.cwu-composer button[type=submit]').click();
  await page.getByText('正在检查附件预览和输入布局。', { exact: true }).waitFor();
  await page.locator('.cwu-technical.is-running').waitFor();
  const liveUrl = page.url();
  assert.doesNotMatch(liveUrl, /preview=1/);
  assert.equal(await page.getByText(`旧会话问题 ${profile}`, { exact: true }).count(), 1);
  await evidence.checkpoint('恢复后历史只显示一次，最新消息下方执行');
  // Cross the old 5-second preview polling boundary while this turn is still active.
  await page.waitForTimeout(5200);
  assert.equal(await page.locator('.cwu-technical.is-running').count(), 1);
  assert.equal(await page.locator('.cwu-host-error').count(), 0);
  assert.equal(page.url(), liveUrl);
  await evidence.checkpoint('经过旧轮询周期仍稳定显示实时过程');
  await page.locator('.cwu-technical.is-running').waitFor({ state: 'detached' });
  await composer.fill(`续发第二条 ${profile}`);
  await page.locator('.cwu-composer button[type=submit]').click();
  await page.getByText(`续发第二条 ${profile}`, { exact: true }).waitFor();
  await page.locator('.cwu-technical.is-running').waitFor();
  assert.equal(creates.length, 1); assert.equal(profiles.length, 1);
  assert.equal(page.url(), liveUrl);
  await evidence.checkpoint('连续发送沿用同一个连接和配置');
  assert.deepEqual(await page.evaluate(() => window.recoveryAlerts), []);
  await page.reload();
  await page.getByText(`续发第二条 ${profile}`, { exact: true }).waitFor();
  await page.locator('.cwu-technical.is-running').waitFor();
  assert.equal(await page.getByText(`旧会话问题 ${profile}`, { exact: true }).count(), 1);
  assert.equal(creates.length, 1); assert.equal(profiles.length, 1);
  assert.equal(page.url(), liveUrl);
  await evidence.checkpoint('执行中刷新仍打开当前会话并保留消息顺序');
  await page.locator('.cwu-technical.is-running').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.recoveryAlerts), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
