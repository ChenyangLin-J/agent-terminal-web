import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { renderMarkdownEditorPage } from "../lib/local-file-view.js";

const editorScript = fileURLToPath(new URL("../public/local-markdown-editor.js", import.meta.url));

test("the Markdown editor sends versioned text and keeps conflicting edits in the page", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const successfulPage = await browser.newPage();
  let savedRequest;
  await successfulPage.route("https://agent.test/api/local-markdown?path=test.md", async (route) => {
    savedRequest = {
      body: route.request().postData(),
      contentType: await route.request().headerValue("content-type"),
      version: await route.request().headerValue("if-match"),
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ version: "b".repeat(64), href: "https://agent.test/done" }),
    });
  });
  await successfulPage.route("https://agent.test/done", (route) =>
    route.fulfill({ contentType: "text/html", body: "saved" }),
  );
  await installEditor(successfulPage);
  await successfulPage.locator("#markdown-source").fill("# Saved on mobile\n");
  await Promise.all([
    successfulPage.waitForURL("https://agent.test/done"),
    successfulPage.locator("#markdown-save").click(),
  ]);
  assert.deepEqual(savedRequest, {
    body: "# Saved on mobile\n",
    contentType: "text/plain; charset=utf-8",
    version: `"${"a".repeat(64)}"`,
  });

  const conflictPage = await browser.newPage();
  await conflictPage.route("https://agent.test/api/local-markdown?path=test.md", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "文件已在其他地方更新，本次修改没有覆盖它。" }),
    }),
  );
  await installEditor(conflictPage);
  await conflictPage.locator("#markdown-source").fill("# Keep this draft\n");
  await conflictPage.locator("#markdown-save").click();
  await conflictPage.waitForFunction(
    () => document.querySelector("#markdown-editor-status")?.dataset.state === "error",
  );
  assert.equal(
    await conflictPage.locator("#markdown-editor-status").textContent(),
    "文件已在其他地方更新，本次修改没有覆盖它。",
  );
  assert.equal(await conflictPage.locator("#markdown-source").inputValue(), "# Keep this draft\n");
  assert.equal(await conflictPage.locator("#markdown-save").isEnabled(), true);
});

async function installEditor(page) {
  const html = renderMarkdownEditorPage({
    name: "test.md",
    relativePath: "project/test.md",
    text: "# Initial\n",
    version: "a".repeat(64),
    saveHref: "/api/local-markdown?path=test.md",
    viewHref: "/open/local?path=test.md",
  })
    .replace("<head>", '<head><base href="https://agent.test">')
    .replace(/\s*<script src="\/local-markdown-editor\.js[^>]*><\/script>/, "");
  await page.setContent(html);
  await page.addScriptTag({ path: editorScript });
}
