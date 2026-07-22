import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

test("uploads remain separate from prompt text and render as removable attachments", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button id="attach"></button>
    <input id="files" type="file" multiple>
    <section id="composer"><textarea id="prompt">保留这段文字</textarea></section>
    <div id="attachments" class="hidden"></div>
    <div id="status"></div>
  `);
  await page.addScriptTag({ path: fileURLToPath(new URL("../public/agent-upload.js", import.meta.url)) });

  const result = await page.evaluate(async () => {
    class UploadRequest extends EventTarget {
      upload = new EventTarget();
      status = 200;
      responseText = JSON.stringify({
        files: [
          {
            path: "/home/ubuntu/workspace/uploads/2026-07-22/notes.md",
            originalName: "notes.md",
            storedName: "notes.md",
            size: 12,
            mime: "text/markdown",
          },
        ],
      });

      open() {}

      send() {
        this.dispatchEvent(new Event("load"));
      }
    }
    window.XMLHttpRequest = UploadRequest;

    const controller = window.AgentUpload.create({
      attachButton: document.querySelector("#attach"),
      fileInput: document.querySelector("#files"),
      composer: document.querySelector("#composer"),
      attachmentsHost: document.querySelector("#attachments"),
      setUploadStatus: (message) => {
        document.querySelector("#status").textContent = message;
      },
      redirectToLogin: () => {},
    });
    controller.install();
    await controller.uploadFiles([new File(["hello"], "notes.md", { type: "text/markdown" })]);
    const beforeRemove = {
      prompt: document.querySelector("#prompt").value,
      name: document.querySelector(".composer-attachment-copy strong")?.textContent,
      count: controller.getAttachments().length,
    };
    document.querySelector(".composer-attachment-remove").click();
    return {
      beforeRemove,
      countAfterRemove: controller.getAttachments().length,
      hiddenAfterRemove: document.querySelector("#attachments").classList.contains("hidden"),
    };
  });

  assert.deepEqual(result, {
    beforeRemove: { prompt: "保留这段文字", name: "notes.md", count: 1 },
    countAfterRemove: 0,
    hiddenAfterRemove: true,
  });
});

test("attachment submissions use native App Server inputs and validated upload paths", async () => {
  const [server, app, upload] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/agent-upload.js", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(upload, /请读取这个文件（原始文件名/);
  assert.match(app, /data: prompt,\s+attachments,/);
  assert.match(server, /normalizeSubmittedAttachments\(message\.attachments\)/);
  assert.match(server, /isPathInside\(uploadsRoot, filePath\)/);
  assert.match(server, /\{ type: "localImage", path: attachment\.path \}/);
  assert.match(server, /\{ type: "mention", name: attachment\.originalName, path: attachment\.path \}/);
  assert.match(server, /terminalPromptWithAttachments\(prompt\.text, attachments\)/);
});
