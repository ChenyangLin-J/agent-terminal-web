import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_ROOT = path.join(os.homedir(), ".config", "agent-terminal-web", "integrations");
const DEFAULT_CUBOX_CONFIG_DIR = path.join(os.homedir(), ".config", "cubox-cli");
const AMAP_VALIDATION_URL =
  process.env.AGENT_AMAP_VALIDATION_URL || "https://restapi.amap.com/v3/geocode/geo";
const CUBOX_VALIDATION_URL =
  process.env.NODE_ENV === "test" && process.env.AGENT_CUBOX_VALIDATION_URL
    ? process.env.AGENT_CUBOX_VALIDATION_URL
    : "https://cubox.pro/c/api/cli/folder/list";
const integrationMutationTails = new Map();

const definitions = [
  {
    id: "amap",
    name: "高德地图",
    description: "为 Codex 提供实时地点搜索、地点详情和路线规划。",
    docsUrl: "https://lbs.amap.com/api/mcp-server/create-project-and-key",
    fields: [
      {
        id: "apiKey",
        label: "Web 服务 Key",
        placeholder: "输入新的高德 Key",
        help: "保存后不会再次显示；替换时输入完整的新 Key。",
      },
    ],
    mcp: {
      command: "npx",
      args: ["-y", "@amap/amap-maps-mcp-server@0.0.8"],
      env: {
        AMAP_MAPS_API_KEY: "apiKey",
      },
    },
    validate: validateAmap,
  },
  {
    id: "cubox",
    name: "Cubox 国内版",
    description: "让 Codex 安全读取、搜索和整理你的 Cubox 阅读库。",
    docsUrl: "https://cubox.pro/web/settings/extensions",
    docsLabel: "获取 API Link",
    fields: [
      {
        id: "apiLink",
        label: "API Link",
        placeholder: "https://cubox.pro/c/api/save/…",
        help: "仅支持国内版 cubox.pro；保存后不会再次显示，也不会进入 Agent 对话。",
      },
    ],
    storage: "cubox-cli",
    validate: validateCubox,
  },
  {
    id: "tikhub",
    name: "TikHub",
    description: "为小红书调研保存 TikHub API Key；只有获批的采集任务才会使用。",
    docsUrl: "https://user.tikhub.io/dashboard/api",
    docsLabel: "获取 API Key",
    fields: [
      {
        id: "apiKey",
        label: "API Key",
        placeholder: "输入新的 TikHub API Key",
        help: "保存后不会再次显示；保存本身不会调用 TikHub 或产生费用。",
        maxLength: 2048,
      },
    ],
    verification: "on-use",
    validate: validateTikHub,
  },
];

const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));

export class IntegrationError extends Error {
  constructor(message, { code = "integration_error", status = 400 } = {}) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.status = status;
  }
}

export function integrationRoot(value = "") {
  return path.resolve(value || process.env.AGENT_INTEGRATIONS_DIR || DEFAULT_ROOT);
}

export function cuboxConfigRoot(value = "") {
  const testOverride = process.env.NODE_ENV === "test"
    ? process.env.AGENT_CUBOX_CONFIG_DIR
    : "";
  return path.resolve(value || testOverride || DEFAULT_CUBOX_CONFIG_DIR);
}

export function integrationDefinition(id) {
  const definition = definitionsById.get(String(id || ""));
  if (!definition) {
    throw new IntegrationError("这个集成不存在。", {
      code: "integration_not_found",
      status: 404,
    });
  }
  return definition;
}

export async function listIntegrations({ root, cuboxConfigDir, cuboxEnvironment } = {}) {
  return Promise.all(
    definitions.map((definition) =>
      publicIntegration(definition, { root, cuboxConfigDir, cuboxEnvironment }),
    ),
  );
}

