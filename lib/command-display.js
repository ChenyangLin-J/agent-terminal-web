import path from "node:path";

const SHELL_NAMES = new Set(["sh", "bash", "zsh"]);

export function commandDisplayText(command) {
  if (Array.isArray(command)) {
    const parts = command.map((part) => String(part));
    if (isShellLaunch(parts[0], parts[1])) return parts.slice(2).join(" ");
    return parts.join(" ");
  }

  const text = String(command || "").trim();
  const match = text.match(
    /^(?:\/usr\/bin\/env\s+)?(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-lc\s+([\s\S]+)$/,
  );
  return match ? unwrapShellWord(match[1].trim()) : text;
}

function isShellLaunch(executable, option) {
  return option === "-lc" && SHELL_NAMES.has(path.basename(String(executable || "")));
}

function unwrapShellWord(value) {
  if (value.length < 2) return value;
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).split("'\\''").join("'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}
