import fs from "node:fs";
import path from "node:path";

const READ_COMMAND = /\b(cat|sed|head|tail|less|awk|rg|grep)\b|read_file|readTextFile|open_file/i;

export function memoryCitationFromToolItem(item, options = {}) {
  if (!item || typeof item !== "object" || failedItem(item)) return null;
  const source = toolSourceText(item);
  if (item.type === "dynamicToolCall" && /\btools\.apply_patch\s*\(/.test(source)) return null;
  if (!READ_COMMAND.test(source)) return null;
  const memoryRoot = path.resolve(String(options.memoryRoot || ""));
  const workspaceRoot = path.resolve(String(options.workspaceRoot || ""));
  const exists = options.exists || fs.existsSync;
  const candidates = new Set(extractAbsoluteMarkdownPaths(source));

  for (const relative of source.match(/(?:Topics\/)?[A-Za-z0-9._-]+\.md\b/g) || []) {
    if (relative === "Core.md" || relative === "Now.md" || relative.startsWith("Topics/")) {
      candidates.add(path.join(memoryRoot, relative));
    }
  }

  const workdir = toolWorkingDirectory(item, source);
  if (/\bAGENTS\.md\b/.test(source) && workdir) candidates.add(path.join(workdir, "AGENTS.md"));

  const entries = [];
  for (const candidate of candidates) {
    const file = path.resolve(candidate);
    if (!exists(file)) continue;
    if (inside(file, memoryRoot) && file.toLowerCase().endsWith(".md")) {
      const relative = path.relative(memoryRoot, file).split(path.sep).join("/");
      entries.push(citationEntry(file, `本轮实际读取了个人记忆文档 ${relative}`));
      continue;
    }
    const workspaceRelative = path.relative(workspaceRoot, file).split(path.sep);
    if (
      workspaceRelative.length === 2 &&
      workspaceRelative[0] &&
      workspaceRelative[0] !== ".." &&
      workspaceRelative[1] === "AGENTS.md"
    ) {
      entries.push(citationEntry(file, `本轮实际读取了项目规则 ${workspaceRelative.join("/")}`));
    }
  }
  const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  return unique.length ? { entries: unique, threadIds: [] } : null;
}

function citationEntry(file, note) {
  return { path: file, lineStart: 1, lineEnd: null, note };
}

function toolSourceText(item) {
  const values = [item.command, item.arguments, item.input, item.prompt, item.cwd];
  return values
    .map((value) => {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value || "");
      }
    })
    .filter(Boolean)
    .join("\n")
    .replaceAll("\\/", "/");
}

function extractAbsoluteMarkdownPaths(value) {
  return (String(value || "").match(/\/[A-Za-z0-9._~\-/\p{L}\p{N}]+\.md\b/gu) || []).map((file) => file.replace(/[),;]+$/g, ""));
}

function toolWorkingDirectory(item, source) {
  if (path.isAbsolute(String(item.cwd || ""))) return path.resolve(item.cwd);
  const match = String(source || "").match(/(?:"workdir"\s*:\s*"|workdir\s*:\s*")([^"\n]+)"/);
  return match && path.isAbsolute(match[1]) ? path.resolve(match[1]) : "";
}

function inside(file, root) {
  if (!root || root === path.parse(root).root) return false;
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function failedItem(item) {
  const status = String(item.status || "").toLowerCase();
  return item.success === false || ["failed", "error", "cancelled", "canceled"].includes(status);
}
