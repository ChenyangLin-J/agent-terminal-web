import assert from "node:assert/strict";
import test from "node:test";
import { commandDisplayText } from "../lib/command-display.js";

test("shell launch wrappers are removed from displayed commands", () => {
  assert.equal(commandDisplayText(["/bin/bash", "-lc", "git status --short"]), "git status --short");
  assert.equal(
    commandDisplayText("/bin/bash -lc 'git show --stat --oneline --summary HEAD'"),
    "git show --stat --oneline --summary HEAD",
  );
  assert.equal(commandDisplayText(["npm", "test"]), "npm test");
});
