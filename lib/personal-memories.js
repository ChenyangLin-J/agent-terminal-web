import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { overlayStoreFromMarkdown, readAllMemoryFiles } from "../../memory-system/lib/markdown-memory.js";
import { syncLegacyStoreChanges } from "../../memory-system/lib/legacy-adapter.js";

const STORE_DIRECTORY = "personal-memories";
const STORE_FILE = "store.json";
const RUNTIME_FILE = "worker-state.json";
const HISTORY_FILE = "history.jsonl";
const LOCK_FILE = "store.lock";
const MAX_TEXT_CHARS = 4_000;
const MAX_CATEGORY_CHARS = 80;
const MAX_PROJECT_CHARS = 300;
const MAX_TOMBSTONES = 200;
const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 120_000;

export async function readPersonalMemoryView(codexHome, options = {}) {
  const view = normalizeView(options.view);
  const [store, runtime, markdown] = await Promise.all([
    readPersonalMemoryStore(codexHome),
    readPersonalMemoryRuntime(codexHome),
    view === "overview"
      ? readAllMemoryFiles(personalMemoryMarkdownOptions(codexHome))
      : Promise.resolve({ files: [] }),
  ]);
  const locations = new Map(markdown.files.flatMap((file) => file.entries.map((entry) => [entry.id, memoryLocationLabel(file)])));
  const projects = normalizeProjects(options.projects ?? options.project);
  const project = projects[0] || "";
  let entries = store.entries;

  if (view === "pending") entries = entries.filter((entry) => entry.status === "pending");
  else if (view === "overview") {
    entries = entries.filter((entry) => entry.status === "confirmed" && entry.scope === "global");
  } else if (view === "detail") {
    entries = entries.filter(
      (entry) =>
        entry.status === "confirmed" &&
        entry.scope === "project" &&
        projects.some((selectedProject) => projectMatches(entry.project, selectedProject)),
    );
  } else entries = [];

  return {
    version: store.version,
    importedAt: store.importedAt,
    importScope: store.importScope,
    counts: memoryCounts(store.entries),
    entries: entries.map((entry) => ({ ...entry, memoryLocation: locations.get(entry.id) || "" })),
    documents: view === "overview" ? markdown.files.map(personalMemoryDocument) : [],
    sources: view === "sources" ? store.sources : [],
    project: project || null,
    selectedProjects: projects,
    projectCatalog: memoryProjectCatalog(store.entries),
    runtime,
  };
}

function personalMemoryDocument(file) {
  return {
    kind: file.meta.kind,
    slug: file.meta.slug || "",
    title: file.meta.title || path.basename(file.file, ".md"),
    description: file.meta.description || "",
    readWhen: file.meta.readWhen || "",
    sensitive: Boolean(file.meta.sensitive),
    fileName: path.basename(file.file),
    content: file.content,
  };
}

function memoryLocationLabel(file) {
  if (file.meta.kind === "core") return "Core";
  if (file.meta.kind === "now") return "Now";
  if (file.meta.kind === "topic") return `Topic · ${file.meta.title || file.meta.slug}`;
  return "个人记忆";
}

export async function readPersonalMemoryStore(codexHome) {
  return overlayStoreFromMarkdown(await readRawPersonalMemoryStore(codexHome), personalMemoryMarkdownOptions(codexHome));
}

export function personalMemoryMarkdownOptions(codexHome) {
  const resolved = path.resolve(codexHome);
  const liveCodexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  return resolved === liveCodexHome
    ? { codexHome: resolved }
    : { codexHome: resolved, memoryRoot: path.join(resolved, "memory-markdown") };
}

