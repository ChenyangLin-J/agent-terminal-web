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
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /app\.use\("\/api", requireAuth\)[\s\S]*app\.get\("\/api\/session-image\/:sessionId\/:itemId"/);
  assert.match(server, /presentation\.kind !== "inline" \|\| !presentation\.mime\.startsWith\("image\/"\)/);
  assert.match(server, /viewedImagePath\(session, itemId\)/);
  assert.match(server, /loadHistoricalSessionProcess\(session, turnId\)/);
  assert.match(server, /indexFile: sessionProcessIndexFile\(session\.sessionId\)/);
  assert.match(server, /session\.historyProcessCache\.set\(turnId, items\)/);

  const resolver = await readFile(new URL("../lib/session-image.js", import.meta.url), "utf8");
  assert.match(resolver, /session\?\.historyProcessCache instanceof Map/);
});
