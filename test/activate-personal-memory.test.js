import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const activationScript = new URL("../scripts/activate-personal-memory.mjs", import.meta.url);

test("Agent deployment atomically makes personal memory the only injected memory", async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "activate-personal-memory-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const configFile = path.join(codexHome, "config.toml");
  await fs.writeFile(
    configFile,
    "model = \"test\"\n\n[memories]\ngenerate_memories = true\nuse_memories = true\ndisable_on_external_context = false\n\n[notice]\nhide = true\n",
  );

  await execFileAsync(process.execPath, [activationScript.pathname], { env: { ...process.env, CODEX_HOME: codexHome } });
  const updated = await fs.readFile(configFile, "utf8");
  assert.match(updated, /generate_memories = true/);
  assert.match(updated, /use_memories = false/);
  assert.match(updated, /\[notice\]\nhide = true/);
});
