import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_ROOT = path.join(os.homedir(), ".config", "agent-terminal-web", "integrations");
const AMAP_VALIDATION_URL =
  process.env.AGENT_AMAP_VALIDATION_URL || "https://restapi.amap.com/v3/geocode/geo";

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

export async function listIntegrations({ root } = {}) {
  return Promise.all(definitions.map((definition) => publicIntegration(definition, { root })));
}

export async function saveIntegrationCredential(id, input, { root, fetchImpl = fetch } = {}) {
  const definition = integrationDefinition(id);
  const values = normalizeValues(definition, input);
  await definition.validate(values, { fetchImpl });

  const now = new Date().toISOString();
  const record = {
    values,
    updatedAt: now,
    verifiedAt: now,
  };
  await writeRecord(definition, record, { root });
  return publicIntegration(definition, { root, record });
}

export async function deleteIntegrationCredential(id, { root } = {}) {
  const definition = integrationDefinition(id);
  const file = credentialPath(definition, { root });
  try {
    await fs.rm(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readIntegrationCredential(id, { root } = {}) {
  const definition = integrationDefinition(id);
  const record = await readRecord(definition, { root });
  return record?.values || null;
}

export function integrationMcpLaunch(id) {
  const definition = integrationDefinition(id);
  return {
    command: definition.mcp.command,
    args: [...definition.mcp.args],
    env: { ...definition.mcp.env },
  };
}

async function publicIntegration(definition, { root, record } = {}) {
  const stored = record === undefined ? await readRecord(definition, { root }) : record;
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    docsUrl: definition.docsUrl,
    fields: definition.fields.map(({ id, label, placeholder, help }) => ({
      id,
      label,
      placeholder,
      help,
      type: "secret",
    })),
    status: {
      configured: Boolean(stored),
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
    if (value.length < 16 || value.length > 128 || /\s/.test(value)) {
      throw new IntegrationError(`${field.label}格式不正确。`, {
        code: "integration_value_invalid",
        status: 400,
      });
    }
    values[field.id] = value;
  }
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

function cleanProviderMessage(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N} _.,:;()（）\-]/gu, "")
    .trim()
    .slice(0, 100);
}

function credentialPath(definition, { root } = {}) {
  return path.join(integrationRoot(root), `${definition.id}.json`);
}

async function readRecord(definition, { root } = {}) {
  const file = credentialPath(definition, { root });
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error("Integration credential is not a regular file.");
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return normalizeRecord(definition, parsed);
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
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);

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
