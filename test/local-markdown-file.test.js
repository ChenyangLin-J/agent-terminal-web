import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  localMarkdownVersion,
  saveLocalMarkdownFile,
} from "../lib/local-markdown-file.js";

test("concurrent Markdown saves with the same version cannot overwrite each other", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-markdown-save-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "notes.md");
  const initial = "# Initial\n";
  await fs.writeFile(filePath, initial, { mode: 0o640 });

  const expectedVersion = localMarkdownVersion(initial);
  const results = await Promise.allSettled([
    saveLocalMarkdownFile({ filePath, text: "# First\n", expectedVersion, maxBytes: 1024 }),
    saveLocalMarkdownFile({ filePath, text: "# Second\n", expectedVersion, maxBytes: 1024 }),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "local_markdown_conflict");
  assert.match(await fs.readFile(filePath, "utf8"), /^# (First|Second)\n$/);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o640);
});
