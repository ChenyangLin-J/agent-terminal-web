import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cuboxConfigRoot,
  deleteIntegrationCredential,
  IntegrationError,
  listIntegrations,
  readIntegrationCredential,
  saveIntegrationCredential,
} from "../lib/integrations.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const firstKey = "11111111111111111111111111111111";
const secondKey = "22222222222222222222222222222222";
const cuboxToken = "cubox_test_token_1234567890";
const cuboxApiLink = `https://cubox.pro/c/api/save/${cuboxToken}`;

test("Cubox config directory environment overrides are test-only", (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOverride = process.env.AGENT_CUBOX_CONFIG_DIR;
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousOverride === undefined) delete process.env.AGENT_CUBOX_CONFIG_DIR;
    else process.env.AGENT_CUBOX_CONFIG_DIR = previousOverride;
  });

  process.env.NODE_ENV = "production";
  process.env.AGENT_CUBOX_CONFIG_DIR = "/tmp/ignored-cubox-config";
  assert.equal(cuboxConfigRoot(), path.join(os.homedir(), ".config", "cubox-cli"));

  process.env.NODE_ENV = "test";
  assert.equal(cuboxConfigRoot(), "/tmp/ignored-cubox-config");
});

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

test("Cubox API links are validated against the fixed domestic endpoint and stored only in the CLI config", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cubox-integration-"));
  const store = path.join(temporary, "integrations");
  const cuboxConfigDir = path.join(temporary, "cubox-cli");
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  let validationRequest;
  const integration = await saveIntegrationCredential("cubox", { apiLink: cuboxApiLink }, {
    root: store,
    cuboxConfigDir,
    fetchImpl: async (url, options) => {
      validationRequest = { url: String(url), options };
      return successfulCuboxResponse();
    },
  });

  assert.equal(validationRequest.url, "https://cubox.pro/c/api/cli/folder/list");
  assert.equal(validationRequest.options.headers.authorization, `Bearer ${cuboxToken}`);
  assert.equal(integration.status.configured, true);
  assert.doesNotMatch(JSON.stringify(integration), new RegExp(cuboxToken));
  assert.equal(integration.docsUrl, "https://cubox.pro/web/settings/extensions");
  assert.equal(integration.docsLabel, "获取 API Link");

  const file = path.join(cuboxConfigDir, "config.json");
  const config = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(config, { server: "cubox.pro", token: cuboxToken });
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /c\/api\/save/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(cuboxConfigDir)).mode & 0o777, 0o700);
  await assert.rejects(() => fs.stat(path.join(store, "cubox.json")), { code: "ENOENT" });

  const listed = await listIntegrations({ root: store, cuboxConfigDir });
  const cubox = listed.find((item) => item.id === "cubox");
  assert.equal(cubox.status.configured, true);
  assert.doesNotMatch(JSON.stringify(cubox), new RegExp(cuboxToken));
  assert.deepEqual(
    await readIntegrationCredential("cubox", { root: store, cuboxConfigDir }),
    { server: "cubox.pro", token: cuboxToken },
  );

  assert.equal(await deleteIntegrationCredential("cubox", { root: store, cuboxConfigDir }), true);
  assert.equal(
    (await listIntegrations({ root: store, cuboxConfigDir })).find((item) => item.id === "cubox")
      .status.configured,
    false,
  );
});

test("Cubox rejects non-domestic or malformed links before any request or config write", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cubox-invalid-"));
  const cuboxConfigDir = path.join(temporary, "cubox-cli");
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const invalidLinks = [
    `http://cubox.pro/c/api/save/${cuboxToken}`,
    `https://cubox.cc/c/api/save/${cuboxToken}`,
    `https://cubox.pro.example.com/c/api/save/${cuboxToken}`,
    `https://cubox.pro/c/api/save/${cuboxToken}?redirect=https://example.com`,
    `https://cubox.pro/c/api/other/${cuboxToken}`,
  ];
  let fetchCalls = 0;

  for (const apiLink of invalidLinks) {
    await assert.rejects(
      () =>
        saveIntegrationCredential("cubox", { apiLink }, {
          cuboxConfigDir,
          fetchImpl: async () => {
            fetchCalls += 1;
            return successfulCuboxResponse();
          },
        }),
      (error) =>
        error instanceof IntegrationError &&
        error.status === 400 &&
        error.code === "integration_value_invalid",
    );
  }

  assert.equal(fetchCalls, 0);
  await assert.rejects(() => fs.stat(path.join(cuboxConfigDir, "config.json")), { code: "ENOENT" });
});

test("Cubox authentication failures do not persist or echo the API token", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cubox-rejected-"));
  const cuboxConfigDir = path.join(temporary, "cubox-cli");
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  await saveIntegrationCredential("cubox", { apiLink: cuboxApiLink }, {
    cuboxConfigDir,
    fetchImpl: async () => successfulCuboxResponse(),
  });
  const original = await fs.readFile(path.join(cuboxConfigDir, "config.json"), "utf8");

  let rejected;
  try {
    await saveIntegrationCredential("cubox", {
      apiLink: `https://cubox.pro/c/api/save/rejected_token_12345678`,
    }, {
      cuboxConfigDir,
      fetchImpl: async () => ({ ok: false, status: 401 }),
    });
  } catch (error) {
    rejected = error;
  }

  assert.ok(rejected instanceof IntegrationError);
  assert.equal(rejected.status, 422);
  assert.equal(rejected.code, "integration_validation_failed");
  assert.doesNotMatch(rejected.message, new RegExp(cuboxToken));
  assert.equal(await fs.readFile(path.join(cuboxConfigDir, "config.json"), "utf8"), original);
});

