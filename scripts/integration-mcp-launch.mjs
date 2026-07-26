#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  integrationMcpLaunch,
  readIntegrationCredential,
} from "../lib/integrations.js";

const integrationId = String(process.argv[2] || "");

try {
  const [credential, launch] = await Promise.all([
    readIntegrationCredential(integrationId),
    Promise.resolve(integrationMcpLaunch(integrationId)),
  ]);
  if (!credential) throw new Error(`Integration "${integrationId}" is not configured in Agent Web.`);

  const env = { ...process.env };
  for (const [environmentName, fieldId] of Object.entries(launch.env)) {
    const value = credential[fieldId];
    if (!value) throw new Error(`Integration "${integrationId}" is missing a required credential.`);
    env[environmentName] = value;
  }

  const command = await providerCommand(launch.command);
  const child = spawn(command, launch.args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdin.pipe(child.stdin);
  forwardRedacted(child.stdout, process.stdout, Object.values(credential));
  forwardRedacted(child.stderr, process.stderr, Object.values(credential));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.once("error", (error) => {
    process.stderr.write(`Unable to start integration "${integrationId}": ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

async function providerCommand(command) {
  if (command !== "npx") return command;
  const preferred = await preferredNodeBin();
  return preferred ? path.join(preferred, "npx") : command;
}

async function preferredNodeBin() {
  const configured = String(process.env.AGENT_MCP_NODE_BIN || "").trim();
  if (configured) return path.resolve(configured);

  const nvmRoot = path.join(os.homedir(), ".nvm");
  try {
    const requested = (await fs.readFile(path.join(nvmRoot, "alias", "default"), "utf8")).trim();
    const versionsRoot = path.join(nvmRoot, "versions", "node");
    const versions = (await fs.readdir(versionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("v"))
      .map((entry) => entry.name)
      .filter((version) => versionMatches(version, requested))
      .sort(compareNodeVersions)
      .reverse();
    if (versions.length) return path.join(versionsRoot, versions[0], "bin");
  } catch {
    return "";
  }
  return "";
}

function versionMatches(version, requested) {
  const normalized = String(requested || "").replace(/^v/, "");
  if (!normalized || normalized === "node" || normalized === "stable" || normalized === "default") return true;
  const actual = version.replace(/^v/, "");
  return actual === normalized || actual.startsWith(`${normalized}.`);
}

function compareNodeVersions(left, right) {
  const leftParts = left.replace(/^v/, "").split(".").map(Number);
  const rightParts = right.replace(/^v/, "").split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function forwardRedacted(source, destination, secrets) {
  let buffer = "";
  source.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      destination.write(redact(buffer.slice(0, newline + 1), secrets));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  source.on("end", () => {
    if (buffer) destination.write(redact(buffer, secrets));
  });
}

function redact(value, secrets) {
  let result = String(value || "");
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join("[redacted]");
  }
  return result;
}
