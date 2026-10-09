import assert from 'node:assert/strict';
export const metadata={name:'submission-and-native-binding-state',profiles:['desktop','mobile']};
export default async function({page,context,evidence,baseUrl,profile}){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${baseUrl}?attach=old-${profile}`);await page.getByText(`历史答复 ${profile}`,{exact:true}).waitFor();
 await evidence.checkpoint('旧连接按需展示历史，不启动任务');
 // Force a slow preparation read before the first actual native submit.
 await page.route('**/actions/executionProfile',async route=>{await new Promise(r=>setTimeout(r,3500));await route.continue();});
 const input=page.locator('.cwu-composer textarea');await input.fill(`准备期间可见 ${profile}`);await page.locator('.cwu-composer button[type=submit]').click();
 await page.getByText(`准备期间可见 ${profile}`,{exact:true}).waitFor();assert.equal(await page.getByRole('status').filter({hasText:'正在发送'}).count(),1);
 await evidence.checkpoint('准备完成前用户消息立即出现');
 await page.locator('.cwu-composer button[type=submit]').filter({hasText:'追加当前'}).waitFor();await input.fill(`完成后迟到 ${profile}`);await page.locator('.cwu-composer button[type=submit]').click();
 await page.locator('.cwu-composer button[type=submit]').filter({hasText:'发送'}).waitFor();await page.waitForTimeout(1500);
 assert.equal(await page.locator('.cwu-technical.is-running').count(),0);assert.equal(await page.getByText(`准备期间可见 ${profile}`,{exact:true}).count(),1);
 assert.equal(await page.getByText(`完成后迟到 ${profile}`,{exact:true}).count(),1);assert.equal(await page.getByRole('status').filter({hasText:'等待同步'}).count(),0);assert.equal(await page.getByText(/【追加要求/).count(),0);
 await evidence.checkpoint('完成早于追加回包，迟到回包不会恢复执行中');
 await input.fill(`启动失败 ${profile}`);await page.locator('.cwu-composer button[type=submit]').click();await page.locator('.cwu-host-error').filter({hasText:'合成启动失败'}).waitFor();
 assert.equal(await input.inputValue(),`启动失败 ${profile}`);assert.equal(await page.locator('.cwu-technical.is-running').count(),0);await evidence.checkpoint('启动失败显示错误并恢复输入');
 await input.fill('切换连接时保留草稿');
 const liveUrl=new URL(page.url());const attachment=liveUrl.searchParams.get('attach');
 const current=await(await page.request.get(`${baseUrl}/api/platform/sessions/${attachment}`)).json();const native=current.session.sessionId;
 await page.request.post(`${baseUrl}/api/sessions/${attachment}/end`);await page.waitForTimeout(300);
 await page.request.post(`${baseUrl}/api/platform/sessions`,{data:{sessionId:native,cwd:current.session.cwd,access:'full',idempotencyKey:`external-binding-${profile}`}});
 await fetch(process.env.STATE_CONTROL_URL||'http://127.0.0.1:4310',{method:'POST',body:JSON.stringify({type:'external',threadId:native,text:`另一端发来的消息 ${profile}`})});
 await page.getByText(`另一端发来的消息 ${profile}`,{exact:true}).waitFor();assert.equal(await input.inputValue(),'切换连接时保留草稿');assert.notEqual(new URL(page.url()).searchParams.get('attach'),attachment);
 await evidence.checkpoint('释放旧连接后另一端恢复，同一正文自动接到新连接');
 await context.setOffline(true);await page.waitForTimeout(500);await context.setOffline(false);await page.bringToFront();
 await page.locator('.cwu-technical.is-running').waitFor({state:'detached'});assert.equal(await page.getByText(`另一端发来的消息 ${profile}`,{exact:true}).count(),1);assert.equal(await input.inputValue(),'切换连接时保留草稿');
 await evidence.checkpoint('断线重连补齐完成状态，消息与草稿保留');
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
}
