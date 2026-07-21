import path from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".ini",
  ".ipynb",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".lock",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);
const TEXT_FILENAMES = new Set([
  ".dockerignore",
  ".editorconfig",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "dockerfile",
  "license",
  "makefile",
  "procfile",
]);
const RASTER_MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export function localFilePresentation(filePath, size, { maxTextBytes, maxPreviewBytes }) {
  const extension = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  if (size > maxPreviewBytes) return { kind: "download", mime: "application/octet-stream" };
  if ([".html", ".htm", ".svg"].includes(extension)) {
    return size <= maxTextBytes
      ? { kind: "sandbox", mime: "text/html" }
      : { kind: "download", mime: "application/octet-stream" };
  }
  if (RASTER_MIME_TYPES.has(extension)) return { kind: "inline", mime: RASTER_MIME_TYPES.get(extension) };
  if (extension === ".pdf") return { kind: "inline", mime: "application/pdf" };
  if ((TEXT_EXTENSIONS.has(extension) || TEXT_FILENAMES.has(fileName)) && size <= maxTextBytes) {
    return { kind: "text", mime: "text/plain" };
  }
  return { kind: "download", mime: "application/octet-stream" };
}

export function renderTextFilePage({ name, relativePath, text, line, downloadHref }) {
  const lines = String(text).split("\n");
  const rows = lines
    .map((content, index) => {
      const number = index + 1;
      const active = number === line ? ' class="highlight"' : "";
      return `<li id="L${number}"${active}><code>${escapeHtml(content) || " "}</code></li>`;
    })
    .join("");
  return renderViewerPage({
    name,
    relativePath,
    downloadHref,
    body: `<main class="text-view"><ol>${rows}</ol></main>`,
  });
}

export function renderSandboxFilePage({ name, relativePath, source, downloadHref }) {
  const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data: https:";
  const srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${source}`;
  return renderViewerPage({
    name,
    relativePath,
    downloadHref,
    body: `<main class="sandbox-view"><iframe sandbox srcdoc="${escapeAttribute(srcdoc)}" title="${escapeAttribute(name)}"></iframe></main>`,
  });
}

function renderViewerPage({ name, relativePath, downloadHref, body }) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>${escapeHtml(name)} · Agent</title>
    <style>
      * { box-sizing: border-box; }
      html, body { min-height: 100%; margin: 0; background: #0b0e13; color: #e7eaf0; font: 14px/1.5 system-ui, sans-serif; }
      body { display: grid; grid-template-rows: auto 1fr; }
      header { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px; align-items: center; min-width: 0; padding: 10px 14px; border-bottom: 1px solid #2a303a; background: #11151b; }
      header div { min-width: 0; flex: 1; }
      strong, small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      small { color: #8f99a8; }
      a { flex: none; color: #9ab8ff; text-underline-offset: 3px; }
      .text-view { min-width: 0; overflow: auto; padding: 12px 0 40px; }
      ol { width: max-content; min-width: 100%; margin: 0; padding-left: 64px; color: #687386; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      li { min-height: 20px; padding: 0 18px 0 10px; }
      li::marker { user-select: none; }
      li.highlight, li:target { background: #25375c; color: #dce7ff; }
      code { color: #e7eaf0; white-space: pre; }
      .sandbox-view { min-height: 0; padding: 10px; }
      iframe { width: 100%; height: 100%; min-height: calc(100vh - 72px); border: 1px solid #2a303a; border-radius: 6px; background: white; }
    </style>
  </head>
  <body>
    <header><div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(relativePath)}</small></div><a href="${escapeAttribute(downloadHref)}">下载</a></header>
    ${body}
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
