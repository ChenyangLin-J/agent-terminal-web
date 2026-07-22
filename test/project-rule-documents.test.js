import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readProjectRuleDocuments } from "../lib/project-rule-documents.js";

test("project-rule documents include only direct workspace AGENTS.md files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-project-rules-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "alpha", "nested"), { recursive: true });
  await fs.mkdir(path.join(root, "beta"), { recursive: true });
  await fs.writeFile(path.join(root, "alpha", "AGENTS.md"), "# Alpha\n");
  await fs.writeFile(path.join(root, "alpha", "nested", "AGENTS.md"), "# Nested\n");

  const all = await readProjectRuleDocuments(root);
  assert.deepEqual(all.documents.map((document) => document.project), ["alpha"]);
  assert.equal(all.documents[0].content, "# Alpha\n");

  const selected = await readProjectRuleDocuments(root, JSON.stringify(["alpha", "beta", "alpha/nested", "../outside"]));
  assert.deepEqual(selected.selectedProjects, ["alpha", "beta"]);
  assert.deepEqual(selected.documents.map((document) => document.project), ["alpha"]);
});
