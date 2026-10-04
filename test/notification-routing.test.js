import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Home-launched Agent turns route completion notifications back to Home", async () => {

  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /const homeQuery = new URLSearchParams\(\{ focus: "agent" \}\)/);
  assert.match(server, /notificationApp === "home" \? `\/\?\$\{homeQuery\}` : `\/\?\$\{query\}`/);
  assert.match(server, /target: \{ app: notificationApp, deviceId: session\.notificationDeviceId \}/);
});
