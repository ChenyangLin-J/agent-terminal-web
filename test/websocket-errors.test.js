import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  const socket = await openRawWebSocket(agentPort);
  socket.write(Buffer.from([0x81, 0x01, 0x78]));
  await new Promise((resolve) => socket.once("close", resolve));
  await delay(100);

  assert.equal(child.exitCode, null, output);
  assert.match(output, /"event":"ws-error"/);
  assert.match(output, /WS_ERR_EXPECTED_MASK/);
});

async function openRawWebSocket(port) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const key = crypto.randomBytes(16).toString("base64");
  socket.write(
    [
      "GET /terminal HTTP/1.1",
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