test("Cubox save and delete are serialized so a completed delete cannot be undone by a late save", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cubox-race-"));
  const cuboxConfigDir = path.join(temporary, "cubox-cli");
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  let validationStarted;
  const started = new Promise((resolve) => {
    validationStarted = resolve;
  });
  let releaseValidation;
  const validation = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  const saving = saveIntegrationCredential("cubox", { apiLink: cuboxApiLink }, {
    cuboxConfigDir,
    fetchImpl: async () => {
      validationStarted();
      await validation;
      return successfulCuboxResponse();
    },
  });
  await started;
  const deleting = deleteIntegrationCredential("cubox", { cuboxConfigDir });
  releaseValidation();

  await saving;
  assert.equal(await deleting, true);
  await assert.rejects(() => fs.stat(path.join(cuboxConfigDir, "config.json")), { code: "ENOENT" });
});

test("Cubox domestic setup requires explicit confirmation before replacing an international CLI login", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cubox-server-conflict-"));
  const cuboxConfigDir = path.join(temporary, "cubox-cli");
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(cuboxConfigDir, { mode: 0o700 });
  await fs.writeFile(
    path.join(cuboxConfigDir, "config.json"),
    `${JSON.stringify({ server: "cubox.cc", token: "international_token_123456" })}\n`,
    { mode: 0o600 },
  );

  const status = (await listIntegrations({ cuboxConfigDir })).find((item) => item.id === "cubox");
  assert.equal(status.status.configured, false);
  assert.equal(status.status.state, "conflict");
  assert.equal(status.status.canReplace, true);
  assert.doesNotMatch(JSON.stringify(status), /international_token/);
  await assert.rejects(
    () => deleteIntegrationCredential("cubox", { cuboxConfigDir }),
    (error) => error instanceof IntegrationError && error.status === 409,
  );
  await assert.rejects(
    () =>
      saveIntegrationCredential("cubox", { apiLink: cuboxApiLink }, {
        cuboxConfigDir,
        fetchImpl: async () => successfulCuboxResponse(),
      }),
    (error) =>
      error instanceof IntegrationError &&
      error.status === 409 &&
      error.code === "integration_server_conflict",
  );

  const replaced = await saveIntegrationCredential("cubox", { apiLink: cuboxApiLink }, {
    cuboxConfigDir,
    confirmReplace: true,
    fetchImpl: async () => successfulCuboxResponse(),
  });
  assert.equal(replaced.status.configured, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cuboxConfigDir, "config.json"), "utf8")), {
    server: "cubox.pro",
    token: cuboxToken,
  });
});

test("a malformed Cubox config is isolated to its card and can be repaired safely", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cubox-malformed-"));
  const store = path.join(temporary, "integrations");
  const cuboxConfigDir = path.join(temporary, "cubox-cli");
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await saveIntegrationCredential("amap", { apiKey: firstKey }, {
    root: store,
    fetchImpl: successfulAmapFetch,
  });
  await fs.mkdir(cuboxConfigDir, { mode: 0o700 });
  await fs.writeFile(path.join(cuboxConfigDir, "config.json"), "{broken\n", { mode: 0o600 });

  const listed = await listIntegrations({ root: store, cuboxConfigDir });
  assert.equal(listed.find((item) => item.id === "amap").status.state, "ready");
  assert.equal(listed.find((item) => item.id === "cubox").status.state, "error");

  const repaired = await saveIntegrationCredential("cubox", { apiLink: cuboxApiLink }, {
    cuboxConfigDir,
    fetchImpl: async () => successfulCuboxResponse(),
  });
  assert.equal(repaired.status.state, "ready");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cuboxConfigDir, "config.json"), "utf8")), {
    server: "cubox.pro",
    token: cuboxToken,
  });
});

test("Cubox environment overrides block misleading file mutations without exposing values", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cubox-env-conflict-"));
  const cuboxConfigDir = path.join(temporary, "cubox-cli");
  const cuboxEnvironment = { server: false, token: true };
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  const status = (await listIntegrations({ cuboxConfigDir, cuboxEnvironment }))
    .find((item) => item.id === "cubox");
  assert.equal(status.status.state, "conflict");
  assert.equal(status.status.canReplace, false);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(cuboxToken));
  await assert.rejects(
    () =>
      saveIntegrationCredential("cubox", { apiLink: cuboxApiLink }, {
        cuboxConfigDir,
        cuboxEnvironment,
        fetchImpl: async () => successfulCuboxResponse(),
      }),
    (error) =>
      error instanceof IntegrationError &&
      error.status === 409 &&
      error.code === "integration_environment_conflict",
  );
  await assert.rejects(
    () => deleteIntegrationCredential("cubox", { cuboxConfigDir, cuboxEnvironment }),
    (error) => error instanceof IntegrationError && error.status === 409,
  );
});

