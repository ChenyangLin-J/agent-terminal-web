import fs from "node:fs/promises";
import path from "node:path";

const MEMORY_FILES = Object.freeze({
  overview: "memory_summary.md",
  detail: "MEMORY.md",
  pending: "raw_memories.md",
});
const MAX_DOCUMENT_CHARS = 600_000;
const MAX_SOURCE_COUNT = 200;

export async function readCodexMemoryStatus(codexHome) {
  const memoryRoot = path.join(codexHome, "memories");
  const config = await readText(path.join(codexHome, "config.toml"));
  const configured = memoryConfig(config);
  const documents = {};
  let latestTimestamp = 0;

  for (const [view, fileName] of Object.entries(MEMORY_FILES)) {
    const stat = await safeStat(path.join(memoryRoot, fileName));
    documents[view] = stat
      ? { available: true, bytes: stat.size, updatedAt: stat.mtime.toISOString() }
      : { available: false, bytes: 0, updatedAt: null };
    if (stat) latestTimestamp = Math.max(latestTimestamp, stat.mtimeMs);
  }

  const sources = await listMemorySources(memoryRoot);
  for (const source of sources) latestTimestamp = Math.max(latestTimestamp, Date.parse(source.updatedAt) || 0);

  return {
    enabled: configured.featureEnabled,
    generateMemories: configured.generateMemories,
    useMemories: configured.useMemories,
    disableOnExternalContext: configured.disableOnExternalContext,
    ready: documents.overview.available || documents.detail.available,
    updatedAt: latestTimestamp ? new Date(latestTimestamp).toISOString() : null,
    documents,
    sourceCount: sources.length,
    scope: "Codex 原生记忆目前是全局存储；项目页按当前项目名称和路径筛选，项目中的硬规则仍以 AGENTS.md、Skill 和项目文档为准。",
  };
}

export async function readCodexMemoryView(codexHome, options = {}) {
  const view = normalizeView(options.view);
  const memoryRoot = path.join(codexHome, "memories");
  const status = await readCodexMemoryStatus(codexHome);

  if (view === "sources") {
    const sources = await listMemorySources(memoryRoot);
    const sourceName = safeSourceName(options.source);
    const selected = sourceName ? sources.find((source) => source.name === sourceName) : null;
    return {
      view,
      status,
      sources,
      selected: selected
        ? {
            ...selected,
            content: truncateDocument(await readText(path.join(memoryRoot, "rollout_summaries", selected.name))),
          }
        : null,
    };
  }

  if (view === "changes") {
    return { view, status, document: { name: "", content: "", available: false, project: null, projects: [], filtered: false } };
  }

  const fileName = MEMORY_FILES[view];
  const originalContent = truncateDocument(await readText(path.join(memoryRoot, fileName)));
  const projects = normalizeProjects(options.projects ?? options.project);
  const project = projects[0] || "";
  const content = view === "detail" && projects.length ? projectMemorySections(originalContent, projects) : originalContent;
  return {
    view,
    status,
    document: {
      name: fileName,
      content,
      available: Boolean(originalContent),
      project: project || null,
      projects,
      filtered: Boolean(view === "detail" && projects.length),
    },
  };
}

export function projectMemorySections(markdown, project) {
  const content = String(markdown || "").trim();
  const queries = normalizeProjects(project);
  if (!content || !queries.length) return content;

  const aliases = new Set(
    queries
      .flatMap((query) => [path.basename(query).toLowerCase(), query.toLowerCase()])
      .filter((value) => value && value !== "."),
  );
  const sections = splitMarkdownSections(content);
  const matches = sections.filter((section) => {
    const haystack = section.toLowerCase();
    return [...aliases].some((alias) => haystack.includes(alias));
  });
  if (!matches.length) {
    return `这些项目还没有可识别的长期记忆。\n\n筛选范围：${queries.map((query) => `\`${query}\``).join("、")}\n\nCodex 会在完成并闲置的会话中后台整理记忆；明确的工程规则仍应写进项目 AGENTS.md、Skill 或项目文档。`;
  }
  return matches.join("\n\n").trim();
}

function splitMarkdownSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let current = [];
  for (const line of lines) {
    if (/^#{1,2}\s+/.test(line) && current.length) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length) sections.push(current.join("\n").trim());
  return sections.filter(Boolean);
}

function memoryConfig(toml) {
  return {
    featureEnabled: tomlBoolean(toml, "features", "memories", false),
    generateMemories: tomlBoolean(toml, "memories", "generate_memories", true),
    useMemories: tomlBoolean(toml, "memories", "use_memories", true),
    disableOnExternalContext: tomlBoolean(toml, "memories", "disable_on_external_context", false),
  };
}

function tomlBoolean(toml, section, key, fallback) {
  const sectionPattern = new RegExp(`(?:^|\\n)\\[${escapeRegExp(section)}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`, "i");
  const sectionMatch = String(toml || "").match(sectionPattern);
  if (!sectionMatch) return fallback;
  const valuePattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, "im");
  const valueMatch = sectionMatch[1].match(valuePattern);
  return valueMatch ? valueMatch[1].toLowerCase() === "true" : fallback;
}

async function listMemorySources(memoryRoot) {
  const sourceRoot = path.join(memoryRoot, "rollout_summaries");
  let entries;
  try {
    entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .slice(0, MAX_SOURCE_COUNT);
  const sources = (
    await Promise.all(
      files.map(async (entry) => {
        const stat = await safeStat(path.join(sourceRoot, entry.name));
        return stat
          ? { name: entry.name, bytes: stat.size, updatedAt: stat.mtime.toISOString() }
          : null;
      }),
    )
  )
    .filter(Boolean)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return sources;
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function safeStat(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function truncateDocument(value) {
  const text = String(value || "");
  if (text.length <= MAX_DOCUMENT_CHARS) return text;
  const headLength = Math.floor(MAX_DOCUMENT_CHARS * 0.6);
  const tailLength = MAX_DOCUMENT_CHARS - headLength;
  return `${text.slice(0, headLength)}\n\n… 中间内容已折叠 …\n\n${text.slice(-tailLength)}`;
}

function normalizeView(view) {
  const value = String(view || "overview").toLowerCase();
  return ["overview", "detail", "pending", "sources", "changes"].includes(value) ? value : "overview";
}

function normalizeProject(project) {
  const value = String(project || "").trim();
  if (!value || value === ".") return "";
  return value.slice(0, 500);
}

function normalizeProjects(value) {
  let values = Array.isArray(value) ? value : [value];
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) values = parsed;
    } catch {
      // A malformed optional filter falls back to a single project value.
    }
  }
  return [...new Set(values.map(normalizeProject).filter(Boolean))].slice(0, 20);
}

function safeSourceName(source) {
  const value = String(source || "").trim();
  if (!value || path.basename(value) !== value || !value.toLowerCase().endsWith(".md")) return "";
  return value.slice(0, 300);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
