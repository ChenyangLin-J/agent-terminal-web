import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveHomeTurnAttachments } from "../lib/home-turn-attachments.js";

async function withVault(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "home-turn-attachments-"));
  const vaultRoot = path.join(root, "obsidian", "MainVault");
  const attachmentsRoot = path.join(vaultRoot, "System", "Capture", "Attachments");
  await mkdir(attachmentsRoot, { recursive: true });
  try {
    await run({ vaultRoot, attachmentsRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("absent and empty attachments keep the legacy no-attachment shape", async () => {
  await withVault(async ({ vaultRoot }) => {
    assert.deepEqual(resolveHomeTurnAttachments(undefined, { vaultRoot }), []);
    assert.deepEqual(resolveHomeTurnAttachments(null, { vaultRoot }), []);
    assert.deepEqual(resolveHomeTurnAttachments([], { vaultRoot }), []);
  });
});

test("image attachments resolve to absolute paths with image mime metadata", async () => {
  await withVault(async ({ vaultRoot, attachmentsRoot }) => {
    const stored = path.join(attachmentsRoot, "2026-10-06");
    await mkdir(stored, { recursive: true });
    await writeFile(path.join(stored, "note.PNG"), "png-bytes");
    await writeFile(path.join(stored, "clip.webp"), "webp-bytes");

    const attachments = resolveHomeTurnAttachments(
      [{ path: "System/Capture/Attachments/2026-10-06/note.PNG" }, { path: "System/Capture/Attachments/2026-10-06/clip.webp" }],
      { vaultRoot },
    );
    assert.deepEqual(
      attachments.map((attachment) => [attachment.originalName, attachment.mime]),
      [["note.PNG", "image/png"], ["clip.webp", "image/webp"]],
    );
    for (const attachment of attachments) {
      assert.ok(path.isAbsolute(attachment.path));
      assert.ok(attachment.path.startsWith(realpathSync(attachmentsRoot)));
    }
  });
});

test("paths outside the capture attachments directory are rejected", async () => {
  await withVault(async ({ vaultRoot }) => {
    for (const value of [
      [{ path: "../Secrets/token.png" }],
      [{ path: "System/Capture/Attachments/../../Secrets/token.png" }],
      [{ path: "/etc/passwd" }],
      [{ path: "System/Capture/Attachments" }],
    ]) {
      assert.throws(
        () => resolveHomeTurnAttachments(value, { vaultRoot }),
        /must stay inside the vault capture attachments directory/,
      );
    }
  });
});

test("audio and other non-image files are rejected with an explicit message", async () => {
  await withVault(async ({ vaultRoot, attachmentsRoot }) => {
    await writeFile(path.join(attachmentsRoot, "voice.m4a"), "audio-bytes");
    await writeFile(path.join(attachmentsRoot, "notes.txt"), "text-bytes");
    for (const name of ["voice.m4a", "notes.txt"]) {
      assert.throws(
        () => resolveHomeTurnAttachments([{ path: `System/Capture/Attachments/${name}` }], { vaultRoot }),
        /Only image attachments/,
      );
    }
  });
});

test("missing files and malformed attachment entries are rejected", async () => {
  await withVault(async ({ vaultRoot }) => {
    assert.throws(
      () => resolveHomeTurnAttachments([{ path: "System/Capture/Attachments/gone.png" }], { vaultRoot }),
      /does not exist/,
    );
    assert.throws(
      () => resolveHomeTurnAttachments([{ path: "" }], { vaultRoot }),
      /non-empty path/,
    );
    assert.throws(
      () => resolveHomeTurnAttachments([{}], { vaultRoot }),
      /non-empty path/,
    );
    assert.throws(
      () => resolveHomeTurnAttachments("System/Capture/Attachments/a.png", { vaultRoot }),
      /array of \{ path \} entries/,
    );
  });
});

test("a symlink escaping the capture attachments directory is rejected", async (t) => {
  await withVault(async ({ vaultRoot, attachmentsRoot }) => {
    const outside = path.join(vaultRoot, "System", "Capture");
    await writeFile(path.join(outside, "outside.png"), "png-bytes");
    try {
      await symlink(path.join(outside, "outside.png"), path.join(attachmentsRoot, "linked.png"));
    } catch (error) {
      t.skip(`symlinks unavailable: ${error.message}`);
      return;
    }
    assert.throws(
      () => resolveHomeTurnAttachments([{ path: "System/Capture/Attachments/linked.png" }], { vaultRoot }),
      /must stay inside the vault capture attachments directory/,
    );
  });
});

test("more than nine attachments are rejected", async () => {
  await withVault(async ({ vaultRoot }) => {
    const value = Array.from({ length: 10 }, (_, index) => ({
      path: `System/Capture/Attachments/${index}.png`,
    }));
    assert.throws(
      () => resolveHomeTurnAttachments(value, { vaultRoot }),
      /at most 9 attachments/,
    );
  });
});

test("the Home turn route validates attachments and forwards them into the turn input", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /resolveHomeTurnAttachments\(req\.body\?\.attachments, \{ vaultRoot: OBSIDIAN_VAULT_ROOT \}\)/);
  assert.match(server, /admitHomeTurn\(\{ threadId, attachId, requestId, text, attachments, fingerprint \}\)/);
  assert.match(server, /submitAppServerPrompt\(session, prompt\.text, "auto", \[\], attachments, text, \{/);
});
