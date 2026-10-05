import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export function readJsonFileSync(
  filePath,
  { label = "JSON state", missingValue = null, validate = null } = {},
) {
  let raw;
  try {
    raw = fsSync.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return cloneMissingValue(missingValue);
    throw stateError(label, filePath, "read", error);
  }
  return parseAndValidate(raw, { label, filePath, validate });
}

export async function readJsonFile(
  filePath,
  { label = "JSON state", missingValue = null, validate = null } = {},
) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return cloneMissingValue(missingValue);
    throw stateError(label, filePath, "read", error);
  }
  return parseAndValidate(raw, { label, filePath, validate });
}

export function writeJsonFileAtomicSync(filePath, value, { label = "JSON state" } = {}) {
  const target = path.resolve(filePath);
  fsSync.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(target);
  try {
    fsSync.writeFileSync(temporary, serialized(value), { mode: 0o600 });
    fsSync.renameSync(temporary, target);
  } catch (error) {
    try {
      fsSync.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw stateError(label, target, "write", error);
  }
}

export async function writeJsonFileAtomic(filePath, value, { label = "JSON state" } = {}) {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(target);
  try {
    await fs.writeFile(temporary, serialized(value), { mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw stateError(label, target, "write", error);
  }
}

function parseAndValidate(raw, { label, filePath, validate }) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw stateError(label, filePath, "parse", error);
  }
  if (validate && !validate(parsed)) {
    throw stateError(label, filePath, "validate", new TypeError("unexpected JSON shape"));
  }
  return parsed;
}

function temporaryPath(filePath) {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function cloneMissingValue(value) {
  return typeof value === "function" ? value() : structuredClone(value);
}

function stateError(label, filePath, operation, cause) {
  return new Error(`${label} ${operation} failed at ${path.resolve(filePath)}: ${cause.message}`, {
    cause,
  });
}
