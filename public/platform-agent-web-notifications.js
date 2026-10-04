export function agentWebNotificationTarget(params = new URLSearchParams(globalThis.location?.search || ''), storage = globalThis.localStorage) {
  const homeId = String(params.get('notificationDeviceId') || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80);
  if (params.get('notificationApp') === 'home' && homeId) return { app: 'home', deviceId: homeId };
  const key = 'agent_terminal_push_device_id';
  let id;
  try { id = storage?.getItem(key); } catch { /* Browser storage is optional. */ }
  if (!id) { id = crypto.randomUUID(); try { storage?.setItem(key, id); } catch { /* Retain this page's identity. */ } }
  return { app: 'agent', deviceId: id };
}

export async function enableAgentWebNotifications(target) {
  if (!globalThis.Notification || !navigator.serviceWorker || !globalThis.PushManager) throw new Error('当前浏览器不支持完成通知。');
  if (await Notification.requestPermission() !== 'granted') throw new Error('浏览器通知未开启。');
  const configResponse = await fetch('/api/push/config');
  const config = await configResponse.json();
  if (!configResponse.ok || !config.configured || !config.publicKey) throw new Error('通知服务尚未配置。');
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true,
    applicationServerKey: Uint8Array.from(atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)) });
  const response = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: target.deviceId, subscription: subscription.toJSON() }) });
  if (!response.ok) throw new Error('通知注册失败。');
}
