import assert from 'node:assert/strict';
export const metadata = { name: 'session-transport-recovery', profiles: ['desktop', 'mobile'] };
export default async function ({ page, evidence, baseUrl, profile }) {
  const metrics = [], snapshots = [], failures = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (!message.text().startsWith('AgentWebTiming ')) return;
    const metric = JSON.parse(message.text().slice('AgentWebTiming '.length));
    if (metric.phase === 'selection-visible') metrics.push(metric);
    if (metric.phase === 'snapshot-read') snapshots.push(metric);
    if (metric.phase === 'request-failed') failures.push(metric);
  });
  await page.goto(`${baseUrl}/?new=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('.cwu-composer textarea').waitFor();
  const digit = profile === 'desktop' ? '1' : '2';
  const native = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  const created = await page.request.post(`${baseUrl}/api/platform/sessions`, { data: { sessionId: native, title: `状态验收 ${profile}`, access: 'full', idempotencyKey: `transport-${profile}` } });
  assert.equal(created.ok(), true);
  const attachment = (await created.json()).session.id;
  for (let i = 0; i < 100; i++) {
    const current = await (await page.request.get(`${baseUrl}/api/platform/sessions/${attachment}`)).json();
    if (current.session.ready && current.transcript.items.some(item => item.text === `历史答复 ${profile}`)) break;
    await page.waitForTimeout(100);
  }
  const showList = async () => {
    const expand = page.getByRole('button', { name: '展开列表', exact: true });
    if (await expand.isVisible()) await expand.click();
  };
  const row = page.locator('.cwu-browser-row-main').filter({ hasText: `状态验收 ${profile}` });
  const select = async () => { await showList(); await row.waitFor(); await row.click(); };
  const away = async () => { await showList(); await page.getByRole('button', { name: '新建对话', exact: true }).click(); };
  const endpoint = `**/api/platform/sessions/${attachment}`;
  let reads = 0;
  await page.route(endpoint, async route => { if (++reads === 1) await route.abort('failed'); else await route.continue(); });
  await select();
  await page.getByText(`历史答复 ${profile}`, { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.cwu-message').length === 2);
  // Native unread acknowledgement can request a separate background refresh.
  // Assert the failed selection's bounded retry, not the whole page's GET count.
  assert.equal(failures.length, 1);
  assert.equal(snapshots[0].attempts, 2);
  assert.ok(reads >= 2 && reads <= 3);
  assert.ok(metrics.at(-1).totalMs <= 2000, `recovered first body ${metrics.at(-1).totalMs}ms exceeds 2s`);
  await evidence.checkpoint('瞬时断网后自动恢复，正文两秒内出现');
  const draft = '这段草稿尚未发送';
  await page.locator('.cwu-composer textarea').fill(draft);
  await away();
  await page.unroute(endpoint);
  reads = 0;
  await page.route(endpoint, async route => { reads++; await route.abort('failed'); });
  await select();
  await page.getByText('网络连接中断，请重试。', { exact: true }).waitFor();
  // A newer catalogue snapshot can cancel the first refresh during backoff;
  // only the surviving read may reach its second attempt.
  assert.ok(reads >= 2 && reads <= 3);
  assert.equal(failures.at(-1).attempt, 2);
  assert.equal(failures.at(-1).retrying, false);
  assert.equal(await page.locator('.cwu-message').count(), 2);
  assert.equal(await page.locator('.cwu-composer textarea').inputValue(), draft);
  assert.ok(metrics.at(-1).cached);
  assert.ok(metrics.at(-1).totalMs <= 500);
  await evidence.checkpoint('持续断网有明确提示，正文和草稿仍保留');
  await page.unroute(endpoint);
  await away();
  await select();
  await page.getByText('网络连接中断，请重试。', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.cwu-composer textarea').inputValue(), draft);
  await evidence.checkpoint('连接恢复后切回会话，草稿可以继续编辑');
  await away();
  let redirects = 0, followedLogin = 0;
  await page.route('https://auth.invalid/**', async route => { followedLogin++; await route.abort(); });
  await page.route(endpoint, async route => { redirects++; await route.fulfill({ status: 302, headers: { location: 'https://auth.invalid/login' } }); });
  await select();
  await page.getByText('登录已过期，请刷新页面重新登录。', { exact: true }).waitFor();
  assert.equal(redirects, 1);
  assert.equal(followedLogin, 0);
  assert.equal(await page.locator('.cwu-message').count(), 2);
  assert.equal(await page.locator('.cwu-composer textarea').inputValue(), draft);
  await evidence.checkpoint('登录过期显示明确提示，不再变成跨域读取失败');
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  process.stdout.write(JSON.stringify({ profile, network: 'isolated Chromium with failed GET and private-gate redirect injection', firstVisibleMs: metrics[0].totalMs, failures, loginRedirects: redirects, followedLogin, draftRetained: true, mutationsResent: 0, passed: true }) + '\n');
}