test("Cubox flags unsafe config files and atomically replaces a symlink without touching its target", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cubox-symlink-"));
  const cuboxConfigDir = path.join(temporary, "cubox-cli");
  const target = path.join(temporary, "target.json");
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(cuboxConfigDir, { mode: 0o700 });
  await fs.writeFile(target, "do not replace\n", { mode: 0o600 });
  await fs.symlink(target, path.join(cuboxConfigDir, "config.json"));

  const status = (await listIntegrations({ cuboxConfigDir })).find((item) => item.id === "cubox");
  assert.equal(status.status.state, "error");
  await saveIntegrationCredential("cubox", { apiLink: cuboxApiLink }, {
    cuboxConfigDir,
    fetchImpl: async () => successfulCuboxResponse(),
  });

  assert.equal(await fs.readFile(target, "utf8"), "do not replace\n");
  assert.equal((await fs.lstat(path.join(cuboxConfigDir, "config.json"))).isFile(), true);
  assert.equal((await fs.stat(path.join(cuboxConfigDir, "config.json"))).mode & 0o777, 0o600);
});

test("Cubox treats broadly readable configs as unsafe and repairs permissions on replacement", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cubox-permissions-"));
  const cuboxConfigDir = path.join(temporary, "cubox-cli");
  const file = path.join(cuboxConfigDir, "config.json");
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(cuboxConfigDir, { mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify({ server: "cubox.pro", token: cuboxToken })}\n`, {
    mode: 0o644,
  });

  const status = (await listIntegrations({ cuboxConfigDir })).find((item) => item.id === "cubox");
  assert.equal(status.status.state, "error");
  await saveIntegrationCredential("cubox", { apiLink: cuboxApiLink }, {
    cuboxConfigDir,
    fetchImpl: async () => successfulCuboxResponse(),
  });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("Cubox treats a non-private config directory as unsafe and repairs it on replacement", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cubox-directory-permissions-"));
  const cuboxConfigDir = path.join(temporary, "cubox-cli");
  const file = path.join(cuboxConfigDir, "config.json");
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(cuboxConfigDir, { mode: 0o700 });
  await fs.chmod(cuboxConfigDir, 0o777);
  await fs.writeFile(file, `${JSON.stringify({ server: "cubox.pro", token: cuboxToken })}\n`, {
    mode: 0o600,
  });

  const status = (await listIntegrations({ cuboxConfigDir })).find((item) => item.id === "cubox");
  assert.equal(status.status.state, "error");
  await saveIntegrationCredential("cubox", { apiLink: cuboxApiLink }, {
    cuboxConfigDir,
    fetchImpl: async () => successfulCuboxResponse(),
  });
  assert.equal((await fs.stat(cuboxConfigDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
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
  const cuboxConfigDir = path.join(temporary, "cubox-cli");
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
  const provider = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/cubox") {
      res.end(JSON.stringify({ code: 200, data: [] }));
      return;
    }
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
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_HOME: codexHome,
      WORKSPACE_ROOT: workspace,
      AGENT_INTEGRATIONS_DIR: store,
      AGENT_CUBOX_CONFIG_DIR: cuboxConfigDir,
      AGENT_AMAP_VALIDATION_URL: `http://127.0.0.1:${provider.address().port}/validate`,
      AGENT_CUBOX_VALIDATION_URL: `http://127.0.0.1:${provider.address().port}/cubox`,
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

  const cuboxSavedResponse = await fetch(`${origin}/api/integrations/cubox`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ values: { apiLink: cuboxApiLink } }),
  });
  const cuboxSaved = await cuboxSavedResponse.json();
  assert.equal(cuboxSavedResponse.status, 200);
  assert.equal(cuboxSaved.integration.status.configured, true);
  assert.doesNotMatch(JSON.stringify(cuboxSaved), new RegExp(cuboxToken));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cuboxConfigDir, "config.json"), "utf8")), {
    server: "cubox.pro",
    token: cuboxToken,
  });

  const statusResponse = await fetch(`${origin}/api/integrations`, {
    headers: { cookie: "session=ok" },
  });
  const status = await statusResponse.json();
  assert.equal(status.integrations[0].status.configured, true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(firstKey));
  assert.equal(status.integrations.find((item) => item.id === "cubox").status.configured, true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(cuboxToken));

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

  const cuboxDeleted = await fetch(`${origin}/api/integrations/cubox`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(cuboxDeleted.status, 200);
  assert.equal((await cuboxDeleted.json()).removed, true);
  await assert.rejects(() => fs.stat(path.join(cuboxConfigDir, "config.json")), { code: "ENOENT" });
  assert.doesNotMatch(output, new RegExp(cuboxToken));
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
  assert.match(script, /integration\.docsLabel/);
  assert.match(script, /confirmReplace/);
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

function successfulCuboxResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: 200, data: [] }),
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
