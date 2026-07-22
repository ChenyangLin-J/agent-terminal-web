import fs from "node:fs/promises";
import path from "node:path";

export async function readProjectRuleDocuments(workspaceRoot, projects = []) {
  const root = path.resolve(workspaceRoot);
  const selected = normalizeProjectNames(projects);
  const names = selected.length ? selected : await directWorkspaceDirectories(root);
  const documents = [];

  for (const name of names) {
    const projectRoot = path.join(root, name);
    if (path.relative(root, projectRoot) !== name) continue;
    try {
      if (!(await fs.stat(projectRoot)).isDirectory()) continue;
      const target = path.join(projectRoot, "AGENTS.md");
      const content = await fs.readFile(target, "utf8");
      documents.push({ project: name, targetPath: target, content });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  return { selectedProjects: selected, documents };
}

async function directWorkspaceDirectories(root) {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function normalizeProjectNames(value) {
  let items = Array.isArray(value) ? value : [value];
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = [value];
    }
  }
  return [...new Set(items
    .map((item) => String(item || "").trim())
    .filter((item) => item && item !== "." && path.basename(item) === item))]
    .slice(0, 50);
}
