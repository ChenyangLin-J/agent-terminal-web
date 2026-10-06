import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeUtf8Preview,
  filePreviewFormat,
  formatSqlPreview,
  parseCsvPreview,
  TEXT_PREVIEW_MAX_BYTES,
} from '@agent-workbench/platform/file-preview';
import { isPathInside, parseLocalFileHref, workspaceFileForLocalHref } from './local-file-link.js';

const IMAGE_MIME = new Map([
  ['.avif', 'image/avif'], ['.gif', 'image/gif'], ['.ico', 'image/x-icon'], ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'],
]);
const AUDIO_MIME = new Map([
  ['.aac', 'audio/aac'], ['.m4a', 'audio/mp4'], ['.mp3', 'audio/mpeg'], ['.ogg', 'audio/ogg'], ['.wav', 'audio/wav'],
]);
const CODE_EXTENSIONS = new Set([
  '.bash', '.c', '.cc', '.cjs', '.conf', '.cpp', '.cs', '.css', '.env', '.go', '.graphql', '.h', '.hpp',
  '.ini', '.java', '.js', '.json', '.jsonl', '.jsx', '.kt', '.kts', '.lock', '.mjs', '.php', '.py', '.rb',
  '.rs', '.scss', '.sh', '.sqlx', '.svelte', '.swift', '.toml', '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml', '.zsh',
]);
const CODE_FILENAMES = new Set(['.dockerignore', '.editorconfig', '.gitignore', '.npmrc', '.nvmrc', 'dockerfile', 'makefile', 'procfile']);

export function registerPlatformFilePreviewRoutes(app, {
  workspaceRoot,
  isAuthenticated,
  maxTextBytes = TEXT_PREVIEW_MAX_BYTES,
} = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('Express app is required.');
  if (!path.isAbsolute(String(workspaceRoot || ''))) throw new TypeError('workspaceRoot must be absolute.');
  if (typeof isAuthenticated !== 'function') throw new TypeError('isAuthenticated is required.');

  app.get('/api/platform/file-preview', async (req, res) => {
    if (!(await isAuthenticated(req))) return res.status(401).json({ error: 'Authentication required.' });
    try {
      const file = await resolveAuthorizedFile({ href: req.query.href, base: req.query.base, workspaceRoot });
      const descriptor = await describeFile(file, { maxTextBytes });
      res.set('Cache-Control', 'private, no-store');
      return res.json(descriptor);
    } catch (error) {
      return res.status(error.status || 404).json({ error: error.publicMessage || '这个文件不存在或不能在 Agent 中预览。' });
    }
  });

  app.get('/api/platform/file-resource', async (req, res) => {
    if (!(await isAuthenticated(req))) return res.status(401).json({ error: 'Authentication required.' });
    try {
      const file = await resolveAuthorizedFile({ href: req.query.href, base: req.query.base, workspaceRoot });
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      if (req.query.download === '1') return res.download(file.realPath, file.name);
      const mimeType = mimeTypeFor(file.realPath);
      // HTML is rendered only by the shared sandboxed preview. Raw resources
      // must not become active same-origin documents when navigated directly.
      res.type(mimeType.startsWith('text/html') ? 'text/plain; charset=utf-8' : mimeType);
      return res.sendFile(file.realPath);
    } catch (error) {
      return res.status(error.status || 404).json({ error: error.publicMessage || '这个文件不存在或不能读取。' });
    }
  });
}

export async function resolveAuthorizedFile({ href, base = '', workspaceRoot }) {
  const rawHref = String(href || '').trim();
  const parsed = parseLocalFileHref(normalizeFileUrl(rawHref));
  const realWorkspaceRoot = await fs.realpath(workspaceRoot);
  let candidate = parsed.filePath;
  if (!path.isAbsolute(candidate)) {
    const baseDirectory = await resolveBaseDirectory(base, realWorkspaceRoot);
    candidate = path.resolve(baseDirectory, candidate);
  }
  let realPath;
  try { realPath = await fs.realpath(candidate); }
  catch { throw publicError(404, '这个文件已经不存在。'); }
  const requested = workspaceFileForLocalHref(
    `${realPath}${parsed.line ? `:${parsed.line}` : ''}${parsed.fragment ? `#${parsed.fragment}` : ''}`,
    realWorkspaceRoot,
  );
  if (!requested) throw publicError(404, '这个文件不在 Agent 工作区内。');
  if (!isPathInside(realWorkspaceRoot, realPath)) throw publicError(404, '这个文件不在 Agent 工作区内。');
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw publicError(404, '这个路径不是文件。');
  return {
    ...requested,
    realPath,
    name: path.basename(realPath),
    relativePath: path.relative(realWorkspaceRoot, realPath),
    size: stat.size,
    version: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
  };
}

