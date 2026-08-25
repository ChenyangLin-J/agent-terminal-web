import path from "node:path";
import MarkdownIt from "markdown-it";
import { parseLocalFileHref, workspaceFileForLocalHref } from "./local-file-link.js";

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
  if (extension === ".md" && size <= maxTextBytes) return { kind: "markdown", mime: "text/markdown" };
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

export function renderMarkdownFilePage({
  name,
  relativePath,
  filePath,
  workspaceRoot,
  text,
  downloadHref,
  sourceHref,
  editHref,
}) {
  const renderer = createMarkdownRenderer();
  const content = renderer.render(String(text), {
    filePath,
    workspaceRoot,
    headingCounts: new Map(),
  });
  return renderViewerPage({
    name,
    relativePath,
    downloadHref,
    secondaryAction: `<a href="${escapeAttribute(editHref)}">编辑</a><a href="${escapeAttribute(sourceHref)}">源码</a>`,
    body: `<main class="markdown-view"><article class="markdown-body">${content}</article></main>`,
  });
}

export function renderMarkdownEditorPage({
  name,
  relativePath,
  text,
  version,
  saveHref,
  viewHref,
}) {
  return renderViewerPage({
    name,
    relativePath,
    bodyClass: "editor-page",
    showDownload: false,
    secondaryAction: `<a id="markdown-cancel" href="${escapeAttribute(viewHref)}">取消</a><button id="markdown-save" type="button">保存</button>`,
    body: `<main class="editor-view" data-markdown-editor data-save-href="${escapeAttribute(saveHref)}" data-view-href="${escapeAttribute(viewHref)}" data-version="${escapeAttribute(version)}"><textarea id="markdown-source" aria-label="Markdown 源码" spellcheck="true">${escapeHtml(text)}</textarea><p id="markdown-editor-status" class="editor-status" aria-live="polite">修改后点击保存</p></main>`,
    tail: `<script src="/local-markdown-editor.js?v=20260825-1"></script>`,
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

function renderViewerPage({
  name,
  relativePath,
  downloadHref = "",
  secondaryAction = "",
  showDownload = true,
  bodyClass = "",
  body,
  tail = "",
}) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <title>${escapeHtml(name)} · Agent</title>
    <style>
      * { box-sizing: border-box; }
      :root { color-scheme: dark; }
      html { min-height: 100%; scroll-padding-top: 88px; background: #0b0e13; }
      body { min-height: 100%; margin: 0; background: #0b0e13; color: #e7eaf0; font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { display: grid; grid-template-rows: auto 1fr; }
      .editor-page { height: 100vh; height: 100dvh; overflow: hidden; grid-template-rows: auto minmax(0, 1fr); }
      .viewer-header { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; min-width: 0; padding: max(10px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) 10px max(14px, env(safe-area-inset-left)); border-bottom: 1px solid #2a303a; background: rgb(17 21 27 / 96%); backdrop-filter: blur(12px); }
      .viewer-title { min-width: 0; }
      .viewer-title strong, .viewer-title small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .viewer-title strong { font-size: 14px; }
      .viewer-title small { color: #8f99a8; font-size: 11px; }
      .viewer-actions { display: flex; gap: 12px; align-items: center; }
      a { color: #9ab8ff; text-underline-offset: 3px; }
      button { min-height: 36px; padding: 0 13px; border: 1px solid #617fd1; border-radius: 8px; color: white; background: #4f6fca; font: inherit; cursor: pointer; }
      button:disabled { cursor: wait; opacity: 0.68; }
      .agent-back { display: inline-flex; align-items: center; min-height: 36px; color: #c7d4ee; text-decoration: none; }
      .agent-back span { margin-right: 5px; font-size: 21px; line-height: 1; }
      .text-view { min-width: 0; overflow: auto; padding: 12px 0 40px; }
      .text-view ol { width: max-content; min-width: 100%; margin: 0; padding-left: 64px; color: #687386; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .text-view li { min-height: 20px; padding: 0 18px 0 10px; }
      .text-view li::marker { user-select: none; }
      .text-view li.highlight, .text-view li:target { background: #25375c; color: #dce7ff; }
      .text-view code { color: #e7eaf0; white-space: pre; }
      .markdown-view { min-width: 0; width: min(100%, 820px); margin: 0 auto; padding: 34px 30px max(64px, env(safe-area-inset-bottom)); }
      .markdown-body { color: #dfe4ec; font-size: 16px; line-height: 1.75; overflow-wrap: break-word; }
      .markdown-body > :first-child { margin-top: 0; }
      .markdown-body > :last-child { margin-bottom: 0; }
      .markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body pre, .markdown-body blockquote, .markdown-body table { margin: 0 0 1.1em; }
      .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6 { margin: 1.55em 0 0.55em; color: #f2f5fa; line-height: 1.3; scroll-margin-top: 88px; }
      .markdown-body h1 { margin-top: 0; font-size: 2rem; letter-spacing: -0.025em; }
      .markdown-body h2 { padding-bottom: 0.28em; border-bottom: 1px solid #29313e; font-size: 1.45rem; }
      .markdown-body h3 { font-size: 1.18rem; }
      .markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 1rem; }
      .markdown-body ul, .markdown-body ol { padding-left: 1.45em; }
      .markdown-body li + li { margin-top: 0.35em; }
      .markdown-body a { color: #9bbaff; overflow-wrap: anywhere; text-decoration-color: rgb(155 186 255 / 55%); }
      .markdown-body strong { color: #f1f4f8; }
      .markdown-body code { padding: 0.12em 0.35em; border: 1px solid #292f39; border-radius: 5px; background: #171c24; color: #f0d39a; font: 0.86em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .markdown-body pre { max-width: 100%; padding: 14px 16px; overflow-x: auto; border: 1px solid #29313e; border-radius: 9px; background: #080b10; }
      .markdown-body pre code { padding: 0; border: 0; background: transparent; color: #e6e9ef; font-size: 13px; white-space: pre; }
      .markdown-body blockquote { padding: 0.15em 0 0.15em 1em; border-left: 3px solid #52637d; color: #b9c2d0; }
      .markdown-body blockquote > :last-child { margin-bottom: 0; }
      .markdown-body table { display: block; width: 100%; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
      .markdown-body th, .markdown-body td { min-width: 120px; padding: 8px 10px; border: 1px solid #303744; text-align: left; vertical-align: top; }
      .markdown-body th { color: #f0f3f8; background: #151a22; }
      .markdown-body hr { height: 1px; margin: 2em 0; border: 0; background: #29313e; }
      .markdown-body img { display: block; max-width: 100%; height: auto; margin: 1.2em auto; border-radius: 8px; }
      .editor-view { display: grid; grid-template-rows: minmax(0, 1fr) auto; min-width: 0; min-height: 0; background: #0b0e13; }
      #markdown-source { width: 100%; min-width: 0; min-height: 0; padding: 22px max(22px, calc((100% - 820px) / 2)); resize: none; border: 0; border-radius: 0; outline: none; color: #e5e9f0; background: #0b0e13; font: 15px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 2; white-space: pre-wrap; overflow-wrap: break-word; }
      #markdown-source:focus { box-shadow: inset 0 0 0 1px #33466f; }
      .editor-status { min-height: 40px; margin: 0; padding: 9px max(22px, calc((100% - 820px) / 2)) max(9px, env(safe-area-inset-bottom)); border-top: 1px solid #242b35; color: #8d99aa; background: #10141a; font-size: 12px; }
      .editor-status[data-state="success"] { color: #9de0bd; }
      .editor-status[data-state="error"] { color: #ffb4bf; }
      .sandbox-view { min-height: 0; padding: 10px; }
      iframe { width: 100%; height: 100%; min-height: calc(100vh - 72px); border: 1px solid #2a303a; border-radius: 6px; background: white; }
      @media (max-width: 600px) {
        .viewer-header { grid-template-columns: auto minmax(0, 1fr) auto; gap: 9px; padding-bottom: 8px; }
        .agent-back { width: 24px; overflow: hidden; font-size: 0; white-space: nowrap; }
        .agent-back span { flex: none; margin-right: 0; font-size: 21px; }
        .viewer-actions { gap: 10px; font-size: 13px; }
        .viewer-actions button { min-height: 34px; padding: 0 11px; }
        .markdown-view { padding: 24px 18px max(48px, env(safe-area-inset-bottom)); }
        .markdown-body { font-size: 16px; line-height: 1.72; }
        .markdown-body h1 { font-size: 1.65rem; }
        .markdown-body h2 { font-size: 1.3rem; }
        .markdown-body pre { margin-right: -18px; margin-left: -18px; padding: 13px 18px; border-right: 0; border-left: 0; border-radius: 0; }
        #markdown-source { padding: 18px 16px; font-size: 16px; line-height: 1.6; }
        .editor-status { padding-right: 16px; padding-left: 16px; }
      }
    </style>
  </head>
  <body${bodyClass ? ` class="${escapeAttribute(bodyClass)}"` : ""}>
    <header class="viewer-header"><a class="agent-back" href="/" aria-label="返回 Agent"><span aria-hidden="true">‹</span>Agent</a><div class="viewer-title"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(relativePath)}</small></div><nav class="viewer-actions">${secondaryAction}${showDownload ? `<a href="${escapeAttribute(downloadHref)}">下载</a>` : ""}</nav></header>
    ${body}
    ${tail}
  </body>
</html>`;
}

function createMarkdownRenderer() {
  const renderer = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
  const defaultLinkOpen = renderer.renderer.rules.link_open;
  const defaultImage = renderer.renderer.rules.image;
  renderer.renderer.rules.heading_open = (tokens, index, options, environment, self) => {
    const inline = tokens[index + 1];
    const heading = inline?.children?.map((child) => child.content || "").join("") || inline?.content || "";
    tokens[index].attrSet("id", uniqueHeadingId(heading, environment.headingCounts));
    return self.renderToken(tokens, index, options);
  };
  renderer.renderer.rules.link_open = (tokens, index, options, environment, self) => {
    const href = tokens[index].attrGet("href");
    const localHref = markdownLocalOpenHref(href, environment);
    if (localHref) {
      tokens[index].attrSet("href", localHref);
      tokens[index].attrSet("title", tokens[index].attrGet("title") || "打开文件");
    } else if (href && !href.startsWith("#")) {
      tokens[index].attrSet("target", "_blank");
      tokens[index].attrSet("rel", "noopener noreferrer");
    }
    return defaultLinkOpen
      ? defaultLinkOpen(tokens, index, options, environment, self)
      : self.renderToken(tokens, index, options);
  };
  renderer.renderer.rules.image = (tokens, index, options, environment, self) => {
    const src = tokens[index].attrGet("src");
    const localSrc = markdownLocalOpenHref(src, environment);
    if (localSrc) tokens[index].attrSet("src", localSrc);
    return defaultImage(tokens, index, options, environment, self);
  };
  return renderer;
}

function markdownLocalOpenHref(rawHref, { filePath, workspaceRoot } = {}) {
  const value = String(rawHref || "").trim();
  if (!value || value.startsWith("#") || value.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    return null;
  }
  const parsed = parseLocalFileHref(value);
  const candidate = path.isAbsolute(parsed.filePath)
    ? parsed.filePath
    : path.resolve(path.dirname(filePath), parsed.filePath);
  const resolved = workspaceFileForLocalHref(
    `${candidate}${parsed.line ? `:${parsed.line}` : ""}${parsed.fragment ? `#${parsed.fragment}` : ""}`,
    workspaceRoot,
  );
  if (!resolved) return null;
  const requestedPath = `${resolved.filePath}${resolved.line ? `:${resolved.line}` : ""}${resolved.fragment ? `#${resolved.fragment}` : ""}`;
  const target = resolved.line ? `L${resolved.line}` : resolved.fragment;
  return `/open/local?path=${encodeURIComponent(requestedPath)}${target ? `#${encodeURIComponent(target)}` : ""}`;
}

function uniqueHeadingId(value, counts = new Map()) {
  const base = String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "section";
  const count = counts.get(base) || 0;
  counts.set(base, count + 1);
  return count ? `${base}-${count}` : base;
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
