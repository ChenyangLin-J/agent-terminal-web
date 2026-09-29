import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fileAttachmentPromptText, isAttachmentPromptText } from "../lib/attachment-prompt.js";

test("file attachments reach the model as a tagged text item with absolute paths", () => {
  const text = fileAttachmentPromptText([
    { originalName: "共读草稿.md", path: "/home/ubuntu/workspace/uploads/2026-09-29/共读草稿.md" },
    { originalName: "Dia Recovery Kit.pdf", path: "/home/ubuntu/workspace/uploads/2026-09-29/Dia Recovery Kit.pdf" },
  ]);
  assert.match(text, /- 共读草稿\.md: \/home\/ubuntu\/workspace\/uploads\/2026-09-29\/共读草稿\.md/);
  assert.match(text, /- Dia Recovery Kit\.pdf: \/home\/ubuntu\/workspace\/uploads\/2026-09-29\/Dia Recovery Kit\.pdf/);
  assert.equal(isAttachmentPromptText(text), true);
  assert.equal(fileAttachmentPromptText([]), "");
  assert.equal(isAttachmentPromptText("普通用户消息"), false);
});

test("the App Server prompt adds the file text and transcripts hide it", async () => {
  const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(serverSource, /const fileText = fileAttachmentPromptText\(/);
  assert.match(serverSource, /if \(!isAttachmentPromptText\(entry\.text\)\) text\.push\(entry\.text\)/);
});
