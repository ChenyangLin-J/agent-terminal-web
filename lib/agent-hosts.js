import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SSH_ALIAS_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const SAFE_REMOTE_COMMAND_PATTERN = /^\/[a-zA-Z0-9_./+-]+$/;

export function loadAgentHosts({
  filePath = "",
  localWorkspaceRoot,
  localCodexCommand = "codex",
} = {}) {
  const localRoot = path.resolve(String(localWorkspaceRoot || process.cwd()));
  const hosts = [
    {
      id: "personal",
      label: "个人",
      type: "local",
      workspaceRoot: localRoot,
      codexCommand: String(localCodexCommand || "codex"),
      projects: [],
      configured: true,
    },
  ];

  const configuredPath = String(filePath || "").trim();
  if (!configuredPath) return hosts;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configuredPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return hosts;
    throw new Error(`Agent host config is invalid: ${error.message}`);
  }

  const entries = Array.isArray(parsed) ? parsed : parsed?.hosts;
  if (!Array.isArray(entries)) throw new Error("Agent host config must contain a hosts array.");

  const ids = new Set(hosts.map((host) => host.id));
  for (const entry of entries) {
    const host = normalizeRemoteHost(entry);
    if (ids.has(host.id)) throw new Error(`Agent host id is duplicated: ${host.id}`);
    ids.add(host.id);
    hosts.push(host);
  }
  return hosts;
}

export function publicAgentHost(host) {
  return {
    id: host.id,
    label: host.label,
    type: host.type,
    workspaceRoot: host.workspaceRoot,
    projects: [...host.projects],
    configured: host.configured !== false,
  };
}

export function resolveAgentHost(hosts, value) {
  const id = String(value || "personal").trim() || "personal";
  return hosts.find((host) => host.id === id) || null;
}

export function resolveAgentHostPath(host, value = ".") {
  if (!host) return null;
  if (host.type === "local") {
    const root = path.resolve(host.workspaceRoot);
    const requested = path.resolve(root, String(value || "."));
    const relative = path.relative(root, requested);
    return relative.startsWith("..") || path.isAbsolute(relative) ? null : requested;
  }

  const root = path.posix.resolve(host.workspaceRoot);
  const requested = path.posix.resolve(root, String(value || "."));
  const relative = path.posix.relative(root, requested);
  return relative.startsWith("..") || path.posix.isAbsolute(relative) ? null : requested;
}

export function agentHostProject(host, cwd) {
  if (!host || !cwd) return ".";
  const pathApi = host.type === "local" ? path : path.posix;
  const relative = pathApi.relative(host.workspaceRoot, cwd);
  if (!relative || relative === ".") return ".";
  if (relative.startsWith("..") || pathApi.isAbsolute(relative)) return ".";
  return relative;
}

export function remoteAppServerSpawn(host) {
  if (host?.type !== "ssh") throw new TypeError("A remote SSH host is required.");
  return {
    command: "ssh",
    args: [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      host.sshHost,
      host.codexCommand,
      "-c",
      "notify='[]'",
      "app-server",
    ],
  };
}

export function defaultAgentHostsFile() {
  return path.join(os.homedir(), ".config", "agent-terminal-web", "hosts.json");
}

function normalizeRemoteHost(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Each Agent host must be an object.");
  }

  const id = String(entry.id || "").trim();
  const label = String(entry.label || "").trim();
  const type = String(entry.type || "").trim();
  const sshHost = String(entry.sshHost || "").trim();
  const workspaceRoot = path.posix.normalize(String(entry.workspaceRoot || "").trim());
  const codexCommand = String(entry.codexCommand || "").trim();
  const projects = normalizeProjects(entry.projects);

  if (!HOST_ID_PATTERN.test(id) || id === "personal") {
    throw new Error(`Agent host id is invalid: ${id || "(empty)"}`);
  }
  if (!label || label.length > 40) throw new Error(`Agent host label is invalid: ${id}`);
  if (type !== "ssh") throw new Error(`Agent host type is unsupported: ${type || "(empty)"}`);
  if (!SSH_ALIAS_PATTERN.test(sshHost)) throw new Error(`Agent SSH host alias is invalid: ${id}`);
  if (!path.posix.isAbsolute(workspaceRoot)) throw new Error(`Agent workspace root must be absolute: ${id}`);
  if (!SAFE_REMOTE_COMMAND_PATTERN.test(codexCommand)) {
    throw new Error(`Agent Codex command must be a safe absolute path: ${id}`);
  }

  return {
    id,
    label,
    type,
    sshHost,
    workspaceRoot,
    codexCommand,
    projects,
    configured: true,
  };
}

function normalizeProjects(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Agent host projects must be an array.");
  const projects = [];
  for (const item of value) {
    const project = String(item || "").trim().replaceAll("\\", "/");
    if (!project || project.startsWith("/") || project.includes("..") || project.includes("\0")) {
      throw new Error(`Agent host project is invalid: ${project || "(empty)"}`);
    }
    if (!projects.includes(project)) projects.push(project);
  }
  return projects;
}
