import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  gardenLinkForLocalMarkdown,
  workspaceFileForLocalHref,
} from "../lib/local-file-link.js";
import { localFilePresentation } from "../lib/local-file-view.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("local Obsidian Markdown paths resolve to Garden URLs", () => {
  const vaultRoot = "/home/ubuntu/workspace/obsidian/MainVault";
  const options = { vaultRoot, gardenBaseUrl: "https://garden.chenyanglin.com" };

  assert.equal(
    gardenLinkForLocalMarkdown(`${vaultRoot}/Work/Tasks.md`, options)?.href,
    "https://garden.chenyanglin.com/work/tasks",
  );
  assert.equal(
    gardenLinkForLocalMarkdown(`${vaultRoot}/Life/职业思考.md`, options)?.href,
    "https://garden.chenyanglin.com/life/%E8%81%8C%E4%B8%9A%E6%80%9D%E8%80%83",
  );
  assert.equal(gardenLinkForLocalMarkdown(`${vaultRoot}/Work/index.md`, options)?.href, "https://garden.chenyanglin.com/work");
  assert.equal(gardenLinkForLocalMarkdown("/home/ubuntu/workspace/personal-site/README.md", options), null);
  assert.equal(gardenLinkForLocalMarkdown(`${vaultRoot}/Work/Tasks.pdf`, options), null);
});

test("workspace links preserve line numbers and select safe presentations", () => {
  const workspaceRoot = "/home/ubuntu/workspace";
  assert.deepEqual(workspaceFileForLocalHref(`${workspaceRoot}/agent-terminal-web/server.js:196`, workspaceRoot), {
    filePath: `${workspaceRoot}/agent-terminal-web/server.js`,
    relativePath: "agent-terminal-web/server.js",
    line: 196,
    fragment: "",
  });
  assert.equal(workspaceFileForLocalHref("/etc/passwd", workspaceRoot), null);
  assert.equal(localFilePresentation("report.pdf", 100, { maxTextBytes: 200, maxPreviewBytes: 500 }).kind, "inline");
  assert.equal(localFilePresentation("page.html", 100, { maxTextBytes: 200, maxPreviewBytes: 500 }).kind, "sandbox");
  assert.equal(localFilePresentation("app.js", 100, { maxTextBytes: 200, maxPreviewBytes: 500 }).kind, "text");
  assert.equal(localFilePresentation("Dockerfile", 100, { maxTextBytes: 200, maxPreviewBytes: 500 }).kind, "text");
  assert.equal(localFilePresentation("large.js", 600, { maxTextBytes: 200, maxPreviewBytes: 500 }).kind, "download");
});

test("the authenticated local-link route safely opens workspace files", async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-local-link-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const codexHome = path.join(temporaryRoot, "codex");
  const vaultRoot = path.join(workspaceRoot, "obsidian", "MainVault");
  const taskFile = path.join(vaultRoot, "Work", "Tasks.md");
  const projectRoot = path.join(workspaceRoot, "project");
  const textFile = path.join(projectRoot, "app.js");
  const htmlFile = path.join(projectRoot, "preview.html");
  const imageFile = path.join(projectRoot, "image.png");
  const binaryFile = path.join(projectRoot, "archive.bin");
  const escapedLink = path.join(projectRoot, "outside.txt");
  await fs.mkdir(path.dirname(taskFile), { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(taskFile, "# Tasks\n");
  await fs.writeFile(textFile, 'const safe = true;\n<script>alert("x")</script>\nreturn safe;\n');
  await fs.writeFile(htmlFile, '<h1>Preview</h1><script>globalThis.bad = true</script>\n');
  await fs.writeFile(imageFile, Buffer.from("89504e470d0a1a0a", "hex"));
  await fs.writeFile(binaryFile, Buffer.from([0, 1, 2, 3]));
  await fs.symlink("/etc/passwd", escapedLink);

  let authenticated = true;
  const authServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ authenticated }));
  });
  const authPort = await listen(authServer);
  const agentPort = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(agentPort),
      CODEX_HOME: codexHome,
      WORKSPACE_ROOT: workspaceRoot,
      PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    authServer.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });
  await waitFor(() => output.includes("Agent Terminal Web:"), 3000);

  const redirect = await fetch(
    `http://127.0.0.1:${agentPort}/open/local?path=${encodeURIComponent(taskFile)}`,
    { redirect: "manual" },
  );
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://garden.chenyanglin.com/work/tasks");

  const textPreview = await fetch(
    `http://127.0.0.1:${agentPort}/open/local?path=${encodeURIComponent(`${textFile}:2`)}`,
  );
  const textPage = await textPreview.text();
  assert.equal(textPreview.status, 200);
  assert.match(textPreview.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(textPage, /<li id="L2" class="highlight">/);
  assert.match(textPage, /&lt;script&gt;alert\("x"\)&lt;\/script&gt;/);

  const htmlPreview = await fetch(
    `http://127.0.0.1:${agentPort}/open/local?path=${encodeURIComponent(htmlFile)}`,
  );
  const htmlPage = await htmlPreview.text();
  assert.equal(htmlPreview.status, 200);
  assert.match(htmlPage, /<iframe sandbox srcdoc=/);
  assert.match(htmlPage, /&lt;script&gt;globalThis\.bad = true&lt;\/script&gt;/);

  const imagePreview = await fetch(
    `http://127.0.0.1:${agentPort}/open/local?path=${encodeURIComponent(imageFile)}`,
  );
  assert.equal(imagePreview.status, 200);
  assert.equal(imagePreview.headers.get("content-type"), "image/png");

  const download = await fetch(
    `http://127.0.0.1:${agentPort}/open/local?path=${encodeURIComponent(binaryFile)}`,
  );
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment; filename="archive\.bin"/);

  const rejected = await fetch(
    `http://127.0.0.1:${agentPort}/open/local?path=${encodeURIComponent("/etc/passwd")}`,
    { redirect: "manual" },
  );
  assert.equal(rejected.status, 404);

  const symlinkRejected = await fetch(
    `http://127.0.0.1:${agentPort}/open/local?path=${encodeURIComponent(escapedLink)}`,
    { redirect: "manual" },
  );
  assert.equal(symlinkRejected.status, 404);

  authenticated = false;
  const loginRedirect = await fetch(
    `http://127.0.0.1:${agentPort}/open/local?path=${encodeURIComponent(textFile)}`,
    { redirect: "manual" },
  );
  assert.equal(loginRedirect.status, 302);
  assert.match(loginRedirect.headers.get("location"), /^https:\/\/auth\.chenyanglin\.com\/login\?/);
});

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Agent server startup");
}
