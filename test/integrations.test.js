import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  deleteIntegrationCredential,
  IntegrationError,
  listIntegrations,
  readIntegrationCredential,
  saveIntegrationCredential,
} from "../lib/integrations.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const firstKey = "11111111111111111111111111111111";
const secondKey = "22222222222222222222222222222222";

test("integration credentials are write-only to the public status response and stored with restricted permissions", async (t) => {
  const store = await fs.mkdtemp(path.join(os.tmpdir(), "agent-integrations-"));
  t.after(() => fs.rm(store, { recursive: true, force: true }));

  const integration = await saveIntegrationCredential("amap", { apiKey: firstKey }, {
    root: store,
    fetchImpl: successfulAmapFetch,
  });
  assert.equal(integration.status.configured, true);
  assert.doesNotMatch(JSON.stringify(integration), new RegExp(firstKey));

  const file = path.join(store, "amap.json");
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal((await fs.stat(store)).mode & 0o777, 0o700);
  assert.equal((await readIntegrationCredential("amap", { root: store })).apiKey, firstKey);

  const listed = await listIntegrations({ root: store });
  assert.equal(listed[0].status.configured, true);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(firstKey));
});

test("replacing a credential atomically removes the old value and deleting clears status", async (t) => {
  const store = await fs.mkdtemp(path.join(os.tmpdir(), "agent-integrations-replace-"));
  t.after(() => fs.rm(store, { recursive: true, force: true }));

  await saveIntegrationCredential("amap", { apiKey: firstKey }, {
    root: store,
    fetchImpl: successfulAmapFetch,
  });
  await saveIntegrationCredential("amap", { apiKey: secondKey }, {
    root: store,
    fetchImpl: successfulAmapFetch,
  });

  const source = await fs.readFile(path.join(store, "amap.json"), "utf8");
  assert.doesNotMatch(source, new RegExp(firstKey));
  assert.match(source, new RegExp(secondKey));
  assert.equal(await deleteIntegrationCredential("amap", { root: store }), true);
  assert.equal((await listIntegrations({ root: store }))[0].status.configured, false);
});

test("invalid provider credentials are rejected before anything is written", async (t) => {
  const store = await fs.mkdtemp(path.join(os.tmpdir(), "agent-integrations-invalid-"));
  t.after(() => fs.rm(store, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      saveIntegrationCredential("amap", { apiKey: firstKey }, {
        root: store,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ status: "0", info: "INVALID_USER_KEY" }),
        }),
      }),
    (error) =>
      error instanceof IntegrationError &&
      error.status === 422 &&
      error.code === "integration_validation_failed",
  );
  await assert.rejects(() => fs.stat(path.join(store, "amap.json")), { code: "ENOENT" });
});

test("the MCP launcher gives the key to the provider child without requiring it in the parent environment", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-integration-launch-"));
  const store = path.join(temporary, "store");
  const bin = path.join(temporary, "bin");
  const marker = path.join(temporary, "marker");
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(bin, { recursive: true });
  await saveIntegrationCredential("amap", { apiKey: firstKey }, {
    root: store,
    fetchImpl: successfulAmapFetch,
  });

  const fakeNpx = path.join(bin, "npx");
  await fs.writeFile(
    fakeNpx,
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      `if (process.env.AMAP_MAPS_API_KEY !== ${JSON.stringify(firstKey)}) process.exit(41);`,
      `fs.writeFileSync(${JSON.stringify(marker)}, "received\\n");`,
      "process.stdout.write(`${JSON.stringify({ result: process.env.AMAP_MAPS_API_KEY })}\\n`);",
      "process.stderr.write(`provider key=${process.env.AMAP_MAPS_API_KEY}\\n`);",
    ].join("\n"),
    { mode: 0o700 },
  );

  const env = {
    ...process.env,
    AGENT_INTEGRATIONS_DIR: store,
    AGENT_MCP_NODE_BIN: bin,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  delete env.AMAP_MAPS_API_KEY;
  const child = spawn(process.execPath, ["scripts/integration-mcp-launch.mjs", "amap"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await childResult(child);
  assert.equal(result.code, 0, result.output);
  assert.equal(await fs.readFile(marker, "utf8"), "received\n");
  assert.equal(env.AMAP_MAPS_API_KEY, undefined);
  assert.doesNotMatch(result.output, new RegExp(firstKey));
  assert.match(result.output, /provider key=\[redacted\]/);
});

test("authenticated integration settings API supports set, status, replacement, and deletion without returning secrets", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-integration-api-"));
  const store = path.join(temporary, "integrations");
  const workspace = path.join(temporary, "workspace");
  const codexHome = path.join(temporary, "codex");
  await Promise.all([
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(codexHome, { recursive: true }),
  ]);

  const auth = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ authenticated: req.headers.cookie === "session=ok" }));
  });
  const provider = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "1", geocodes: [{ location: "116.4,39.9" }] }));
  });
  await Promise.all([listen(auth), listen(provider)]);
  t.after(async () => {
    await Promise.all([close(auth), close(provider)]);
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_HOME: codexHome,
      WORKSPACE_ROOT: workspace,
      AGENT_INTEGRATIONS_DIR: store,
      AGENT_AMAP_VALIDATION_URL: `http://127.0.0.1:${provider.address().port}/validate`,
      PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${auth.address().port}/verify`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  await waitFor(() => output.includes("Agent Terminal Web:"), 3_000);

  assert.equal((await fetch(`${origin}/api/integrations`)).status, 401);
  const headers = {
    cookie: "session=ok",
    origin,
    "content-type": "application/json",
  };
  const savedResponse = await fetch(`${origin}/api/integrations/amap`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ values: { apiKey: firstKey } }),
  });
  const saved = await savedResponse.json();
  assert.equal(savedResponse.status, 200);
  assert.equal(saved.integration.status.configured, true);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(firstKey));

  const statusResponse = await fetch(`${origin}/api/integrations`, {
    headers: { cookie: "session=ok" },
  });
  const status = await statusResponse.json();
  assert.equal(status.integrations[0].status.configured, true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(firstKey));

  const crossOrigin = await fetch(`${origin}/api/integrations/amap`, {
    method: "PUT",
    headers: { ...headers, origin: "https://example.com" },
    body: JSON.stringify({ values: { apiKey: secondKey } }),
  });
  assert.equal(crossOrigin.status, 403);

  const deleted = await fetch(`${origin}/api/integrations/amap`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).removed, true);
});

test("the Agent home exposes a generic write-only integrations interface", async () => {
  const [page, script, styles, server] = await Promise.all([
    fs.readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/agent-integrations.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/agent-integrations.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../server.js", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="open-integrations"/);
  assert.match(page, /id="integrations-dialog"/);
  assert.match(script, /type = "password"/);
  assert.match(script, /autocomplete = "new-password"/);
  assert.doesNotMatch(script, /localStorage/);
  assert.match(styles, /\.integration-status\[data-state="ready"\]/);
  assert.match(server, /app\.use\("\/api", requireAuth\)/);
  assert.match(server, /app\.put\("\/api\/integrations\/:integrationId", requireSafeIntegrationMutation/);
});

async function successfulAmapFetch() {
  return {
    ok: true,
    json: async () => ({ status: "1", geocodes: [{ location: "116.4,39.9" }] }),
  };
}

async function childResult(child) {
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, output };
}

async function reservePort() {
  const server = http.createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Agent server startup");
}