export async function saveIntegrationCredential(
  id,
  input,
  {
    root,
    cuboxConfigDir,
    cuboxEnvironment,
    confirmReplace = false,
    fetchImpl = fetch,
  } = {},
) {
  const definition = integrationDefinition(id);
  return withIntegrationMutation(definition.id, async () => {
    if (definition.storage === "cubox-cli") {
      await assertCuboxMutationAllowed(definition, {
        cuboxConfigDir,
        cuboxEnvironment,
        confirmReplace,
      });
    }

    const values = normalizeValues(definition, input);
    const validatedValues = (await definition.validate(values, { fetchImpl })) || values;
    if (definition.storage === "cubox-cli") {
      await assertCuboxMutationAllowed(definition, {
        cuboxConfigDir,
        cuboxEnvironment,
        confirmReplace,
      });
    }

    const now = new Date().toISOString();
    const record = {
      values: validatedValues,
      updatedAt: now,
      verifiedAt: definition.verification === "on-use" ? "" : now,
    };
    await writeCredentialRecord(definition, record, { root, cuboxConfigDir });
    return publicIntegration(definition, { root, cuboxConfigDir, cuboxEnvironment, record });
  });
}

export async function deleteIntegrationCredential(
  id,
  { root, cuboxConfigDir, cuboxEnvironment } = {},
) {
  const definition = integrationDefinition(id);
  return withIntegrationMutation(definition.id, async () => {
    if (definition.storage === "cubox-cli") {
      assertNoCuboxEnvironmentOverride(cuboxEnvironment);
      const stored = await readCuboxRecord(definition, { cuboxConfigDir });
      if (stored?.conflict === "external-server") throw cuboxServerConflict();
      if (!stored) return false;
    }

    const file = credentialPath(definition, { root, cuboxConfigDir });
    try {
      await fs.rm(file);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  });
}

export async function readIntegrationCredential(
  id,
  { root, cuboxConfigDir, cuboxEnvironment } = {},
) {
  const definition = integrationDefinition(id);
  const record = await readCredentialRecord(definition, {
    root,
    cuboxConfigDir,
    cuboxEnvironment,
  });
  return record?.values || null;
}

export function integrationMcpLaunch(id) {
  const definition = integrationDefinition(id);
  if (!definition.mcp) {
    throw new IntegrationError("这个集成不提供 MCP 服务。", {
      code: "integration_mcp_unavailable",
      status: 400,
    });
  }
  return {
    command: definition.mcp.command,
    args: [...definition.mcp.args],
    env: { ...definition.mcp.env },
  };
}

async function publicIntegration(
  definition,
  { root, cuboxConfigDir, cuboxEnvironment, record } = {},
) {
  let stored = record;
  let readFailed = false;
  if (stored === undefined) {
    try {
      stored = await readCredentialRecord(definition, {
        root,
        cuboxConfigDir,
        cuboxEnvironment,
      });
    } catch {
      stored = null;
      readFailed = true;
    }
  }
  const state = readFailed ? "error" : stored?.state || (stored ? "ready" : "off");
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    docsUrl: definition.docsUrl,
    docsLabel: definition.docsLabel || "申请 Key",
    verification: definition.verification || "on-save",
    fields: definition.fields.map(({ id, label, placeholder, help, minLength, maxLength }) => ({
      id,
      label,
      placeholder,
      help,
      type: "secret",
      minLength: minLength || 16,
      maxLength: maxLength || 128,
    })),
    status: {
      configured: state === "ready",
      state,
      message: readFailed
        ? "现有凭证配置无法安全读取；可重新保存一份有效凭证进行修复。"
        : stored?.message || "",
      canReplace: Boolean(stored?.canReplace),
      updatedAt: stored?.updatedAt || "",
      verifiedAt: stored?.verifiedAt || "",
    },
  };
}

function normalizeValues(definition, input) {
  const source = input && typeof input === "object" ? input : {};
  const values = {};
  for (const field of definition.fields) {
    const value = String(source[field.id] || "").trim();
    if (!value) {
      throw new IntegrationError(`请输入${field.label}。`, {
        code: "integration_value_required",
        status: 400,
      });
    }
    const minLength = field.minLength || 16;
    const maxLength = field.maxLength || 128;
    if (value.length < minLength || value.length > maxLength || /\s/.test(value)) {
      throw new IntegrationError(`${field.label}格式不正确。`, {
        code: "integration_value_invalid",
        status: 400,
      });
    }
    values[field.id] = value;
  }
  return values;
}

async function validateTikHub(values) {
  return values;
}

