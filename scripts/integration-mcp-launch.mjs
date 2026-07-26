#!/usr/bin/env node

import { spawn } from "node:child_process";
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

  const child = spawn(launch.command, launch.args, {
    env,
    stdio: "inherit",
  });
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
