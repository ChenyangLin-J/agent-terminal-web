import fsSync from "node:fs";
import path from "node:path";
import { isPathInside } from "./local-file-link.js";

export const HOME_TURN_ATTACHMENTS_DIR = path.join("System", "Capture", "Attachments");
export const HOME_TURN_MAX_ATTACHMENTS = 9;

const IMAGE_MIME_BY_EXTENSION = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

// Home sends vault-relative attachment paths with a 「聊一聊」 turn. Only
// images previously stored by Home capture under System/Capture/Attachments/
// are eligible; each accepted entry matches the submitted-attachment shape
// appServerPromptInput already maps to a `localImage` turn input item.
export function resolveHomeTurnAttachments(value, { vaultRoot }) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("attachments must be an array of { path } entries.");
  if (!value.length) return [];
  if (value.length > HOME_TURN_MAX_ATTACHMENTS) {
    throw new Error(`A Home turn accepts at most ${HOME_TURN_MAX_ATTACHMENTS} attachments.`);
  }

  const attachmentsRoot = path.join(vaultRoot, HOME_TURN_ATTACHMENTS_DIR);
  return value.map((attachment) => {
    const relativePath = String(attachment?.path || "").trim();
    if (!relativePath) throw new Error("Each attachment needs a non-empty path.");
    const candidate = path.resolve(vaultRoot, relativePath);
    if (!isPathInside(attachmentsRoot, candidate)) {
      throw new Error("Attachment paths must stay inside the vault capture attachments directory.");
    }
    const mime = IMAGE_MIME_BY_EXTENSION.get(path.extname(candidate).toLowerCase());
    if (!mime) {
      throw new Error("Only image attachments (jpg, jpeg, png, webp, gif) are supported; audio and other file types cannot join a Home turn.");
    }

    let realRoot;
    let filePath;
    let stat;
    try {
      realRoot = fsSync.realpathSync(attachmentsRoot);
      filePath = fsSync.realpathSync(candidate);
      stat = fsSync.statSync(filePath);
    } catch {
      throw new Error("The attachment file does not exist in the vault capture attachments directory.");
    }
    if (!isPathInside(realRoot, filePath) || !stat.isFile()) {
      throw new Error("Attachment paths must stay inside the vault capture attachments directory.");
    }
    return { path: filePath, mime, originalName: path.basename(filePath) };
  });
}
