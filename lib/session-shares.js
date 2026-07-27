import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import MarkdownIt from "markdown-it";

export const SESSION_SHARE_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_STORED_SHARES = 200;
const MAX_SHARE_MESSAGES = 400;
const MAX_SHARE_MESSAGE_CHARS = 120_000;
const MAX_SHARE_TOTAL_CHARS = 600_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});

markdown.validateLink = (href) => /^https?:\/\//i.test(String(href || ""));
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index].content || tokens[index].attrGet("alt") || "图片");

export class SessionShareStore {
  constructor(filePath, { now = () => Date.now(), ttlMs = SESSION_SHARE_TTL_MS } = {}) {
    this.filePath = path.resolve(filePath);
    this.now = now;
    this.ttlMs = ttlMs;
    this.operation = Promise.resolve();
  }

  create(input) {
    return this.#enqueue(async () => {
      const messages = normalizeShareMessages(input?.messages);
      if (!messages.length) throw new Error("这个 Session 还没有可分享的对话正文。");

      const { shares } = await this.#readActive();
      const hostId = cleanValue(input?.hostId, 40) || "personal";
      const sessionId = cleanValue(input?.sessionId, 200);
      const createdAtMs = this.now();
      const createdAt = new Date(createdAtMs).toISOString();
      const expiresAt = new Date(createdAtMs + this.ttlMs).toISOString();
      let token = "";
      let tokenHash = "";
      do {
        token = randomBytes(32).toString("base64url");
        tokenHash = hashSessionShareToken(token);
      } while (shares.some((share) => share.tokenHash === tokenHash));

      const share = {
        id: randomBytes(12).toString("base64url"),
        tokenHash,
        hostId,
        sessionId,
        title: cleanValue(input?.title, 120) || "Codex Session",
        createdAt,
        expiresAt,
        truncated: Boolean(input?.truncated),
        messages,
      };
      const next = shares
        .filter((item) => item.hostId !== hostId || item.sessionId !== sessionId)
        .concat(share)
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
        .slice(-MAX_STORED_SHARES);
      await this.#write(next);
      return { share: publicSessionShare(share), token };
    });
  }

  list({ hostId = "personal", sessionId = "" } = {}) {
    return this.#enqueue(async () => {
      const result = await this.#readActive();
      if (result.changed) await this.#write(result.shares);
      return result.shares
        .filter(
          (share) =>
            share.hostId === cleanValue(hostId, 40) &&
            share.sessionId === cleanValue(sessionId, 200),
        )
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .map(publicSessionShare);
    });
  }

  revoke(id) {
    return this.#enqueue(async () => {
      const result = await this.#readActive();
      const shareId = cleanValue(id, 40);
      const next = result.shares.filter((share) => share.id !== shareId);
      if (next.length !== result.shares.length || result.changed) await this.#write(next);
      return next.length !== result.shares.length;
    });
  }

  resolve(token) {
    return this.#enqueue(async () => {
      if (!TOKEN_PATTERN.test(String(token || ""))) return null;
      const result = await this.#readActive();
      if (result.changed) await this.#write(result.shares);
      const tokenHash = hashSessionShareToken(token);
      const share = result.shares.find((item) => item.tokenHash === tokenHash);
      return share ? structuredClone(share) : null;
    });
  }

  prune() {
    return this.#enqueue(async () => {
      const result = await this.#readActive();
      if (result.changed) await this.#write(result.shares);
      return result.shares.length;
    });
  }

  #enqueue(task) {
    const result = this.operation.then(task, task);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #readActive() {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch {
      return { shares: [], changed: false };
    }
    const source = Array.isArray(parsed?.shares) ? parsed.shares : [];
    const normalized = source.map(normalizeStoredShare).filter(Boolean);
    const now = this.now();
    const shares = normalized.filter((share) => Date.parse(share.expiresAt) > now);
    return {
      shares,
      changed: shares.length !== source.length || normalized.length !== source.length,
    };
  }

  async #write(shares) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify({ version: 1, shares }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await fs.rename(temporary, this.filePath);
  }
}

export function normalizeShareMessages(messages) {
  const normalized = (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const role = message?.role === "assistant" ? "assistant" : message?.role === "user" ? "user" : "";
      const text = cleanValue(message?.text, MAX_SHARE_MESSAGE_CHARS);
      return role && text ? { role, text } : null;
    })
    .filter(Boolean);
  const selected = [];
  let totalChars = 0;
  let truncated = normalized.length > MAX_SHARE_MESSAGES;
  for (let index = normalized.length - 1; index >= 0 && selected.length < MAX_SHARE_MESSAGES; index -= 1) {
    const message = normalized[index];
    if (selected.length && totalChars + message.text.length > MAX_SHARE_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    selected.push(message);
    totalChars += message.text.length;
  }
  selected.reverse();
  Object.defineProperty(selected, "truncated", {
    configurable: false,
    enumerable: false,
    value: truncated,
  });
  return selected;
}

export function hashSessionShareToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

export function publicSessionShare(share) {
  return {
    id: share.id,
    title: share.title,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    truncated: Boolean(share.truncated),
    messageCount: share.messages.length,
  };
}