async function validateAmap(values, { fetchImpl }) {
  const url = new URL(AMAP_VALIDATION_URL);
  url.search = new URLSearchParams({
    key: values.apiKey,
    address: "北京市朝阳区金泉家园",
    city: "北京",
  }).toString();

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new IntegrationError("暂时无法连接高德，请稍后重试。", {
      code: "integration_validation_unavailable",
      status: 502,
    });
  }

  if (!response.ok) {
    throw new IntegrationError("高德验证服务暂时不可用。", {
      code: "integration_validation_unavailable",
      status: 502,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new IntegrationError("高德返回了无法识别的验证结果。", {
      code: "integration_validation_unavailable",
      status: 502,
    });
  }

  if (String(data?.status) !== "1") {
    const detail = cleanProviderMessage(data?.info);
    throw new IntegrationError(detail ? `高德拒绝了这个 Key：${detail}` : "高德拒绝了这个 Key。", {
      code: "integration_validation_failed",
      status: 422,
    });
  }
}

async function validateCubox(values, { fetchImpl }) {
  const credential = parseCuboxApiLink(values.apiLink);
  let response;
  try {
    response = await fetchImpl(CUBOX_VALIDATION_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential.token}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new IntegrationError("暂时无法连接 Cubox，请稍后重试。", {
      code: "integration_validation_unavailable",
      status: 502,
    });
  }

  if (!response.ok) {
    const rejected = response.status === 401 || response.status === 403;
    throw new IntegrationError(
      rejected ? "Cubox 拒绝了这个 API Link，请确认已启用 API 扩展。" : "Cubox 验证服务暂时不可用。",
      {
        code: rejected ? "integration_validation_failed" : "integration_validation_unavailable",
        status: rejected ? 422 : 502,
      },
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new IntegrationError("Cubox 返回了无法识别的验证结果。", {
      code: "integration_validation_unavailable",
      status: 502,
    });
  }

  if (Number(data?.code) !== 200 || !Array.isArray(data?.data)) {
    throw new IntegrationError("Cubox 拒绝了这个 API Link，请重新生成后再试。", {
      code: "integration_validation_failed",
      status: 422,
    });
  }

  return credential;
}

function parseCuboxApiLink(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw invalidCuboxApiLink();
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "cubox.pro" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalidCuboxApiLink();
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const token = parts.length === 4 && parts[0] === "c" && parts[1] === "api" && parts[2] === "save"
    ? parts[3]
    : "";
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(token)) throw invalidCuboxApiLink();
  return { server: "cubox.pro", token };
}

function invalidCuboxApiLink() {
  return new IntegrationError("请输入 Cubox 国内版生成的完整 API Link。", {
    code: "integration_value_invalid",
    status: 400,
  });
}

function cleanProviderMessage(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N} _.,:;()（）\-]/gu, "")
    .trim()
    .slice(0, 100);
}

function credentialPath(definition, { root, cuboxConfigDir } = {}) {
  if (definition.storage === "cubox-cli") {
    return path.join(cuboxConfigRoot(cuboxConfigDir), "config.json");
  }
  return path.join(integrationRoot(root), `${definition.id}.json`);
}

async function readCredentialRecord(
  definition,
  { root, cuboxConfigDir, cuboxEnvironment } = {},
) {
  if (definition.storage === "cubox-cli") {
    const environmentConflict = cuboxEnvironmentConflict(cuboxEnvironment);
    if (environmentConflict) return environmentConflict;
    return readCuboxRecord(definition, { cuboxConfigDir });
  }
  return readRecord(definition, { root });
}

