import assert from 'node:assert/strict';
export const metadata = { name: 'observable-startup-timing', profiles: ['desktop', 'mobile'] };
// Loopback + Chromium viewport evidence, not a physical-phone latency promise.
export default async function ({ page, evidence, baseUrl, profile }) {
  const composer = page.locator('.cwu-composer textarea');
  let started = Date.now();
  await page.goto(`${baseUrl}/?new=1`, { waitUntil: 'domcontentloaded' });
  await composer.waitFor();
  assert.equal(await composer.isEditable(), true);
  const coldDraftMs = Date.now() - started;
  const initialScripts = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(resource => resource.name.includes('/generated/') && new URL(resource.name).pathname.endsWith('.js'))
    .map(resource => ({ path: new URL(resource.name).pathname, encodedBodySize: resource.encodedBodySize, transferSize: resource.transferSize })));
  await composer.fill('冷启动可以立即输入');
  await evidence.checkpoint('冷启动已可输入');
  started = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await composer.waitFor();
  assert.equal(await composer.isEditable(), true);
  const warmDraftMs = Date.now() - started;
  await evidence.checkpoint('缓存再次打开已可输入');
  const expand = page.getByRole('button', { name: '展开列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  const previous = page.locator('.cwu-browser-row-main').filter({ hasText: `旧会话 ${profile}` });
  await previous.waitFor();
  started = Date.now();
  await previous.click();
  await page.getByText(`旧会话回复 ${profile}`, { exact: true }).waitFor();
  const switchMs = Date.now() - started;
  await evidence.checkpoint('切换后最近内容可见');
  process.stdout.write(JSON.stringify({ profile, network: 'loopback, no throttle, synthetic backend', coldDraftMs, warmDraftMs, switchMs, initialScripts }) + '\n');
}
