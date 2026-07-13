import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const notifyScript = path.join(root, "scripts", "codex-notify.js");

test("Codex completion callback includes its Agent Web session", async (t) => {
  let received;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const event = {
    type: "agent-turn-complete",
    "thread-id": "01900000-0000-7000-8000-000000000000",
    "turn-id": "turn-1",
  };
  await execFileAsync(process.execPath, [notifyScript, JSON.stringify(event)], {
    env: {
      ...process.env,
      AGENT_NOTIFY_URL: `http://127.0.0.1:${server.address().port}`,
      AGENT_WEB_SESSION_ID: "web-session-1",
    },
  });

  assert.deepEqual(received, { webSessionId: "web-session-1", event });
});