async function describeFile(file, { maxTextBytes }) {
  const mimeType = mimeTypeFor(file.realPath);
  const extension = path.extname(file.realPath).toLowerCase();
  const resource = (download = false) => `/api/platform/file-resource?${new URLSearchParams({
    href: file.filePath,
    ...(download ? { download: '1' } : {}),
  })}`;
  const common = {
    name: file.name,
    path: file.filePath,
    relativePath: file.relativePath,
    mimeType,
    size: file.size,
    line: file.line,
    highlightLine: file.line,
    version: file.version,
    downloadUrl: resource(true),
    sourceLabel: '本地文件',
  };
  if (IMAGE_MIME.has(extension)) return { ...common, format: 'image', src: resource() };
  if (extension === '.pdf') return { ...common, format: 'pdf', src: resource() };
  if (AUDIO_MIME.has(extension)) return { ...common, format: 'audio', src: resource() };
  if (!isTextPreview(file, mimeType)) return { ...common, format: 'unsupported' };
  if (file.size > maxTextBytes) return { ...common, format: 'unsupported' };

  const bytes = await fs.readFile(file.realPath);
  let content;
  try {
    content = decodeUtf8Preview(bytes, { maxBytes: maxTextBytes });
  } catch (error) {
    if (error?.code === 'PREVIEW_TOO_LARGE' || error?.code === 'PREVIEW_ENCODING_UNSUPPORTED') {
      return { ...common, format: 'unsupported' };
    }
    throw error;
  }
  const platformFormat = filePreviewFormat({ name: file.name, mimeType });
  const format = extension === '.html' || extension === '.htm' ? 'html'
    : CODE_EXTENSIONS.has(extension) || CODE_FILENAMES.has(file.name.toLowerCase()) ? 'code'
      : platformFormat !== 'unsupported' ? platformFormat : 'text';
  const descriptor = { ...common, format, content, rawText: content, rawAvailable: true };
  if (format === 'sql') descriptor.formattedText = formatSqlPreview(content);
  if (format === 'csv') {
    try { descriptor.csv = await parseCsvPreview(content); }
    catch (error) { descriptor.csvError = { message: error?.message || '无法生成 CSV 表格预览。' }; }
  }
  return descriptor;
}

function isTextPreview(file, mimeType) {
  const extension = path.extname(file.realPath).toLowerCase();
  return mimeType.startsWith('text/') || ['.md', '.sql', '.csv', '.html', '.htm'].includes(extension)
    || CODE_EXTENSIONS.has(extension) || CODE_FILENAMES.has(file.name.toLowerCase());
}

async function resolveBaseDirectory(value, workspaceRoot) {
  const raw = normalizeFileUrl(String(value || '').trim());
  if (!raw) return workspaceRoot;
  const parsed = parseLocalFileHref(raw);
  const candidate = path.isAbsolute(parsed.filePath) ? parsed.filePath : path.resolve(workspaceRoot, parsed.filePath);
  try {
    const [realRoot, realCandidate] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(candidate)]);
    if (realCandidate !== realRoot && !isPathInside(realRoot, realCandidate)) return realRoot;
    const stat = await fs.stat(realCandidate);
    return stat.isDirectory() ? realCandidate : path.dirname(realCandidate);
  } catch {
    return workspaceRoot;
  }
}

function normalizeFileUrl(value) {
  if (!/^file:\/\//i.test(value)) return value;
  try { return fileURLToPath(value); } catch { return ''; }
}

function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (IMAGE_MIME.has(extension)) return IMAGE_MIME.get(extension);
  if (AUDIO_MIME.has(extension)) return AUDIO_MIME.get(extension);
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.md') return 'text/markdown; charset=utf-8';
  if (extension === '.csv') return 'text/csv; charset=utf-8';
  if (extension === '.html' || extension === '.htm') return 'text/html; charset=utf-8';
  if (extension === '.json' || extension === '.jsonl') return 'application/json; charset=utf-8';
  return isTextExtension(extension) ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}

function isTextExtension(extension) {
  return ['.txt', '.sql', '.csv', '.md', '.html', '.htm'].includes(extension) || CODE_EXTENSIONS.has(extension);
}

function publicError(status, publicMessage) {
  return Object.assign(new Error(publicMessage), { status, publicMessage });
}
