import fsSync from "node:fs";
import path from "node:path";
import {
  personalMemoryFiles,
  personalMemoryMarkdownOptions,
  readPersonalMemoryStore,
} from "./personal-memories.js";
import { loadMemorySystemLibrary } from "./memory-system-library.js";
const { readProgressiveMemory, readProgressiveMemorySync } = await loadMemorySystemLibrary("markdown-memory.js");

const MAX_CONTEXT_CHARS = 24_000;
const SENSITIVE_PROMPT_TERMS = /健康|皮肤|痤疮|异维|眼睛|鼻腔|隐形眼镜|人工泪液|医疗|药物|持仓|投资|股票|财务|收入|资产|health|medical|medicine|portfolio|investment|finance/i;

export async function personalMemoryContextForPrompt(codexHome, options = {}) {
  const store = await readPersonalMemoryStore(codexHome);
  const progressive = await readProgressiveMemory({ ...personalMemoryMarkdownOptions(codexHome), workspaceRoot: options.workspaceRoot });
  if (progressive.initialized) return withRouting(progressive, store, options);
  return buildPersonalMemoryContext(store, { ...options, storePath: personalMemoryFiles(codexHome).store });
}

export function personalMemoryContextForPromptSync(codexHome, options = {}) {
  const storePath = personalMemoryFiles(codexHome).store;
  let store = { entries: [] };
  try {
    store = JSON.parse(fsSync.readFileSync(storePath, "utf8"));
  } catch {
    // A missing or temporarily invalid memory file must never prevent a session from starting.
  }
  const progressive = readProgressiveMemorySync({ ...personalMemoryMarkdownOptions(codexHome), workspaceRoot: options.workspaceRoot });
  if (progressive.initialized) return withRouting(progressive, store, options);
  return buildPersonalMemoryContext(store, { ...options, storePath });
}

function withRouting(progressive, store, options) {
  const routing = resolvePersonalMemoryProjects(store, {
    prompt: options.prompt,
    title: options.title,
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    mode: options.memoryProjectMode,
    projects: options.memoryProjects,
    knownProjects: options.knownProjects,
  });
  return {
    ...progressive,
    activeProject: routing.projects[0] || "",
    projects: routing.projects,
    projectSource: routing.source,
    projectMode: routing.mode,
  };
}

export function buildPersonalMemoryContext(store, options = {}) {
  const prompt = String(options.prompt || "");
  const title = String(options.title || "");
  const cwd = path.resolve(String(options.cwd || process.cwd()));
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : "";
  const signal = `${title}\n${prompt}`.toLowerCase();
  const routing = resolvePersonalMemoryProjects(store, {
    prompt,
    title,
    cwd,
    workspaceRoot,
    mode: options.memoryProjectMode,
    projects: options.memoryProjects,
    knownProjects: options.knownProjects,
  });
  const confirmed = (Array.isArray(store?.entries) ? store.entries : []).filter(
    (entry) => entry && entry.status === "confirmed" && String(entry.text || "").trim(),
  );

  const globals = confirmed.filter(
    (entry) => entry.scope === "global" && (!entry.sensitive || sensitiveEntryRelevant(entry, signal)),
  );
  const projects = confirmed.filter(
    (entry) => entry.scope === "project" && routing.projects.some((project) => projectMatches(entry.project, project)),
  );
  const selected = [...globals, ...projects];
  if (!selected.length) {
    return {
      value: "",
      entries: [],
      citation: null,
      activeProject: routing.projects[0] || "",
      projects: routing.projects,
      projectSource: routing.source,
      projectMode: routing.mode,
    };
  }

  const lines = [
    "# User-approved personal memory",
    "Use this as background context only. The current user message always overrides older memory.",
    "Do not mention or expose unrelated sensitive memory. If memory conflicts with the current message, follow the current message and flag the conflict.",
    "When information is insufficient and affects the result, ask the user promptly and offer a concrete modification option.",
    "",
  ];
  const included = [];
  for (const entry of selected) {
    const scope = entry.scope === "project" ? `project:${entry.project}` : "global";
    const line = `- [${entry.id}][${scope}/${entry.category || "其他"}] ${String(entry.text).trim()}`;
    if (lines.join("\n").length + line.length + 1 > MAX_CONTEXT_CHARS) break;
    lines.push(line);
    included.push(entry);
  }
  if (!included.length) {
    return {
      value: "",
      entries: [],
      citation: null,
      activeProject: routing.projects[0] || "",
      projects: routing.projects,
      projectSource: routing.source,
      projectMode: routing.mode,
    };
  }

  const threadIds = [...new Set(included.flatMap((entry) => entry.evidence || []).map((item) => item?.threadId).filter(Boolean))];
  const ids = included.map((entry) => entry.id);
  return {
    value: lines.join("\n"),
    entries: included,
    activeProject: routing.projects[0] || "",
    projects: routing.projects,
    projectSource: routing.source,
    projectMode: routing.mode,
    citation: {
      entries: [
        {
          path: String(options.storePath || ""),
          lineStart: 1,
          lineEnd: null,
          note: `本轮读取了 ${included.length} 条个人记忆：${ids.join("、")}`,
        },
      ],
      threadIds: threadIds.slice(0, 30),
    },
  };
}

