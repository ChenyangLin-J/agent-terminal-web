import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("browser WebSocket diagnostics retain handshake timing and reconnect context", async () => {

  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /reconnectAttempt: optionalNonNegativeInteger\(req\.body\?\.reconnectAttempt\)/);
  assert.match(server, /phase: cleanClientLogValue\(req\.body\?\.phase, 30\)/);
});

test("client event logging strips query strings from older browser payloads", async (t) => {
  const authServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"authenticated":true}');
  });
  const authPort = await listenOnAvailablePort(authServer);
  t.after(() => authServer.close());

  const agentPort = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(agentPort),
      PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authPort}/api/verify`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  await waitFor(() => output.includes("Agent Terminal Web:"), 3000);
  const privateTitle = "PRIVATE_CLIENT_EVENT_TITLE";
  const response = await fetch(`http://127.0.0.1:${agentPort}/api/client-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "ws-error",
      path: `/session/view?attach=web-session&title=${privateTitle}&notificationDeviceId=private-device`,
      hostId: "personal",
      phase: "handshake",
      durationMs: 1500,
    }),
  });
  assert.equal(response.status, 200);
  await waitFor(() => output.includes('"event":"client-event"'), 1000);

  const clientEvent = output
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((event) => event?.event === "client-event");
  assert.equal(clientEvent?.path, "/session/view");
  assert.equal(clientEvent?.hostId, "personal");
  assert.equal(clientEvent?.phase, "handshake");
  assert.equal(clientEvent?.durationMs, 1500);
  assert.doesNotMatch(output, new RegExp(privateTitle));
  assert.doesNotMatch(output, /private-device/);
});

test("an invalid WebSocket frame does not terminate the Agent server", async (t) => {
  const authServer = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"authenticated":false}');
    }, 100);
  });
  const authPort = await listenOnAvailablePort(authServer);
  t.after(() => authServer.close());

  const agentPort = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(agentPort),
      PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authPort}/api/verify`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  await waitFor(() => output.includes("Agent Terminal Web:"), 3000);
  const socket = await openRawWebSocket(
    agentPort,
    "/terminal?attach=web-session-diagnostic&sessionId=codex-session-diagnostic&title=PRIVATE_TITLE",
  );
  socket.write(Buffer.from([0x81, 0x01, 0x78]));
  await new Promise((resolve) => socket.once("close", resolve));
  await delay(100);

  assert.equal(child.exitCode, null, output);
  const events = output
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const upgradeReceived = events.find((event) => event.event === "ws-upgrade-received");
  const upgradeComplete = events.find((event) => event.event === "ws-upgrade-complete");
  assert.equal(upgradeReceived?.path, "/terminal");
  assert.equal(upgradeReceived?.webSessionId, "web-session-diagnostic");
  assert.equal(upgradeReceived?.codexSessionId, "codex-session-diagnostic");
  assert.equal(upgradeReceived?.proxied, false);
  assert.equal(upgradeComplete?.path, "/terminal");
  assert.equal(typeof upgradeComplete?.durationMs, "number");
  assert.doesNotMatch(output, /PRIVATE_TITLE/);
  assert.match(output, /"event":"ws-error"/);
  assert.match(output, /WS_ERR_EXPECTED_MASK/);
});

async function openRawWebSocket(port, requestPath = "/terminal") {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const key = crypto.randomBytes(16).toString("base64");
  socket.write(
    [
      `GET ${requestPath} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );

  let response = "";
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve();
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
  return socket;
}

async function listenOnAvailablePort(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function reservePort() {
  const server = net.createServer();
  const port = await listenOnAvailablePort(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for Agent server startup");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
