import assert from 'node:assert/strict';
import test from 'node:test';
import { agentWebNotificationTarget } from '../public/platform-agent-web-notifications.js';

test('Home launch routing retains its device identity and ordinary pages retain their browser identity', () => {
  const storage = new Map([['agent_terminal_push_device_id', 'browser-a']]);
  const adapter = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  assert.deepEqual(agentWebNotificationTarget(new URLSearchParams('notificationApp=home&notificationDeviceId=home-a'), adapter), { app: 'home', deviceId: 'home-a' });
  assert.deepEqual(agentWebNotificationTarget(new URLSearchParams(), adapter), { app: 'agent', deviceId: 'browser-a' });
});
