import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const saveQueues = new Map();

export class LocalMarkdownError extends Error {
  constructor(message, { code = "local_markdown_error", status = 400 } = {}) {
    super(message);
    this.name = "LocalMarkdownError";
    this.code = code;
    this.status = status;
  }
}

export function localMarkdownVersion(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function normalizeLocalMarkdownVersion(value) {
  const version = String(value || "").trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!/^[a-f0-9]{64}$/.test(version)) {
    throw new LocalMarkdownError("缺少有效的文件版本，请重新打开编辑页。", {
      code: "local_markdown_version_required",
      status: 428,
    });
  }
  return version;
}

export function saveLocalMarkdownFile(options) {
  const key = path.resolve(options.filePath);
  const previous = saveQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => saveLocalMarkdownFileNow(options));
  saveQueues.set(key, current);
  return current.finally(() => {
    if (saveQueues.get(key) === current) saveQueues.delete(key);
  });
}

async function saveLocalMarkdownFileNow({
  filePath,
  text,
  expectedVersion,
  maxBytes,
}) {
  if (path.extname(filePath).toLowerCase() !== ".md") {
    throw new LocalMarkdownError("这里只能编辑 Markdown 文件。", {
      code: "local_markdown_unsupported",
      status: 400,
    });
  }

  const source = String(text);
  if (Buffer.byteLength(source, "utf8") > maxBytes) {
    throw new LocalMarkdownError("Markdown 文件过大，无法在网页中保存。", {
      code: "local_markdown_too_large",
      status: 413,
    });
  }

  const version = normalizeLocalMarkdownVersion(expectedVersion);
  const [current, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
  if (!stat.isFile()) {
    throw new LocalMarkdownError("这个 Markdown 文件已经不存在。", {
      code: "local_markdown_not_found",
      status: 404,
    });
  }
  if (localMarkdownVersion(current) !== version) throw markdownConflict();

  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, source, {
      encoding: "utf8",
      flag: "wx",
      mode: stat.mode & 0o777,
    });
    const latest = await fs.readFile(filePath, "utf8");
    if (localMarkdownVersion(latest) !== version) throw markdownConflict();
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, stat.mode & 0o777);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  return { version: localMarkdownVersion(source) };
}

function markdownConflict() {
  return new LocalMarkdownError("文件已在其他地方更新，本次修改没有覆盖它。", {
    code: "local_markdown_conflict",
    status: 409,
  });
}
