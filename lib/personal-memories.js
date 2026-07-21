import fs from "node:fs/promises";
import path from "node:path";

const STORE_DIRECTORY = "personal-memories";
const STORE_FILE = "store.json";
const MAX_TEXT_CHARS = 4_000;
const MAX_CATEGORY_CHARS = 80;
const MAX_PROJECT_CHARS = 300;

export async function readPersonalMemoryView(codexHome, options = {}) {
  const store = await readPersonalMemoryStore(codexHome);
  const view = normalizeView(options.view);
  const project = normalizeProject(options.project);
  let entries = store.entries;

  if (view === "pending") entries = entries.filter((entry) => entry.status === "pending");
  else if (view === "overview") {
    entries = entries.filter((entry) => entry.status === "confirmed" && entry.scope === "global");
  } else if (view === "detail") {
    entries = entries.filter(
      (entry) => entry.status === "confirmed" && entry.scope === "project" && projectMatches(entry.project, project),
    );
  } else entries = [];

  return {
    version: store.version,
    importedAt: store.importedAt,
    importScope: store.importScope,
    counts: memoryCounts(store.entries),
    entries,
    sources: view === "sources" ? store.sources : [],
    project: project || null,
  };
}

export async function readPersonalMemoryStore(codexHome) {
  const file = storePath(codexHome);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    if (error instanceof SyntaxError) throw new Error("Personal memory store contains invalid JSON.");
    throw error;
  }
  return normalizeStore(parsed);
}

export async function updatePersonalMemoryEntry(codexHome, id, changes = {}) {
  const store = await readPersonalMemoryStore(codexHome);
  const entry = store.entries.find((candidate) => candidate.id === normalizeId(id));
  if (!entry) throw memoryNotFound();

  if (Object.hasOwn(changes, "text")) {
    const text = normalizeText(changes.text);
    if (!text) throw invalidMemory("记忆内容不能为空。");
    entry.text = text;
  }
  if (Object.hasOwn(changes, "status")) entry.status = normalizeStatus(changes.status, true);
  if (Object.hasOwn(changes, "category")) entry.category = normalizeCategory(changes.category);
  if (Object.hasOwn(changes, "scope")) entry.scope = normalizeScope(changes.scope, true);
  if (Object.hasOwn(changes, "project")) entry.project = normalizeProject(changes.project) || null;
  if (entry.scope === "project" && !entry.project) throw invalidMemory("项目记忆必须指定项目。");
  if (entry.scope === "global") entry.project = null;
  entry.updatedAt = new Date().toISOString();

  await writeStore(codexHome, store);
  return entry;
}

export async function deletePersonalMemoryEntry(codexHome, id) {
  const store = await readPersonalMemoryStore(codexHome);
  const index = store.entries.findIndex((candidate) => candidate.id === normalizeId(id));
  if (index === -1) throw memoryNotFound();
  const [removed] = store.entries.splice(index, 1);
  await writeStore(codexHome, store);
  return removed;
}

function normalizeStore(value) {
  const store = value && typeof value === "object" ? value : {};
  return {
    version: Number.isInteger(store.version) ? store.version : 1,
    importedAt: normalizeDate(store.importedAt),
    importScope: normalizeImportScope(store.importScope),
    entries: Array.isArray(store.entries) ? store.entries.map(normalizeEntry).filter(Boolean) : [],
    sources: Array.isArray(store.sources) ? store.sources.map(normalizeSource).filter(Boolean) : [],
  };
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object") return null;
  const id = normalizeId(value.id);
  const text = normalizeText(value.text);
  const scope = normalizeScope(value.scope);
  const project = normalizeProject(value.project);
  if (!id || !text || (scope === "project" && !project)) return null;
  return {
    id,
    status: normalizeStatus(value.status),
    scope,
    project: scope === "project" ? project : null,
    category: normalizeCategory(value.category),
    text,
    confidence: ["high", "medium", "low"].includes(value.confidence) ? value.confidence : "medium",
    sensitive: Boolean(value.sensitive),
    evidence: Array.isArray(value.evidence) ? value.evidence.map(normalizeEvidence).filter(Boolean) : [],
    createdAt: normalizeDate(value.createdAt),
    updatedAt: normalizeDate(value.updatedAt),
  };
}

function normalizeSource(value) {
  if (!value || typeof value !== "object") return null;
  const threadId = String(value.threadId || "").trim().slice(0, 100);
  if (!threadId) return null;
  return {
    threadId,
    title: String(value.title || "未命名 Session").trim().slice(0, 500),
    source: String(value.source || "unknown").trim().slice(0, 100),
    archived: Boolean(value.archived),
    decision: value.decision === "excluded" ? "excluded" : "included",
    reason: String(value.reason || "").trim().slice(0, 500),
  };
}

function normalizeEvidence(value) {
  if (!value || typeof value !== "object") return null;
  const threadId = String(value.threadId || "").trim().slice(0, 100);
  if (!threadId) return null;
  return {
    threadId,
    title: String(value.title || "未命名 Session").trim().slice(0, 500),
    quote: String(value.quote || "").trim().slice(0, 600),
  };
}

function memoryCounts(entries) {
  return entries.reduce(
    (counts, entry) => {
      counts.total += 1;
      counts[entry.status] += 1;
      if (entry.scope === "global") counts.global += 1;
      else counts.project += 1;
      return counts;
    },
    { total: 0, pending: 0, confirmed: 0, global: 0, project: 0 },
  );
}

async function writeStore(codexHome, store) {
  const file = storePath(codexHome);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempFile, file);
}

function emptyStore() {
  return { version: 1, importedAt: null, importScope: null, entries: [], sources: [] };
}

function normalizeImportScope(value) {
  if (!value || typeof value !== "object") return null;
  return {
    archived: Boolean(value.archived),
    scanned: Math.max(0, Number(value.scanned) || 0),
    included: Math.max(0, Number(value.included) || 0),
    excluded: Math.max(0, Number(value.excluded) || 0),
    note: String(value.note || "").trim().slice(0, 500),
  };
}

function normalizeView(value) {
  const view = String(value || "overview").toLowerCase();
  return ["overview", "detail", "pending", "sources"].includes(view) ? view : "overview";
}

function normalizeId(value) {
  const id = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._-]{2,99}$/i.test(id) ? id : "";
}

function normalizeText(value) {
  return String(value || "").trim().slice(0, MAX_TEXT_CHARS);
}

function normalizeCategory(value) {
  return String(value || "其他").trim().slice(0, MAX_CATEGORY_CHARS) || "其他";
}

function normalizeProject(value) {
  const project = String(value || "").trim().slice(0, MAX_PROJECT_CHARS);
  return project === "." ? "" : project;
}

function normalizeScope(value, strict = false) {
  if (value === "global" || value === "project") return value;
  if (strict) throw invalidMemory("记忆范围只能是 global 或 project。");
  return "global";
}

function normalizeStatus(value, strict = false) {
  if (value === "pending" || value === "confirmed") return value;
  if (strict) throw invalidMemory("记忆状态只能是 pending 或 confirmed。");
  return "pending";
}

function normalizeDate(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function projectMatches(entryProject, activeProject) {
  const expected = normalizeProject(entryProject).toLowerCase();
  const actual = normalizeProject(activeProject).toLowerCase();
  if (!expected || !actual) return false;
  return expected === actual || path.basename(expected) === path.basename(actual);
}

function storePath(codexHome) {
  return path.join(codexHome, STORE_DIRECTORY, STORE_FILE);
}

function invalidMemory(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function memoryNotFound() {
  const error = new Error("没有找到这条记忆。");
  error.statusCode = 404;
  return error;
}
