import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AgentHostAppServerPool } from "../lib/agent-host-app-server.js";

test("one app-server connection is shared per execution host", async () => {
  const spawns = [];
  const pool = new AgentHostAppServerPool({
    spawnCwd: "/server/workspace",
    spawnImpl: (command, args, options) => {
      const child = fakeAppServer();
      spawns.push({ command, args, options, child });
      return child;
    },
  });
  const company = {
    id: "company",
    type: "ssh",
    sshHost: "company-mac",
    codexCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
  };

  const first = pool.clientFor(company, "/Users/mac/Documents/workspace/project-a");
  const second = pool.clientFor(company, "/Users/mac/Documents/workspace/project-b");
  await Promise.all([first.start(), second.start()]);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, "ssh");
  assert.deepEqual(spawns[0].args.slice(-5), [
    "company-mac",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "-c",
    "notify='[]'",
    "app-server",
  ]);
  assert.equal(spawns[0].options.cwd, "/server/workspace");
  assert.equal(first.cwd, "/Users/mac/Documents/workspace/project-a");
  assert.equal(second.cwd, "/Users/mac/Documents/workspace/project-b");

  first.close();
  assert.equal(spawns[0].child.killed, false);
  pool.close();
  assert.equal(spawns[0].child.killed, true);
});

test("personal and company hosts never share an app-server process", async () => {
  const spawns = [];
  const pool = new AgentHostAppServerPool({
    spawnCwd: "/server/workspace",
    localCommand: "/usr/bin/codex",
    spawnImpl: (command, args, options) => {
      const child = fakeAppServer();
      spawns.push({ command, args, options, child });
      return child;
    },
  });

  const personal = { id: "personal", type: "local" };
  const company = {
    id: "company",
    type: "ssh",
    sshHost: "company-mac",
    codexCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
  };
  const localClient = pool.clientFor(personal, "/server/workspace");
  const companyClient = pool.clientFor(company, "/Users/mac/Documents/workspace");
  await Promise.all([localClient.start(), companyClient.start()]);

  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns.map((spawn) => spawn.command), ["/usr/bin/codex", "ssh"]);
  pool.close();
});

function fakeAppServer() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", 0, null);
  };
  child.stdin.on("data", (chunk) => {
    const message = JSON.parse(String(chunk).trim());
    if (message.method !== "initialize") return;
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { platformOs: "darwin" } })}\n`);
    });
  });
  return child;
}
