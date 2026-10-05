import {
  readJsonFile,
  readJsonFileSync,
  writeJsonFileAtomic,
  writeJsonFileAtomicSync,
} from "./json-state-file.js";

const objectRoot = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const titleUpdates = new WeakMap();

function coordinateTitleUpdate(service, sessionId, task) {
  let sessions = titleUpdates.get(service);
  if (!sessions) { sessions = new Map(); titleUpdates.set(service, sessions); }
  const previous = sessions.get(sessionId) || Promise.resolve();
  const operation = previous.then(task, task);
  sessions.set(sessionId, operation);
  const cleanup = () => { if (sessions.get(sessionId) === operation) sessions.delete(sessionId); };
  operation.then(cleanup, cleanup);
  return operation;
}

export function createSyncObjectStateStore({ filePath, label, normalize }) {
  return {
    read() {
      const parsed = readJsonFileSync(filePath, {
        label,
        missingValue: () => ({}),
        validate: objectRoot,
      });
      return normalize(parsed);
    },
    write(value) {
      writeJsonFileAtomicSync(filePath, normalize(value), { label });
    },
    update(mutator) {
      const value = this.read();
      const result = mutator(value);
      this.write(value);
      return result;
    },
  };
}

export function createSessionTitleService({ filePath, isValidSessionId, normalizeTitle }) {
  let operation = Promise.resolve();

  const normalize = (value) => Object.fromEntries(
    Object.entries(value)
      .map(([id, title]) => [String(id), normalizeTitle(title)])
      .filter(([id, title]) => isValidSessionId(id) && title)
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  const read = async () => normalize(await readJsonFile(filePath, {
    label: "Session titles",
    missingValue: () => ({}),
    validate: objectRoot,
  }));

  const enqueue = (task) => {
    const result = operation.then(task, task);
    operation = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    read,
    set(sessionId, title) {
      return enqueue(async () => {
        const titles = await read();
        const cleaned = normalizeTitle(title);
        if (cleaned) titles[sessionId] = cleaned;
        else delete titles[sessionId];
        await writeJsonFileAtomic(filePath, normalize(titles), { label: "Session titles" });
        return cleaned;
      });
    },
  };
}

export async function updateLiveSessionTitle({
  titleService,
  sessionId,
  title,
  resolveFallbackTitle,
  saveNativeName,
  liveSessions,
  persist,
  broadcast,
  onNativeNameError = () => {},
}) {
  return coordinateTitleUpdate(titleService, sessionId, async () => {
    const fallbackTitle = title
      || await resolveFallbackTitle(sessionId)
      || "New Codex session";
    await titleService.set(sessionId, title);

    let nativeNameSaved = false;
    try {
      nativeNameSaved = await saveNativeName(sessionId, title);
    } catch (error) {
      onNativeNameError(error);
    }

    for (const session of liveSessions()) {
      if (session.sessionId !== sessionId) continue;
      session.title = fallbackTitle;
      persist(session);
      broadcast(session);
    }
    return { customTitle: title, nativeNameSaved };
  });
}