export function resolvePersonalMemoryProjects(store, options = {}) {
  const catalog = personalMemoryProjectCatalog(store, options.knownProjects);
  const mode = options.mode === "manual" ? "manual" : "auto";
  const selected = normalizeSelectedProjects(options.projects, catalog);
  if (mode === "manual") return { mode, projects: selected, source: "manual" };

  const promptProjects = detectProjects(String(options.prompt || ""), catalog);
  if (promptProjects.length) return { mode, projects: promptProjects, source: "prompt" };
  if (selected.length) return { mode, projects: selected, source: "retained" };

  const cwdProject = projectFromCwd(
    path.resolve(String(options.cwd || process.cwd())),
    options.workspaceRoot ? path.resolve(options.workspaceRoot) : "",
  );
  const cwdProjects = normalizeSelectedProjects([cwdProject], catalog);
  if (cwdProjects.length) return { mode, projects: cwdProjects, source: "cwd" };

  const titleProjects = detectProjects(String(options.title || ""), catalog);
  if (titleProjects.length) return { mode, projects: titleProjects, source: "title" };
  return { mode, projects: [], source: "global" };
}

export function personalMemoryProjectCatalog(store, knownProjects = []) {
  const catalog = new Map();
  for (const entry of Array.isArray(store?.entries) ? store.entries : []) {
    if (entry?.scope !== "project" || !String(entry.project || "").trim()) continue;
    const project = String(entry.project).trim();
    if (project.toLowerCase() === "workspace") continue;
    const key = project.toLowerCase();
    const current = catalog.get(key) || { project, aliases: new Set(), count: 0, detectable: true };
    current.count += 1;
    for (const alias of [project, path.basename(project), ...(Array.isArray(entry.aliases) ? entry.aliases : [])]) {
      const normalized = String(alias || "").trim().toLowerCase();
      if (normalized.length >= 2) current.aliases.add(normalized);
    }
    catalog.set(key, current);
  }
  for (const raw of Array.isArray(knownProjects) ? knownProjects : []) {
    const project = String(raw || "").trim();
    if (!project || project === "." || project.toLowerCase() === "workspace") continue;
    const key = project.toLowerCase();
    if (catalog.has(key)) continue;
    catalog.set(key, {
      project,
      aliases: new Set([key, path.basename(key)].filter((item) => item.length >= 2)),
      count: 0,
      detectable: project.includes("-"),
    });
  }
  return [...catalog.values()]
    .map((item) => ({
      project: item.project,
      aliases: [...item.aliases].sort((a, b) => b.length - a.length),
      count: item.count,
      detectable: item.detectable,
    }))
    .sort((a, b) => a.project.localeCompare(b.project));
}

function projectFromCwd(cwd, workspaceRoot) {
  if (!workspaceRoot) return path.basename(cwd);
  const relative = path.relative(workspaceRoot, cwd);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative.split(path.sep)[0];
}

function detectProjects(signal, catalog) {
  const normalized = String(signal || "").toLowerCase();
  if (!normalized.trim()) return [];
  return catalog
    .filter((item) => item.detectable !== false && item.aliases.some((alias) => signalIncludesAlias(normalized, alias)))
    .map((item) => item.project);
}

function normalizeSelectedProjects(value, catalog) {
  const requested = Array.isArray(value) ? value : value ? [value] : [];
  const selected = [];
  for (const raw of requested) {
    const project = String(raw || "").trim();
    if (!project || project === ".") continue;
    const match = catalog.find((item) => projectMatches(item.project, project));
    if (match && !selected.includes(match.project)) selected.push(match.project);
  }
  return selected;
}

function projectMatches(expectedValue, actualValue) {
  const expected = String(expectedValue || "").trim().toLowerCase();
  const actual = String(actualValue || "").trim().toLowerCase();
  if (!expected || !actual) return false;
  return expected === actual || path.basename(expected) === path.basename(actual);
}

function signalIncludesAlias(signal, alias) {
  if (!/^[a-z0-9_.-]+$/i.test(alias)) return signal.includes(alias);
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(signal);
}

function sensitiveEntryRelevant(entry, signal) {
  if (!SENSITIVE_PROMPT_TERMS.test(signal)) return false;
  const category = String(entry.category || "").toLowerCase();
  if (category && signal.includes(category)) return true;
  if (/健康|医疗|皮肤|药物|护理/.test(category)) return /健康|皮肤|痤疮|异维|眼睛|鼻腔|隐形|泪液|医疗|药物|health|medical|medicine/i.test(signal);
  if (/投资|财务|持仓/.test(category)) return /持仓|投资|股票|财务|资产|portfolio|investment|finance/i.test(signal);
  return false;
}
