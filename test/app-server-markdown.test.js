import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

test("App Server final answers render safe Markdown links", async (t) => {
  const [pageSource, appSource, serverSource] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
  ]);
  assert.match(pageSource, /markdown-it\.min\.js\?v=14\.3\.0[\s\S]*app-markdown\.js\?v=20260721-1[\s\S]*app\.js\?v=20260721-session-access-1/);
  assert.match(serverSource, /app\.use\("\/vendor\/markdown-it"/);
  assert.match(appSource, /\["assistant", "user"\]\.includes\(item\.type\)/);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div id="output"></div>');
  await page.addScriptTag({
    path: fileURLToPath(new URL("../node_modules/markdown-it/dist/markdown-it.min.js", import.meta.url)),
  });
  await page.addScriptTag({ path: fileURLToPath(new URL("../public/app-markdown.js", import.meta.url)) });

  const rendered = await page.evaluate(() => {
    const output = document.querySelector("#output");
    const renderer = globalThis.AgentMarkdown.createRenderer();
    globalThis.AgentMarkdown.render(
      output,
      "主站：[https://tibetan.chenyanglin.com/](https://tibetan.chenyanglin.com/)\n\n校准：https://tibetan.chenyanglin.com/superscript-audio-review.html\n\n<script>alert(1)</script>",
      renderer,
    );
    return {
      links: [...output.querySelectorAll("a")].map((link) => ({
        href: link.href,
        target: link.target,
        rel: link.rel,
      })),
      scripts: output.querySelectorAll("script").length,
      text: output.textContent,
    };
  });

  assert.deepEqual(rendered.links, [
    {
      href: "https://tibetan.chenyanglin.com/",
      target: "_blank",
      rel: "noopener noreferrer",
    },
    {
      href: "https://tibetan.chenyanglin.com/superscript-audio-review.html",
      target: "_blank",
      rel: "noopener noreferrer",
    },
  ]);
  assert.equal(rendered.scripts, 0);
  assert.match(rendered.text, /<script>alert\(1\)<\/script>/);
});