export function renderSessionSharePage(share) {
  const title = escapeHtml(share?.title || "Codex Session");
  const messages = normalizeShareMessages(share?.messages);
  const content = messages
    .map((message) => {
      const role = message.role === "user" ? "你" : "Codex";
      const type = message.role === "user" ? "user" : "assistant";
      const body = markdown.render(sanitizeSharedMarkdown(message.text));
      return `<article class="message ${type}"><header>${role}</header><div class="markdown">${body}</div></article>`;
    })
    .join("\n");
  const truncated = share?.truncated
    ? '<p class="notice">这份快照较长，较早的部分没有纳入分享。</p>'
    : "";
  return sharePageShell({
    pageTitle: `${share?.title || "Codex Session"} · 静态快照`,
    body: `
      <main>
        <header class="hero">
          <span class="eyebrow">Codex Session · 静态快照</span>
          <h1>${title}</h1>
          <p>创建于 ${escapeHtml(formatShareTime(share?.createdAt))}，有效至 ${escapeHtml(formatShareTime(share?.expiresAt))}。</p>
        </header>
        ${truncated}
        <section class="conversation" aria-label="分享的 Session 对话">
          ${content}
        </section>
        <footer>只读快照 · 不会随原 Session 更新</footer>
      </main>
    `,
  });
}

export function renderUnavailableSessionSharePage() {
  return sharePageShell({
    pageTitle: "分享链接已失效",
    body: `
      <main class="unavailable">
        <span class="eyebrow">Codex Session · 静态快照</span>
        <h1>这个分享链接已失效</h1>
        <p>链接可能已经过期、被撤销，或者地址不完整。请联系分享者重新生成。</p>
      </main>
    `,
  });
}

function normalizeStoredShare(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanValue(value.id, 40);
  const tokenHash = cleanValue(value.tokenHash, 64);
  const createdAt = validIsoTime(value.createdAt);
  const expiresAt = validIsoTime(value.expiresAt);
  const messages = normalizeShareMessages(value.messages);
  if (
    !ID_PATTERN.test(id) ||
    !HASH_PATTERN.test(tokenHash) ||
    !createdAt ||
    !expiresAt ||
    !messages.length
  ) {
    return null;
  }
  return {
    id,
    tokenHash,
    hostId: cleanValue(value.hostId, 40) || "personal",
    sessionId: cleanValue(value.sessionId, 200),
    title: cleanValue(value.title, 120) || "Codex Session",
    createdAt,
    expiresAt,
    truncated: Boolean(value.truncated),
    messages,
  };
}

function cleanValue(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function validIsoTime(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function sanitizeSharedMarkdown(value) {
  return String(value || "")
    .replace(
      /!?\[([^\]\n]{0,500})\]\(\s*<?(?:file:\/\/|\/|~\/|\.\.?\/|[a-zA-Z]:[\\/]|https:\/\/agent\.chenyanglin\.com\/open\/local)[^)\n]*>?(?:\s+["'][^"']*["'])?\s*\)/gi,
      "$1",
    )
    .replace(/<file:[^>\n]+>/gi, "");
}

function formatShareTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function escapeHtml(value) {
  return markdown.utils.escapeHtml(String(value || ""));
}

function sharePageShell({ pageTitle, body }) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${escapeHtml(pageTitle)}</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #e8edf7; background: #080b11; }
      main { width: min(820px, calc(100% - 28px)); margin: 0 auto; padding: 54px 0 48px; }
      .hero { padding: 0 4px 26px; border-bottom: 1px solid #242b38; }
      .eyebrow { color: #8fa6d8; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 9px 0 8px; color: #f5f7fb; font-size: clamp(25px, 5vw, 38px); line-height: 1.18; }
      .hero p, .unavailable p { margin: 0; color: #98a4b8; line-height: 1.65; }
      .conversation { display: grid; gap: 14px; padding: 28px 0; }
      .message { padding: 18px 20px; border: 1px solid #283141; border-radius: 16px; background: #111722; box-shadow: 0 10px 32px rgb(0 0 0 / 16%); }
      .message.user { margin-left: min(11vw, 90px); border-color: #3c568d; background: #172442; }
      .message header { margin-bottom: 10px; color: #8ea5d4; font-size: 12px; font-weight: 750; letter-spacing: .04em; }
      .message.user header { color: #aec4f3; }
      .markdown { min-width: 0; color: #dce3ef; line-height: 1.68; overflow-wrap: anywhere; }
      .markdown > :first-child { margin-top: 0; }
      .markdown > :last-child { margin-bottom: 0; }
      .markdown h1, .markdown h2, .markdown h3, .markdown h4 { margin: 1.2em 0 .5em; font-size: 1.05em; }
      .markdown pre { max-width: 100%; padding: 13px; overflow-x: auto; border: 1px solid #2d3748; border-radius: 10px; background: #080c12; white-space: pre; }
      .markdown code { padding: .12em .34em; border-radius: 5px; color: #f2d29a; background: #202735; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .markdown pre code { padding: 0; color: #dce3ef; background: transparent; }
      .markdown blockquote { margin-left: 0; padding-left: 14px; border-left: 3px solid #455979; color: #aeb9ca; }
      .markdown a { color: #9fbaff; text-underline-offset: 3px; }
      .notice { margin: 18px 0 0; padding: 11px 13px; border: 1px solid #665338; border-radius: 10px; color: #e2c28e; background: #21190f; }
      footer { padding-top: 18px; border-top: 1px solid #242b38; color: #778397; font-size: 12px; text-align: center; }
      .unavailable { min-height: 100dvh; display: grid; align-content: center; }
      .unavailable h1 { margin-top: 10px; }
      @media (max-width: 600px) {
        main { padding-top: 30px; }
        .message { padding: 15px; border-radius: 13px; }
        .message.user { margin-left: 24px; }
      }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}
