import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readLocalMarkdown, saveLocalMarkdown } from "../lib/local-markdown.js";

test("Markdown saves are versioned, atomic, serialized, and conflict-safe", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-markdown-"));
  const filePath = path.join(root, "notes.md");
  await fs.writeFile(filePath, "# Initial\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const initial = await readLocalMarkdown(filePath);
  const saved = await saveLocalMarkdown(filePath, {
    content: "# Saved\n",
    version: initial.version,
  });
  assert.equal(saved.content, "# Saved\n");
  assert.notEqual(saved.version, initial.version);
  await assert.rejects(
    saveLocalMarkdown(filePath, { content: "# Overwrite\n", version: initial.version }),
    (error) => error.code === "DOCUMENT_VERSION_CONFLICT" && error.statusCode === 409,
  );
  assert.equal(await fs.readFile(filePath, "utf8"), "# Saved\n");
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("Markdown writer rejects unsupported files and oversized content", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-markdown-limits-"));
  const textPath = path.join(root, "notes.txt");
  const markdownPath = path.join(root, "notes.md");
  await Promise.all([fs.writeFile(textPath, "text"), fs.writeFile(markdownPath, "md")]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const text = await readLocalMarkdown(textPath);
  await assert.rejects(
    saveLocalMarkdown(textPath, { content: "changed", version: text.version }),
    (error) => error.code === "DOCUMENT_EDIT_UNSUPPORTED" && error.statusCode === 415,
  );
  const markdown = await readLocalMarkdown(markdownPath);
  await assert.rejects(
    saveLocalMarkdown(markdownPath, { content: "12345", version: markdown.version, maxBytes: 4 }),
    (error) => error.code === "DOCUMENT_TOO_LARGE" && error.statusCode === 413,
  );
});
