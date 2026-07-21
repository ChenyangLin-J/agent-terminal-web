#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configFile = path.join(codexHome, "config.toml");
const config = await fs.readFile(configFile, "utf8");
const memoriesBlock = config.match(/^\[memories\]\s*\n(?:^(?!\[).*(?:\n|$))*/m)?.[0] || "";

if (!memoriesBlock) throw new Error("Codex config has no [memories] section; refusing a partial memory deployment.");
if (!/^generate_memories\s*=\s*true\s*$/m.test(memoriesBlock)) {
  throw new Error("Native memory generation must remain enabled for the personal memory deployment.");
}
if (!/^use_memories\s*=\s*(true|false)\s*$/m.test(memoriesBlock)) {
  throw new Error("Codex config has no valid use_memories setting.");
}
if (/^use_memories\s*=\s*false\s*$/m.test(memoriesBlock)) process.exit(0);

const updatedBlock = memoriesBlock.replace(/^use_memories\s*=\s*true\s*$/m, "use_memories = false");
const updatedConfig = config.replace(memoriesBlock, updatedBlock);
const tempFile = `${configFile}.${process.pid}.tmp`;
await fs.writeFile(tempFile, updatedConfig, { mode: 0o600 });
await fs.rename(tempFile, configFile);
console.log("Personal memory is primary; native use_memories is disabled.");
