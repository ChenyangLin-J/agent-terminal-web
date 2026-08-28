import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const writeQueues = new Map();

export function localMarkdownVersion(content) {
  return `sha256:${createHash("sha256").update(content).digest("base64url")}`;
}

export async function readLocalMarkdown(filePath) {
  const content = await fs.readFile(filePath);
  return {
    content: content.toString("utf8"),
    size: content.length,
    version: localMarkdownVersion(content),
  };
}

export function saveLocalMarkdown(filePath, { content, version, maxBytes = 2 * 1024 * 1024 } = {}) {
  const targetPath = path.resolve(filePath);
  const previous = writeQueues.get(targetPath) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    if (![".md", ".mdx"].includes(path.extname(targetPath).toLowerCase())) {
      throw localMarkdownError("DOCUMENT_EDIT_UNSUPPORTED", "Only Markdown files can be edited here.", 415);
    }
    const nextContent = String(content ?? "");
    if (Buffer.byteLength(nextContent, "utf8") > maxBytes) {
      throw localMarkdownError("DOCUMENT_TOO_LARGE", "Markdown files larger than 2 MB cannot be edited here.", 413);
    }
    const [currentContent, currentStat] = await Promise.all([fs.readFile(targetPath), fs.stat(targetPath)]);
    if (!version || version !== localMarkdownVersion(currentContent)) {
      throw localMarkdownError(
        "DOCUMENT_VERSION_CONFLICT",
        "The file changed outside Agent. Your draft is still in the editor; reopen the file before merging it.",
        409,
      );
    }
    const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, nextContent, { encoding: "utf8", mode: currentStat.mode });
      await fs.rename(temporaryPath, targetPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    return readLocalMarkdown(targetPath);
  });
  writeQueues.set(targetPath, current);
  return current.finally(() => {
    if (writeQueues.get(targetPath) === current) writeQueues.delete(targetPath);
  });
}

function localMarkdownError(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}
