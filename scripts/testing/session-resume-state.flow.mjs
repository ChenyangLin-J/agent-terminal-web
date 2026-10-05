import assert from 'node:assert/strict';
export const metadata={name:'native-head-recovery',profiles:['desktop','mobile']};
// candidate-preview.mjs --restore-state: all history and submissions are synthetic.
export default async function({page,evidence,baseUrl,profile}) {
  const errors=[],creates=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/platform/sessions')creates.push(request);});
  const oldDate=new Intl.DateTimeFormat('en-US',{month:'numeric',day:'numeric',timeZone:'Asia/Shanghai'}).format(new Date(Date.now()-86400000));
  async function openList() { const button=page.getByRole('button',{name:'展开列表',exact:true}); if(await button.isVisible())await button.click(); }
  async function select(name) { await openList(); await page.locator('.cwu-browser-row-main').filter({hasText:`旧会话 ${name}`}).click(); await page.getByText(`旧会话回复 ${name}`,{exact:true}).waitFor(); }
  async function checkRecent(name) {
    await openList();
    const row=page.locator('.cwu-browser-row').filter({has:page.locator('.cwu-browser-row-main').filter({hasText:`旧会话 ${name}`})});
    await page.waitForFunction(({name,date})=>{const row=[...document.querySelectorAll('.cwu-browser-row')].find(x=>x.querySelector('strong')?.textContent===`旧会话 ${name}`);return row?.textContent.includes(date)&&row.querySelector('.cwu-browser-row-status')?.classList.contains('cwu-status-idle');},{name,date:oldDate});
    assert.equal(await row.locator('.cwu-browser-row-main small').innerText().then(text=>text.includes(oldDate)),true);
    assert.equal(await page.locator('.cwu-host-error').count(),0);
    if(profile==='mobile')await page.getByRole('button',{name:'收起列表',exact:true}).click();
  }
  await page.goto(`${baseUrl}?attach=recovery-${profile}`);
  await page.getByText(`旧会话回复 ${profile}`,{exact:true}).waitFor();
  await checkRecent(profile);
  assert.equal(await page.locator('.cwu-technical.is-running').count(),0);
  await evidence.checkpoint('旧连接的中断状态由最新完成记录修正，仍在昨天');
  const other=profile==='desktop'?'mobile':'desktop';
  await select(other);
  await select(profile); await checkRecent(profile);
  assert.equal(await page.getByText(`旧会话问题 ${profile}`,{exact:true}).count(),1);
  await evidence.checkpoint('切换两个旧会话再返回，时间和状态保持稳定');
  await page.reload(); await page.getByText(`旧会话回复 ${profile}`,{exact:true}).waitFor(); await checkRecent(profile);
  assert.equal(creates.length,0);
  await evidence.checkpoint('刷新没有创建会话或更新最近时间');
  await page.locator('.cwu-composer textarea').fill(`新消息 ${profile}`);
  await page.locator('.cwu-composer button[type=submit]').click();
  await page.locator('.cwu-technical.is-running').waitFor();
  await page.getByText(`新消息 ${profile}`,{exact:true}).waitFor();
  assert.equal(await page.getByText(`旧会话问题 ${profile}`,{exact:true}).count(),1);
  await evidence.checkpoint('实际发送后才更新最近，过程位于新消息下方');
  await page.locator('.cwu-technical.is-running').waitFor({state:'detached'});
  assert.equal(creates.length,0); assert.deepEqual(errors,[]);
  assert.equal(await page.locator('.cwu-host-error').count(),0);
  await evidence.checkpoint('完成后执行区稳定收为记录，沿用原会话');
}
