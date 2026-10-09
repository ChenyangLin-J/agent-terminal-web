import assert from 'node:assert/strict';
export const metadata = { name: 'session-selection-duration-and-demand-loading', profiles: ['desktop', 'mobile'] };
export default async function ({ page, evidence, baseUrl, profile }) {
  const metrics = [], reads = [], processes = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (!message.text().startsWith('AgentWebTiming ')) return;
    const metric = JSON.parse(message.text().slice('AgentWebTiming '.length));
    if (metric.phase === 'selection-visible') metrics.push(metric);
    if (metric.phase === 'snapshot-read') reads.push(metric);
  });
  page.on('request', request => { if (/\/process\//.test(request.url())) processes.push(request.url()); });
  await page.goto(`${baseUrl}/?new=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('.cwu-composer textarea').waitFor();
  const digit = profile === 'desktop' ? '1' : '2';
  const native = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const created = await page.request.post(`${baseUrl}/api/platform/sessions`, { data: { sessionId: native, title: `状态验收 ${profile}`, access: 'full', idempotencyKey: `timing-${profile}` } });
  assert.equal(created.ok(), true);
  const attachment = (await created.json()).session.id;
  // Resume is prepared outside the selection metric. Its 315 closed execution
  // records must not cross the public conversation snapshot or replay channel.
  let current;
  for (let i = 0; i < 100; i++) {
    current = await (await page.request.get(`${baseUrl}/api/platform/sessions/${attachment}`)).json();
    if (current.session.ready && current.transcript.items.some(item => item.text === `历史答复 ${profile}`)) break;
    await page.waitForTimeout(100);
  }
  assert.ok(current.session.ready);
  assert.equal(current.transcript.items.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(current)) < 32768);
  assert.equal(current.transcript.technicalDetailsAvailable.length, 1);
  const showList = async () => {
    const expand = page.getByRole('button', { name: '展开列表', exact: true });
    if (await expand.isVisible()) await expand.click();
  };
  await showList();
  const row = page.locator('.cwu-browser-row-main').filter({ hasText: `状态验收 ${profile}` });
  await row.waitFor();
  const select = async (cached) => {
    await showList();
    const count = metrics.length;
    await row.click();
    await page.getByText(`历史答复 ${profile}`, { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.cwu-message').length === 2);
    for (let i = 0; i < 50 && metrics.length === count; i++) await page.waitForTimeout(20);
    assert.ok(metrics.length > count, 'selection paint metric must be emitted');
    const result = metrics.at(-1);
    assert.equal(result.cached, cached);
    assert.ok(result.totalMs <= (cached ? 500 : 2000), `${cached ? 'warm' : 'first'} readable body ${result.totalMs}ms exceeds budget`);
    return result;
  };
  const first = await select(false);
  assert.equal(processes.length, 0, 'closed execution details must stay unloaded');
  await evidence.checkpoint('首次选中长会话，正文在两秒内显示');
  await showList();
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.locator('.cwu-composer textarea').waitFor();
  const readCount = reads.length;
  await page.route(`**/api/platform/sessions/${attachment}`, async route => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.continue();
  });
  const warm = await select(true);
  await evidence.checkpoint('慢速刷新仍先显示已验证正文，五百毫秒内可见');
  for (let i = 0; i < 100 && reads.length === readCount; i++) await page.waitForTimeout(30);
  assert.ok(reads.length > readCount, 'warm projection must still revalidate');
  assert.ok(reads.at(-1).totalMs >= 1400, 'slow read fixture must exercise warm cache');
  assert.equal(processes.length, 0);
  const [processResponse] = await Promise.all([
    page.waitForResponse(response => /\/process\//.test(response.url()) && response.ok(), { timeout: 10000 }),
    page.getByRole('button', { name: '展开本轮详情', exact: true }).first().click(),
  ]);
  assert.equal((await processResponse.json()).items.length, 315);
  assert.equal(processes.length, 1);
  await evidence.checkpoint('展开执行记录后才读取完整历史详情');
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  process.stdout.write(JSON.stringify({ profile, network: 'loopback Chromium, synthetic native history and 1500ms revalidation delay', budgetsMs: { first: 2000, warm: 500 }, first, warm, snapshotBytes: Buffer.byteLength(JSON.stringify(current)), closedExecutionRecords: 315, processReads: processes.length, passed: true }) + '\n');
}
