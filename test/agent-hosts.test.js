import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentHostProject,
  loadAgentHosts,
  publicAgentHost,
  remoteAppServerSpawn,
  resolveAgentHost,
  resolveAgentHostPath,
} from "../lib/agent-hosts.js";

test("Agent hosts keep the personal workspace local and load a bounded SSH host", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hosts-"));
  const config = path.join(root, "hosts.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    config,
    JSON.stringify({
      hosts: [
        {
          id: "company",
          label: "公司",
          type: "ssh",
          sshHost: "company-mac",
          workspaceRoot: "/Users/mac/Documents/workspace",
          codexCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
          projects: ["solvely", "analytics/tools"],
        },
      ],
    }),
  );

  const hosts = loadAgentHosts({ filePath: config, localWorkspaceRoot: "/srv/workspace" });
  assert.deepEqual(hosts.map((host) => host.id), ["personal", "company"]);
  assert.deepEqual(publicAgentHost(hosts[1]), {
    id: "company",
    label: "公司",
    type: "ssh",
    workspaceRoot: "/Users/mac/Documents/workspace",
    projects: ["solvely", "analytics/tools"],
    configured: true,
  });
  assert.equal(resolveAgentHost(hosts, "company"), hosts[1]);
  assert.equal(resolveAgentHost(hosts, "missing"), null);
});

test("Agent host paths stay inside the selected host workspace", () => {
  const personal = {
    id: "personal",
    type: "local",
    workspaceRoot: "/srv/workspace",
  };
  const company = {
    id: "company",
    type: "ssh",
    workspaceRoot: "/Users/mac/Documents/workspace",
  };

  assert.equal(resolveAgentHostPath(personal, "project"), "/srv/workspace/project");
  assert.equal(resolveAgentHostPath(personal, "../private"), null);
  assert.equal(
    resolveAgentHostPath(company, "project/src"),
    "/Users/mac/Documents/workspace/project/src",
  );
  assert.equal(resolveAgentHostPath(company, "../../.ssh"), null);
  assert.equal(agentHostProject(company, "/Users/mac/Documents/workspace/project"), "project");
});

test("remote app-server uses SSH stdio and the Mac Codex absolute path", () => {
  const spawn = remoteAppServerSpawn({
    type: "ssh",
    sshHost: "company-mac",
    codexCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
  });

  assert.equal(spawn.command, "ssh");
  assert.deepEqual(spawn.args.slice(-3), [
    "company-mac",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "app-server",
  ]);
  assert.ok(spawn.args.includes("BatchMode=yes"));
});

test("Agent host config rejects shell-shaped SSH and Codex values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hosts-invalid-"));
  const config = path.join(root, "hosts.json");
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(
    config,
    JSON.stringify({
      hosts: [
        {
          id: "company",
          label: "公司",
          type: "ssh",
          sshHost: "company;touch-pwned",
          workspaceRoot: "/Users/mac/Documents/workspace",
          codexCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
        },
      ],
    }),
  );
  assert.throws(
    () => loadAgentHosts({ filePath: config, localWorkspaceRoot: "/srv/workspace" }),
    /SSH host alias is invalid/,
  );
});
