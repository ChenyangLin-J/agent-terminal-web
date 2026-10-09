import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
export const metadata = { name: 'lazy-startup-and-split-send', profiles: ['desktop', 'mobile'] };
// Synthetic candidate-preview.mjs --experience --recovery; no real model or account.
export default async function ({ page, context, evidence, baseUrl, profile }) {
  const requests = [], errors = [];
  const assets = JSON.parse(await readFile(new URL('../../public/generated/manifest.json', import.meta.url), 'utf8'));
  const blank = await context.newPage(), blankReads = [];
  blank.on('request', request => blankReads.push(new URL(request.url()).pathname));
  try {
    await blank.goto(`${baseUrl}/?new=1`);
    await blank.locator('.cwu-composer textarea').fill('立即可以输入的新草稿');
    assert.equal(blankReads.some(path => path === assets.markdown || path === assets.math || /session-metadata|agent-memories|agent-integrations|voice-capture-widget/.test(path)), false);
    evidence.usePage(blank);
    await evidence.checkpoint('空白新草稿不加载正文解析、数学公式或功能管理');
  } finally { evidence.usePage(page); await blank.close(); }
  page.on('request', request => requests.push({ url: new URL(request.url()), kind: request.resourceType(), method: request.method() }));
  page.on('pageerror', error => errors.push(error.message));
  let releaseList;
  const listGate = new Promise(resolve => { releaseList = resolve; });
  const holdList = async route => { await listGate; await route.continue(); };
  await page.route('**/api/platform/sessions?**', holdList);
  try {
    await evidence.chapter('按需加载与实际输入区', { description: `${profile} · 合成数据、真实应用代码` });
    await page.goto(`${baseUrl}/?attach=recovery-${profile}`, { waitUntil: 'domcontentloaded' });
    const composer = page.locator('.cwu-composer textarea');
    await composer.waitFor();
    await page.getByText(`旧会话回复 ${profile}`, { exact: true }).waitFor();
    await composer.fill('列表仍在加载时也可以输入');
    assert.equal(requests.some(({ url }) => url.pathname.includes('session-metadata')), false);
    assert.equal(requests.some(({ url }) => /agent-memories|agent-integrations|voice-capture-widget/.test(url.pathname) || url.pathname === assets.math), false);
    await evidence.checkpoint('历史列表延迟时，当前会话和输入仍可用');
  } finally {
    releaseList();
    await page.unrouteAll({ behavior: 'wait' });
  }
  async function openList() {
    const button = page.getByRole('button', { name: '展开列表', exact: true });
    if (await button.isVisible()) await button.click();
  }
  await openList();
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  const composer = page.locator('.cwu-composer textarea');
  await page.locator('.cwu-session-header').getByRole('heading', { name: '新对话', exact: true }).waitFor();
  await composer.fill(`按需加载验收 ${profile}`);
  assert.equal(requests.some(({ url }) => url.pathname.includes('session-metadata')), false);
  const before = requests.length;
  const chooser = await Promise.all([page.waitForEvent('filechooser'), page.locator('.cwu-attach-button').click()]).then(([result]) => result);
  await chooser.setFiles([]);
  assert.equal(requests.slice(before).filter(({ url }) => url.pathname.startsWith('/api/')).length, 0);
  assert.equal(requests.filter(({ kind }) => kind === 'document').length, 1);
  await evidence.checkpoint('新建和附件加号均不刷新页面、不读取模型');
  await page.locator('.cwu-composer button[type=submit]').click();
  await page.locator('.cwu-technical.is-running').waitFor();
  assert.equal(requests.filter(({ url }) => url.pathname.includes('session-metadata')).length, 1);
  const trigger = page.locator('.cwu-send-mode-trigger');
  await trigger.click();
  await page.getByRole('menuitemradio', { name: /下一轮/ }).click();
  assert.equal(await page.locator('.cwu-composer button[type=submit]').innerText(), '下一轮');
  await trigger.click();
  const area = await trigger.boundingBox(), menu = await page.getByRole('menu', { name: '发送方式', exact: true }).boundingBox();
  assert.ok(area.width >= 44 && area.height >= 44);
  assert.ok(menu.y + menu.height <= area.y + 2, 'menu opens above its send control');
  await evidence.checkpoint('运行中发送方式贴近发送按钮，向上展开');
  await page.keyboard.press('Escape');
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  if (profile === 'mobile') {
    const viewport = page.viewportSize();
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: viewport.height });
      await page.waitForTimeout(120);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await evidence.checkpoint(`${width}px 实际运行布局`);
    }
    await page.setViewportSize(viewport);
  }
  await composer.fill('本轮结束后处理这条');
  await composer.press('Enter');
  await page.locator('.cwu-queued-turns').waitFor();
  await evidence.checkpoint('回车遵循下一轮选择，进入待执行队列');
  assert.equal(requests.filter(({ kind }) => kind === 'document').length, 1);
  assert.deepEqual(errors, []);
}