async function readRecord(definition, { root } = {}) {
  const directory = integrationRoot(root);
  const file = credentialPath(definition, { root });
  try {
    const directoryStat = await fs.lstat(directory);
    if (
      !directoryStat.isDirectory() ||
      (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) ||
      (directoryStat.mode & 0o077) !== 0
    ) {
      throw new Error("Integration credential directory is not private.");
    }
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("Integration credential is not a private regular file.");
    }
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return normalizeRecord(definition, parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readCuboxRecord(definition, { cuboxConfigDir } = {}) {
  const directory = cuboxConfigRoot(cuboxConfigDir);
  const file = credentialPath(definition, { cuboxConfigDir });
  try {
    const directoryStat = await fs.lstat(directory);
    if (
      !directoryStat.isDirectory() ||
      (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) ||
      (directoryStat.mode & 0o077) !== 0
    ) {
      throw new Error("Cubox CLI credential directory is not private.");
    }
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("Cubox CLI credential is not a private regular file.");
    }
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    const server = String(parsed?.server || "").trim();
    const token = String(parsed?.token || "").trim();
    if (!token || !["cubox.pro", "cubox.cc"].includes(server)) {
      throw new Error("Cubox CLI credential is invalid.");
    }
    if (server !== "cubox.pro") {
      return {
        values: { server, token },
        state: "conflict",
        conflict: "external-server",
        canReplace: true,
        message: "Cubox CLI 当前登录的是国际版；保存国内版会替换现有登录。",
        updatedAt: stat.mtime.toISOString(),
        verifiedAt: "",
      };
    }
    const timestamp = stat.mtime.toISOString();
    return {
      values: { server, token },
      updatedAt: timestamp,
      verifiedAt: "",
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function normalizeRecord(definition, value) {
  if (!value || typeof value !== "object") throw new Error("Integration credential is invalid.");
  const values = {};
  for (const field of definition.fields) {
    const secret = String(value.values?.[field.id] || "");
    if (!secret) throw new Error("Integration credential is incomplete.");
    values[field.id] = secret;
  }
  return {
    values,
    updatedAt: validDateString(value.updatedAt),
    verifiedAt: validDateString(value.verifiedAt),
  };
}

function validDateString(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

async function writeRecord(definition, record, { root } = {}) {
  const directory = integrationRoot(root);
  await ensurePrivateDirectory(directory);

  const file = credentialPath(definition, { root: directory });
  const temporary = path.join(directory, `.${definition.id}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeCredentialRecord(definition, record, { root, cuboxConfigDir } = {}) {
  if (definition.storage === "cubox-cli") {
    await writeCuboxRecord(definition, record, { cuboxConfigDir });
    return;
  }
  await writeRecord(definition, record, { root });
}

async function writeCuboxRecord(definition, record, { cuboxConfigDir } = {}) {
  const directory = cuboxConfigRoot(cuboxConfigDir);
  await ensurePrivateDirectory(directory);
  const file = credentialPath(definition, { cuboxConfigDir: directory });
  const temporary = path.join(directory, `.config.${process.pid}.${randomUUID()}.tmp`);
  const data = {
    server: record.values.server,
    token: record.values.token,
  };
  try {
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function ensurePrivateDirectory(directory) {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory()) throw new Error("Integration credential directory is not a directory.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory()) throw new Error("Integration credential directory is not a directory.");
  }
  await fs.chmod(directory, 0o700);
}

async function assertCuboxMutationAllowed(
  definition,
  { cuboxConfigDir, cuboxEnvironment, confirmReplace },
) {
  assertNoCuboxEnvironmentOverride(cuboxEnvironment);
  let stored;
  try {
    stored = await readCuboxRecord(definition, { cuboxConfigDir });
  } catch {
    return;
  }
  if (stored?.conflict === "external-server" && !confirmReplace) {
    throw cuboxServerConflict();
  }
}

function cuboxEnvironmentConflict(value) {
  const source = value || {
    server: Boolean(process.env.CUBOX_SERVER),
    token: Boolean(process.env.CUBOX_TOKEN),
  };
  if (!source.server && !source.token) return null;
  return {
    values: {},
    state: "conflict",
    conflict: "environment",
    canReplace: false,
    message: "服务器环境变量正在覆盖 Cubox CLI 配置；请先从服务环境中移除 CUBOX_SERVER/CUBOX_TOKEN。",
    updatedAt: "",
    verifiedAt: "",
  };
}

function assertNoCuboxEnvironmentOverride(value) {
  if (!cuboxEnvironmentConflict(value)) return;
  throw new IntegrationError("服务器环境变量正在覆盖 Cubox CLI 配置，无法在这里安全修改。", {
    code: "integration_environment_conflict",
    status: 409,
  });
}

function cuboxServerConflict() {
  return new IntegrationError("Cubox CLI 当前登录的是国际版；替换为国内版需要再次确认。", {
    code: "integration_server_conflict",
    status: 409,
  });
}

async function withIntegrationMutation(id, operation) {
  const previous = integrationMutationTails.get(id) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  integrationMutationTails.set(id, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (integrationMutationTails.get(id) === tail) integrationMutationTails.delete(id);
  }
}
