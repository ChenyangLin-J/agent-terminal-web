import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Home-launched Agent turns route completion notifications back to Home", async () => {
  const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(client, /params\.get\("notificationApp"\) === "home"/);
  assert.match(client, /notificationApp: notificationTarget\.app/);
  assert.match(client, /appendNotificationTarget\(url\)/);
  assert.match(server, /notificationApp === "home" \? `\/open\/agent\?\$\{query\}` : `\/\?\$\{query\}`/);
  assert.match(server, /target: \{ app: notificationApp, deviceId: session\.notificationDeviceId \}/);
});
