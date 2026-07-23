import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { viewedImagePath } from "../lib/session-image.js";

test("viewed images resolve only from exact Agent transcript items", () => {
  const session = {
    appTranscript: [
      { id: "image-1", type: "tool", label: "查看图片", text: "/tmp/work-card.png" },
      { id: "tool-1", type: "tool", label: "工具", text: "/tmp/secret.png" },
      { id: "relative", type: "tool", label: "查看图片", text: "preview.png" },
    ],
    historyProcessCache: new Map([
      ["turn-1", [{ id: "history-image", type: "tool", label: "查看图片", text: "/tmp/history.png" }]],
    ]),
  };

  assert.equal(viewedImagePath(session, "image-1"), "/tmp/work-card.png");
  assert.equal(viewedImagePath(session, "history-image"), "/tmp/history.png");
  assert.equal(viewedImagePath(session, "tool-1"), null);
  assert.equal(viewedImagePath(session, "relative"), null);
  assert.equal(viewedImagePath(session, "missing"), null);
});

test("App Server image cards link through the authenticated session image route", async () => {
  const [server, app, styles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(server, /app\.use\("\/api", requireAuth\)[\s\S]*app\.get\("\/api\/session-image\/:sessionId\/:itemId"/);
  assert.match(server, /presentation\.kind !== "inline" \|\| !presentation\.mime\.startsWith\("image\/"\)/);
  assert.match(server, /viewedImagePath\(session, req\.params\.itemId\)/);
  assert.match(app, /item\.type === "tool" && item\.label === "查看图片" && activeSessionId/);
  assert.match(app, /`\/api\/session-image\/\$\{encodeURIComponent\(activeSessionId\)\}\/\$\{encodeURIComponent\(item\.id\)\}`/);
  assert.match(styles, /\.app-transcript-image-link/);
  const resolver = await readFile(new URL("../lib/session-image.js", import.meta.url), "utf8");
  assert.match(resolver, /session\?\.historyProcessCache instanceof Map/);
});
