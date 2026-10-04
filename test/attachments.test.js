import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("attachment submissions use native App Server inputs and validated upload paths", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");


  assert.match(server, /normalizeSubmittedAttachments\(message\.attachments\)/);
  assert.match(server, /attachmentCount: attachments\.length/);
  assert.match(server, /event: "upload-complete"|logAgentEvent\("upload-complete"/);
  assert.match(server, /isPathInside\(uploadsRoot, filePath\)/);
  assert.match(server, /\{ type: "localImage", path: attachment\.path \}/);
  assert.match(server, /\{ type: "mention", name: attachment\.originalName, path: attachment\.path \}/);
  assert.match(server, /appServerPromptInput\(value, skills, attachments\)/);
});
