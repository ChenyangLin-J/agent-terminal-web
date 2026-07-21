import path from "node:path";

export function gardenLinkForLocalMarkdown(rawHref, { vaultRoot, gardenBaseUrl }) {
  const { filePath, fragment } = splitLocalHref(rawHref);
  if (!filePath || path.extname(filePath).toLowerCase() !== ".md") return null;

  const root = path.resolve(vaultRoot);
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;

  const segments = relativePath
    .replace(/\.md$/i, "")
    .split(path.sep)
    .map((segment) => segment.trim().replace(/\s+/g, "-").toLowerCase());
  const last = segments.at(-1);
  const parent = segments.at(-2);
  if (last === "index" || (parent && last === parent)) segments.pop();

  const url = new URL(`/${segments.map(encodeURIComponent).join("/")}`, gardenBaseUrl);
  if (fragment) url.hash = fragment;
  return { filePath: absolutePath, href: url.href };
}

function splitLocalHref(rawHref) {
  const value = String(rawHref || "").trim();
  const hashIndex = value.indexOf("#");
  const encodedPath = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const fragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : "";
  try {
    return { filePath: decodeURIComponent(encodedPath), fragment: decodeURIComponent(fragment) };
  } catch {
    return { filePath: encodedPath, fragment };
  }
}
