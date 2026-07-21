import path from "node:path";

export function gardenLinkForLocalMarkdown(rawHref, { vaultRoot, gardenBaseUrl }) {
  const { filePath, fragment } = parseLocalFileHref(rawHref);
  if (!filePath || path.extname(filePath).toLowerCase() !== ".md") return null;

  const resolved = localFileWithinRoot(filePath, vaultRoot);
  if (!resolved) return null;

  const segments = resolved.relativePath
    .replace(/\.md$/i, "")
    .split(path.sep)
    .map((segment) => segment.trim().replace(/\s+/g, "-").toLowerCase());
  const last = segments.at(-1);
  const parent = segments.at(-2);
  if (last === "index" || (parent && last === parent)) segments.pop();

  const url = new URL(`/${segments.map(encodeURIComponent).join("/")}`, gardenBaseUrl);
  if (fragment) url.hash = fragment;
  return { filePath: resolved.filePath, href: url.href };
}

export function workspaceFileForLocalHref(rawHref, workspaceRoot) {
  const parsed = parseLocalFileHref(rawHref);
  const resolved = localFileWithinRoot(parsed.filePath, workspaceRoot);
  return resolved ? { ...resolved, line: parsed.line, fragment: parsed.fragment } : null;
}

export function isPathInside(root, candidate) {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

export function parseLocalFileHref(rawHref) {
  const value = String(rawHref || "").trim();
  const hashIndex = value.indexOf("#");
  const encodedPath = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const encodedFragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : "";
  let filePath = decode(encodedPath);
  const lineMatch = filePath.match(/:(\d+)(?::\d+)?$/);
  const line = lineMatch ? Number(lineMatch[1]) : null;
  if (lineMatch) filePath = filePath.slice(0, lineMatch.index);
  return { filePath, fragment: decode(encodedFragment), line };
}

function localFileWithinRoot(filePath, root) {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  const absolutePath = path.resolve(filePath);
  if (!isPathInside(root, absolutePath)) return null;
  return {
    filePath: absolutePath,
    relativePath: path.relative(path.resolve(root), absolutePath),
  };
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
