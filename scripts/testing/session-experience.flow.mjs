import assert from 'node:assert/strict';
export const metadata = { name: 'session-memory-preview-background-status', profiles: ['desktop', 'mobile'] };
// Run against candidate-preview.mjs --experience; all files, memories and Turns are synthetic.
export default async function ({ page, context, evidence, baseUrl, profile }) {
  page.setDefaultTimeout(15000);
  const suffix = Date.now().toString(36);
  const errors = [], reads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => reads.push(new URL(request.url()).pathname));
  async function openList() {
    const toggle = page.getByRole('button', { name: '展开列表', exact: true });
    if (await toggle.isVisible()) await toggle.click();
  }
  async function closeList() {
    if (profile === 'mobile') await page.getByRole('button', { name: '收起列表', exact: true }).click();
  }
  async function send(prompt) {
    await openList();
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await page.locator('.cwu-composer textarea').fill(prompt);
    const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/platform/sessions');
    await page.locator('.cwu-composer button[type=submit]').click();
    const snapshot = await (await created).json();
    await evidence.checkpoint('隔离会话已创建，等待执行');
    await page.locator('.cwu-technical.is-running').waitFor();
    await openList();
    const title = await page.locator('.cwu-browser-row.is-active strong').innerText();
    await closeList();
    return { id: snapshot.session.id, title };
  }
  async function closePreview() {
    await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
    await page.locator('.cwu-document-backdrop').waitFor({ state: 'detached' });
    // Closing restores focus and can finish the result-read catalogue update.
    await page.waitForTimeout(500);
  }
  await page.goto(baseUrl);
  const first = await send(`前台预览验收 ${profile} ${suffix}`);
  await page.getByRole('link', { name: '查看说明', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Core.md', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Now.md', exact: true }).waitFor();
  assert.equal(await page.locator('.cwu-memory-sources').count(), 1);
  await evidence.checkpoint('完成回复展示本轮实际读取的 Core 和 Now 来源');
  await evidence.action('打开 Core 记忆来源', page.getByRole('button', { name: 'Core.md', exact: true }), x => x.click());
  await page.locator('.cwu-document-content').getByText('合成验收记忆：回复使用中文，文件在站内预览。', { exact: true }).waitFor();
  await evidence.checkpoint('记忆通过共享文件预览打开');
  await closePreview();
  await evidence.action('回复中的文件在站内打开', page.getByRole('link', { name: '查看说明', exact: true }), x => x.click());
  await page.locator('.cwu-document-content h1').getByText('会话体验验收', { exact: true }).waitFor();
  const embedded = page.locator('.cwu-document-content img');
  await embedded.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.cwu-document-content img')].every(img => img.complete && img.naturalWidth > 0));
  await evidence.checkpoint('Markdown 和相对图片引用使用同一个预览组件');
  await closePreview();
  await evidence.action('打开图片', page.getByRole('link', { name: '查看图片', exact: true }), x => x.click());
  await page.locator('.cwu-document-image img').waitFor();
  await page.waitForFunction(() => document.querySelector('.cwu-document-image img')?.naturalWidth > 0);
  assert.equal(context.pages().length, 1);
  await evidence.checkpoint('图片预览保持在当前页面');
  await closePreview();
  let failed = false;
  await page.route('**/api/platform/file-preview?**', async route => {
    if (!failed && new URL(route.request().url()).searchParams.get('href')?.endsWith('note.md')) {
      failed = true; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成预览读取失败' }) });
    }
    await route.continue();
  });
  await page.getByRole('link', { name: '查看说明', exact: true }).click();
  await page.locator('.cwu-document-preview').getByRole('link', { name: '重试', exact: true }).waitFor();
  await evidence.action('预览失败后重试', page.locator('.cwu-document-preview').getByRole('link', { name: '重试', exact: true }), x => x.click());
  await page.locator('.cwu-document-content h1').getByText('会话体验验收', { exact: true }).waitFor();
  await closePreview();
  await page.getByRole('link', { name: '查看文件', exact: true }).click();
  await page.getByText('暂不支持站内预览此文件类型，请下载原文件。', { exact: true }).waitFor();
  assert.equal(await page.locator('.cwu-document-preview').getByRole('link', { name: '下载', exact: true }).count(), 1);
  await evidence.checkpoint('未支持的格式提供原文件下载');
  await closePreview();
  await page.locator('.cwu-technical-toggle').click();
  await page.locator('.cwu-process-row.type-assistant .cwu-process-copy').waitFor();
  assert.equal(await page.locator('.cwu-process-row.type-assistant button.cwu-process-summary').count(), 0);
  const viewed = page.locator('.cwu-process-row.type-tool').filter({ hasText: '查看图片' });
  assert.equal(await viewed.locator('button.cwu-process-summary').count(), 0);
  await viewed.locator('img').waitFor();
  await evidence.checkpoint('过程回复和查看图片直接展示，命令保留展开');
  await evidence.action('查看记录中的图片', viewed.locator('button').filter({ has: page.locator('img') }), x => x.click());
  await page.locator('.cwu-document-image img').waitFor();
  await page.waitForFunction(() => document.querySelector('.cwu-document-image img')?.naturalWidth > 0);
  await closePreview();
  const second = await send(`后台完成验收 ${profile} ${suffix}`);
  await openList();
  await evidence.action('执行中切回前台会话', page.locator('.cwu-browser-row-main').filter({ hasText: first.title }), x => x.click());
  await page.getByRole('link', { name: '查看说明', exact: true }).waitFor();
  await openList();
  const readCount = reads.length;
  await page.waitForFunction(title => {
    const row = [...document.querySelectorAll('.cwu-browser-row')].find(x => x.querySelector('strong')?.textContent === title);
    return row?.classList.contains('is-unread');
  }, second.title);
  assert.match(await page.locator('.cwu-browser-row.is-active strong').innerText(), new RegExp(first.title));
  assert.equal(reads.slice(readCount).filter(url => url === `/api/platform/sessions/${second.id}`).length, 0, 'background completion does not read the other transcript');
  assert.equal(context.pages().length, 1);
  assert.deepEqual(errors, []);
  await evidence.checkpoint('停留在 A 会话时，后台 B 自动变为新结果，无须点进去');
}
