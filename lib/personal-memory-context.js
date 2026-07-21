import fsSync from "node:fs";
import path from "node:path";
import { personalMemoryFiles, readPersonalMemoryStore } from "./personal-memories.js";

const MAX_CONTEXT_CHARS = 24_000;
const SENSITIVE_PROMPT_TERMS = /健康|皮肤|痤疮|异维|眼睛|鼻腔|隐形眼镜|人工泪液|医疗|药物|持仓|投资|股票|财务|收入|资产|health|medical|medicine|portfolio|investment|finance/i;

export async function personalMemoryContextForPrompt(codexHome, options = {}) {
  const store = await readPersonalMemoryStore(codexHome);
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
  return buildPersonalMemoryContext(store, { ...options, storePath });
}

export function buildPersonalMemoryContext(store, options = {}) {
  const prompt = String(options.prompt || "");
  const title = String(options.title || "");
  const cwd = path.resolve(String(options.cwd || process.cwd()));
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : "";
  const signal = `${title}\n${prompt}`.toLowerCase();
  const activeProject = projectFromCwd(cwd, workspaceRoot);
  const confirmed = (Array.isArray(store?.entries) ? store.entries : []).filter(
    (entry) => entry && entry.status === "confirmed" && String(entry.text || "").trim(),
  );

  const globals = confirmed.filter(
    (entry) => entry.scope === "global" && (!entry.sensitive || sensitiveEntryRelevant(entry, signal)),
  );
  const projects = confirmed.filter(
    (entry) => entry.scope === "project" && projectEntryRelevant(entry, activeProject, signal),
  );
  const selected = [...globals, ...projects];
  if (!selected.length) return { value: "", entries: [], citation: null, activeProject };

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
  if (!included.length) return { value: "", entries: [], citation: null, activeProject };

  const threadIds = [...new Set(included.flatMap((entry) => entry.evidence || []).map((item) => item?.threadId).filter(Boolean))];
  const ids = included.map((entry) => entry.id);
  return {
    value: lines.join("\n"),
    entries: included,
    activeProject,
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

function projectFromCwd(cwd, workspaceRoot) {
  if (!workspaceRoot) return path.basename(cwd);
  const relative = path.relative(workspaceRoot, cwd);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative.split(path.sep)[0];
}

function projectEntryRelevant(entry, activeProject, signal) {
  const project = String(entry.project || "").toLowerCase();
  if (activeProject && (project === activeProject.toLowerCase() || path.basename(project) === path.basename(activeProject.toLowerCase()))) {
    return true;
  }
  const aliases = [project, path.basename(project), ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => item.length >= 2);
  return aliases.some((alias) => signal.includes(alias));
}

function sensitiveEntryRelevant(entry, signal) {
  if (!SENSITIVE_PROMPT_TERMS.test(signal)) return false;
  const category = String(entry.category || "").toLowerCase();
  if (category && signal.includes(category)) return true;
  if (/健康|医疗|皮肤|药物|护理/.test(category)) return /健康|皮肤|痤疮|异维|眼睛|鼻腔|隐形|泪液|医疗|药物|health|medical|medicine/i.test(signal);
  if (/投资|财务|持仓/.test(category)) return /持仓|投资|股票|财务|资产|portfolio|investment|finance/i.test(signal);
  return false;
}