async function readRawPersonalMemoryStore(codexHome) {
  const file = personalMemoryPath(codexHome, STORE_FILE);
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

export async function readPersonalMemoryRuntime(codexHome) {
  try {
    const parsed = JSON.parse(await fs.readFile(personalMemoryPath(codexHome, RUNTIME_FILE), "utf8"));
    return normalizeRuntime(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyRuntime();
    if (error instanceof SyntaxError) return { ...emptyRuntime(), status: "error", lastError: "worker-state.json 无法解析" };
    throw error;
  }
}

export async function writePersonalMemoryRuntime(codexHome, runtime) {
  const normalized = normalizeRuntime(runtime);
  await writeJsonAtomic(personalMemoryPath(codexHome, RUNTIME_FILE), normalized);
  return normalized;
}

export async function reconcilePersonalMemoryMarkdown(codexHome) {
  return withStoreLock(codexHome, async () => ({ result: true, audit: null }));
}

export async function updatePersonalMemoryEntry(codexHome, id, changes = {}, actor = "user") {
  return withStoreLock(codexHome, async (store) => {
    const entry = store.entries.find((candidate) => candidate.id === normalizeId(id));
    if (!entry) throw memoryNotFound();
    const before = structuredClone(entry);

    if (changes.status === "confirmed" && entry.proposedTargetId && entry.proposalAction) {
      const target = store.entries.find((candidate) => candidate.id === entry.proposedTargetId);
      if (!target) throw invalidMemory("这条建议对应的原记忆已不存在，请删除建议后重新整理。");
      if (entry.proposalAction === "retire") {
        store.entries = store.entries.filter((candidate) => ![entry.id, target.id].includes(candidate.id));
        store.tombstones.push({
          id: target.id,
          text: target.text,
          deletedAt: new Date().toISOString(),
          reason: "用户确认自动整理建议",
        });
        store.tombstones = store.tombstones.slice(-MAX_TOMBSTONES);
        return {
          result: target,
          audit: auditEvent("approve-retire", actor, target, { proposalId: entry.id, before }),
        };
      }

      const targetBefore = structuredClone(target);
      Object.assign(target, {
        scope: entry.scope,
        project: entry.project,
        aliases: entry.aliases,
        category: entry.category,
        text: entry.text,
        confidence: entry.confidence,
        sensitive: entry.sensitive,
        evidence: mergeEvidence(target.evidence, entry.evidence),
        status: "confirmed",
        proposedTargetId: null,
        proposalAction: null,
        updatedAt: new Date().toISOString(),
      });
      store.entries = store.entries.filter((candidate) => candidate.id !== entry.id);
      return {
        result: target,
        audit: auditEvent("approve-update", actor, target, { proposalId: entry.id, before: targetBefore }),
      };
    }

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

    return {
      result: entry,
      audit: auditEvent("update", actor, entry, { before, changes: auditChanges(changes) }),
    };
  });
}

export async function deletePersonalMemoryEntry(codexHome, id, actor = "user") {
  return withStoreLock(codexHome, async (store) => {
    const index = store.entries.findIndex((candidate) => candidate.id === normalizeId(id));
    if (index === -1) throw memoryNotFound();
    const [removed] = store.entries.splice(index, 1);
    store.tombstones.push({
      id: removed.id,
      text: removed.text,
      deletedAt: new Date().toISOString(),
      reason: actor === "worker" ? "自动整理明确替代" : "用户删除",
    });
    store.tombstones = store.tombstones.slice(-MAX_TOMBSTONES);
    return { result: removed, audit: auditEvent("delete", actor, removed) };
  });
}

export async function applyPersonalMemoryProposals(codexHome, proposals, source = {}) {
  return withStoreLock(codexHome, async (store) => {
    const results = [];
    const audit = [];
    const now = new Date().toISOString();
    const normalizedSource = normalizeSource({ ...source, archived: false, decision: "included" });
    if (normalizedSource) {
      const sourceIndex = store.sources.findIndex((item) => item.threadId === normalizedSource.threadId);
      if (sourceIndex === -1) store.sources.push(normalizedSource);
      else store.sources[sourceIndex] = { ...store.sources[sourceIndex], ...normalizedSource };
    }

    for (const rawProposal of Array.isArray(proposals) ? proposals : []) {
      const proposal = normalizeProposal(rawProposal, source);
      if (!proposal) continue;
      const target = proposal.targetId ? store.entries.find((entry) => entry.id === proposal.targetId) : null;
      const sensitive = Boolean(target?.sensitive) || proposal.sensitive || sensitiveMemory(proposal.category, proposal.text);

      if (proposal.action === "retire") {
        if (!target) continue;
        if (pendingChangeExists(store.entries, proposal, target, "retire")) {
          results.push({ action: "duplicate", id: "", status: "ignored" });
          continue;
        }
        const pending = proposedChangeEntry(proposal, target, now, "retire");
        store.entries.push(pending);
        results.push({ action: "pending-retire", id: pending.id, status: pending.status });
        audit.push(auditEvent("pending-retire", "worker", pending, { proposal }));
        continue;
      }

      if (proposal.action === "update" && target) {
        if (pendingChangeExists(store.entries, proposal, target, "update")) {
          results.push({ action: "duplicate", id: "", status: "ignored" });
          continue;
        }
        const pending = proposedChangeEntry(proposal, target, now, "update");
        store.entries.push(pending);
        results.push({ action: "pending-update", id: pending.id, status: pending.status });
        audit.push(auditEvent("pending-update", "worker", pending, { proposal }));
        continue;
      }

      if (duplicateEntry(store.entries, proposal)) {
        results.push({ action: "duplicate", id: "", status: "ignored" });
        continue;
      }
      if (tombstoneMatches(store.tombstones, proposal.text)) {
        results.push({ action: "tombstoned", id: "", status: "ignored" });
        continue;
      }

      const entry = {
        ...proposalEntryFields(proposal),
        id: proposal.id || generatedMemoryId(proposal),
        status: "pending",
        sensitive,
        proposedTargetId: null,
        proposalAction: null,
        createdAt: now,
        updatedAt: now,
      };
      store.entries.push(entry);
      results.push({ action: "created", id: entry.id, status: entry.status });
      audit.push(auditEvent("create", "worker", entry, { proposal }));
    }

    store.tombstones = store.tombstones.slice(-MAX_TOMBSTONES);
    return { result: results, audit };
  });
}

export function personalMemoryFiles(codexHome) {
  const root = path.join(codexHome, STORE_DIRECTORY);
  return {
    root,
    store: path.join(root, STORE_FILE),
    runtime: path.join(root, RUNTIME_FILE),
    history: path.join(root, HISTORY_FILE),
  };
}

function normalizeStore(value) {
  const store = value && typeof value === "object" ? value : {};
  return {
    version: 2,
    importedAt: normalizeDate(store.importedAt),
    importScope: normalizeImportScope(store.importScope),
    entries: Array.isArray(store.entries) ? store.entries.map(normalizeEntry).filter(Boolean) : [],
    sources: Array.isArray(store.sources) ? store.sources.map(normalizeSource).filter(Boolean) : [],
    tombstones: Array.isArray(store.tombstones) ? store.tombstones.map(normalizeTombstone).filter(Boolean) : [],
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
    aliases: normalizeAliases(value.aliases),
    category: normalizeCategory(value.category),
    text,
    confidence: normalizeConfidenceLabel(value.confidence),
    sensitive: Boolean(value.sensitive),
    evidence: Array.isArray(value.evidence) ? value.evidence.map(normalizeEvidence).filter(Boolean) : [],
    rationale: String(value.rationale || "").trim().slice(0, 1_000),
    proposedTargetId: normalizeId(value.proposedTargetId) || null,
    proposalAction: ["update", "retire"].includes(value.proposalAction) ? value.proposalAction : null,
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

function normalizeTombstone(value) {
  if (!value || typeof value !== "object") return null;
  const id = normalizeId(value.id);
  const text = normalizeText(value.text);
  if (!id || !text) return null;
  return {
    id,
    text,
    deletedAt: normalizeDate(value.deletedAt),
    reason: String(value.reason || "").trim().slice(0, 500),
  };
}

function normalizeRuntime(value) {
  const runtime = value && typeof value === "object" ? value : {};
  const usage = runtime.usage && typeof runtime.usage === "object" ? runtime.usage : {};
  const days = {};
  for (const [day, item] of Object.entries(usage.days || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !item || typeof item !== "object") continue;
    days[day] = {
      runs: Math.max(0, Number(item.runs) || 0),
      inputTokens: Math.max(0, Number(item.inputTokens) || 0),
      outputTokens: Math.max(0, Number(item.outputTokens) || 0),
      estimated: Boolean(item.estimated),
    };
  }
  return {
    version: Number.isInteger(runtime.version) ? runtime.version : 1,
    initializedAt: normalizeDate(runtime.initializedAt),
    status: ["idle", "running", "error", "disabled"].includes(runtime.status) ? runtime.status : "disabled",
    lastRunAt: normalizeDate(runtime.lastRunAt),
    lastSuccessAt: normalizeDate(runtime.lastSuccessAt),
    lastError: String(runtime.lastError || "").slice(0, 2_000),
    consecutiveFailures: Math.max(0, Number(runtime.consecutiveFailures) || 0),
    threads: runtime.threads && typeof runtime.threads === "object" ? runtime.threads : {},
    usage: {
      totalRuns: Math.max(0, Number(usage.totalRuns) || 0),
      totalInputTokens: Math.max(0, Number(usage.totalInputTokens) || 0),
      totalOutputTokens: Math.max(0, Number(usage.totalOutputTokens) || 0),
      days,
      lastAlertedDay: String(usage.lastAlertedDay || ""),
    },
    lastRun: normalizeRunSummary(runtime.lastRun),
    alerts: Array.isArray(runtime.alerts) ? runtime.alerts.map(normalizeAlert).filter(Boolean).slice(-20) : [],
  };
}

function normalizeRunSummary(value) {
  if (!value || typeof value !== "object") return null;
  return {
    scanned: Math.max(0, Number(value.scanned) || 0),
    eligible: Math.max(0, Number(value.eligible) || 0),
    processed: Math.max(0, Number(value.processed) || 0),
    created: Math.max(0, Number(value.created) || 0),
    confirmed: Math.max(0, Number(value.confirmed) || 0),
    pending: Math.max(0, Number(value.pending) || 0),
    failed: Math.max(0, Number(value.failed) || 0),
    nativeReviewed: Math.max(0, Number(value.nativeReviewed) || 0),
    nativeCandidates: Math.max(0, Number(value.nativeCandidates) || 0),
  };
}

function normalizeAlert(value) {
  if (!value || typeof value !== "object") return null;
  const message = String(value.message || "").trim().slice(0, 1_000);
  if (!message) return null;
  return { type: String(value.type || "info").slice(0, 40), message, createdAt: normalizeDate(value.createdAt) };
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

async function withStoreLock(codexHome, operation) {
  const root = personalMemoryPath(codexHome, "");
  const lockFile = path.join(root, LOCK_FILE);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(lockFile);
  try {
    const rawStore = await readRawPersonalMemoryStore(codexHome);
    const markdownOptions = personalMemoryMarkdownOptions(codexHome);
    const store = await overlayStoreFromMarkdown(rawStore, markdownOptions);
    await syncLegacyStoreChanges(rawStore, store, { ...markdownOptions, actor: "user", source: "obsidian-edit" });
    const before = structuredClone(store);
    const outcome = await operation(store);
    const events = [outcome?.audit].flat().filter(Boolean);
    const actor = events.some((event) => event.actor === "user") ? "user" : "worker";
    await syncLegacyStoreChanges(before, store, {
      ...markdownOptions,
      actor,
      source: actor === "user" ? "agent-web" : "session-worker",
    });
    await writeJsonAtomic(personalMemoryPath(codexHome, STORE_FILE), store);
    if (events.length) {
      await fs.appendFile(
        personalMemoryPath(codexHome, HISTORY_FILE),
        `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        { mode: 0o600 },
      );
    }
    return outcome?.result;
  } finally {
    await lock.close().catch(() => {});
    await fs.unlink(lockFile).catch(() => {});
  }
}

async function acquireLock(file) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCK_WAIT_MS) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.unlink(file).catch(() => {});
      await delay(50);
    }
  }
  throw new Error("记忆文件正在被其他进程更新，请稍后重试。");
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempFile, file);
}

function normalizeProposal(value, source) {
  if (!value || typeof value !== "object") return null;
  const action = ["create", "update", "retire"].includes(value.action) ? value.action : "create";
  const text = normalizeText(value.text);
  const scope = normalizeScope(value.scope);
  const project = normalizeProject(value.project);
  if ((action !== "retire" && !text) || (scope === "project" && !project)) return null;
  const evidence = normalizeEvidence({
    threadId: source.threadId,
    title: source.title,
    quote: value.evidenceQuote,
  });
  return {
    action,
    id: normalizeId(value.id),
    targetId: normalizeId(value.targetId),
    scope,
    project: scope === "project" ? project : null,
    aliases: normalizeAliases(value.aliases),
    category: normalizeCategory(value.category),
    text: text || "建议停止使用这条旧记忆。",
    confidence: Math.min(1, Math.max(0, Number(value.confidence) || 0)),
    confidenceLabel: confidenceLabelFromNumber(value.confidence),
    explicit: value.explicit === true,
    conflict: value.conflict === true,
    sensitive: value.sensitive === true,
    evidence: evidence ? [evidence] : [],
    rationale: String(value.rationale || "").trim().slice(0, 1_000),
  };
}

function proposalEntryFields(proposal) {
  return {
    scope: proposal.scope,
    project: proposal.project,
    aliases: proposal.aliases,
    category: proposal.category,
    text: proposal.text,
    confidence: proposal.confidenceLabel,
    sensitive: proposal.sensitive || sensitiveMemory(proposal.category, proposal.text),
    evidence: proposal.evidence,
    rationale: proposal.rationale,
  };
}

function proposedChangeEntry(proposal, target, now, action) {
  return {
    ...proposalEntryFields(proposal),
    aliases: normalizeAliases([...(target.aliases || []), ...proposal.aliases]),
    id: generatedMemoryId({ ...proposal, text: `${proposal.text}-${target.id}-${now}` }),
    status: "pending",
    proposedTargetId: target.id,
    proposalAction: action,
    createdAt: now,
    updatedAt: now,
  };
}

function duplicateEntry(entries, proposal) {
  const text = comparableText(proposal.text);
  return entries.some((entry) => comparableText(entry.text) === text && entry.scope === proposal.scope && entry.project === proposal.project);
}

function pendingChangeExists(entries, proposal, target, action) {
  const text = comparableText(proposal.text);
  return entries.some(
    (entry) =>
      entry.status === "pending" &&
      entry.proposedTargetId === target.id &&
      entry.proposalAction === action &&
      comparableText(entry.text) === text,
  );
}

function tombstoneMatches(tombstones, text) {
  const expected = comparableText(text);
  return tombstones.some((item) => comparableText(item.text) === expected);
}

function comparableText(value) {
  return String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function generatedMemoryId(proposal) {
  const prefix = proposal.scope === "project" ? `project-${slug(proposal.project)}` : "global";
  const category = slug(proposal.category) || "memory";
  const hash = createHash("sha256").update(`${proposal.scope}|${proposal.project || ""}|${proposal.text}`).digest("hex").slice(0, 10);
  return `${prefix}-${category}-${hash}`.slice(0, 100);
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 35);
}

function sensitiveMemory(category, text) {
  return /(健康|医疗|疾病|药物|住址|地址|持仓|财务|收入|资产|health|medical|finance|address)/i.test(`${category} ${text}`);
}

function mergeEvidence(existing, incoming) {
  const merged = [...(existing || []), ...(incoming || [])];
  const seen = new Set();
  return merged.filter((item) => {
    const key = `${item.threadId}|${item.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-20);
}

function auditEvent(action, actor, entry, extra = {}) {
  return {
    at: new Date().toISOString(),
    action,
    actor,
    entryId: entry?.id || "",
    status: entry?.status || "",
    text: entry?.text || "",
    ...extra,
  };
}

function auditChanges(changes) {
  return Object.fromEntries(Object.entries(changes || {}).filter(([key]) => ["text", "status", "category", "scope", "project"].includes(key)));
}

function emptyStore() {
  return { version: 2, importedAt: null, importScope: null, entries: [], sources: [], tombstones: [] };
}

function emptyRuntime() {
  return {
    version: 1,
    initializedAt: null,
    status: "disabled",
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: "",
    consecutiveFailures: 0,
    threads: {},
    usage: { totalRuns: 0, totalInputTokens: 0, totalOutputTokens: 0, days: {}, lastAlertedDay: "" },
    lastRun: null,
    alerts: [],
  };
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
  return ["overview", "detail", "pending", "sources", "changes"].includes(view) ? view : "overview";
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

function normalizeProjects(value) {
  let values = Array.isArray(value) ? value : [value];
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) values = parsed;
    } catch {
      // A malformed optional filter simply falls back to the single project value.
    }
  }
  return [...new Set(values.map(normalizeProject).filter(Boolean))].slice(0, 20);
}

function memoryProjectCatalog(entries) {
  const projects = new Map();
  for (const entry of entries) {
    if (entry.scope !== "project" || !entry.project) continue;
    if (entry.project.toLowerCase() === "workspace") continue;
    const key = entry.project.toLowerCase();
    const current = projects.get(key) || { project: entry.project, count: 0 };
    current.count += 1;
    projects.set(key, current);
  }
  return [...projects.values()].sort((a, b) => a.project.localeCompare(b.project));
}

function normalizeAliases(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))].slice(0, 20);
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

function normalizeConfidenceLabel(value) {
  return ["high", "medium", "low"].includes(value) ? value : "medium";
}

function confidenceLabelFromNumber(value) {
  const confidence = Number(value) || 0;
  return confidence >= 0.86 ? "high" : confidence >= 0.65 ? "medium" : "low";
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

function personalMemoryPath(codexHome, file) {
  return path.join(codexHome, STORE_DIRECTORY, file);
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
