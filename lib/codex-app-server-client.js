import { EventEmitter } from "node:events";
import { spawn as spawnProcess } from "node:child_process";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function emitAppServerNotification(emitter, message) {
  emitter.emit("notification", message);
  if (message.method === "error" && emitter.listenerCount("error") === 0) return;
  emitter.emit(message.method, message.params);
}

export class CodexAppServerConnection extends EventEmitter {
  constructor({
    command = "codex",
    args = ["app-server"],
    cwd = process.cwd(),
    env = process.env,
    spawnImpl = spawnProcess,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    clientInfo = {
      name: "agent_terminal_web",
      title: "Agent Terminal Web",
      version: "0.1.0",
    },
  } = {}) {
    super();
    this.setMaxListeners(0);
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientInfo = clientInfo;
    this.child = null;
    this.reader = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.serverInfo = null;
    this.started = false;
    this.closed = false;
    this.startPromise = null;
    this.exitHandled = false;
  }

  async start() {
    if (this.started) return;
    if (this.closed) throw new Error("Codex app-server connection is closed.");
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.#start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
    this.child = this.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.once("error", (error) => this.#handleExit(error));
    this.child.once("exit", (code, signal) => {
      this.#handleExit(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}).`));
    });
    this.child.stderr?.on("data", (chunk) => this.emit("stderr", chunk.toString()));

    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => this.#handleLine(line));

    try {
      this.serverInfo = await this.request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});
      this.started = true;
      this.emit("ready");
    } catch (error) {
      this.child?.kill();
      this.#handleExit(error);
      throw error;
    }
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("Codex app-server stdin is unavailable."));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, { method, resolve, reject, timeout });
      this.#write({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, error) {
    this.#write({ id, error });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.reader?.close();
    this.child?.kill();
    this.#handleExit(new Error("Codex app-server connection closed."), { notify: false });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server stdin is unavailable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.emit("protocol-error", new Error("Codex app-server returned invalid JSON."), trimmed);
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        this.emit("orphan-response", message);
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || `Codex app-server request failed: ${pending.method}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined) {
      this.emit("server-request", message);
    } else {
      emitAppServerNotification(this, message);
    }
  }

  #handleExit(error, { notify = true } = {}) {
    if (this.exitHandled) return;
    this.exitHandled = true;
    this.started = false;
    this.closed = true;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    if (notify) this.emit("exit", error);
  }
}

export class CodexAppServerClient extends EventEmitter {
  constructor({
    command = "codex",
    args = ["app-server"],
    cwd = process.cwd(),
    env = process.env,
    spawnImpl = spawnProcess,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    connection = null,
    clientInfo = {
      name: "agent_terminal_web",
      title: "Agent Terminal Web",
      version: "0.1.0",
    },
  } = {}) {
    super();
    this.cwd = cwd;
    this.connection =
      connection ||
      new CodexAppServerConnection({
        command,
        args,
        cwd,
        env,
        spawnImpl,
        requestTimeoutMs,
        clientInfo,
      });
    this.ownsConnection = !connection;
    this.pendingTurns = [];
    this.completedTurnIds = new Set();
    this.queueDraining = false;
    this.threadId = "";
    this.activeTurnId = "";
    this.started = false;
    this.closed = false;
    this.connectionEventsBound = false;
    this.onConnectionNotification = (message) => this.#handleNotification(message);
    this.onConnectionServerRequest = (message) => this.#handleServerRequest(message);
    this.onConnectionStderr = (text) => {
      if (this.ownsConnection) this.emit("stderr", text);
    };
    this.onConnectionProtocolError = (error, raw) => {
      if (this.ownsConnection) this.emit("protocol-error", error, raw);
    };
    this.onConnectionExit = (error) => this.#handleConnectionExit(error);
  }

  get child() {
    return this.connection.child;
  }

  get serverInfo() {
    return this.connection.serverInfo;
  }

  async start() {
    if (this.started) return;
    if (this.closed) throw new Error("Codex app-server client is closed.");
    this.#bindConnectionEvents();
    await this.connection.start();
    this.started = true;
    this.emit("ready");
  }

  async startThread(params = {}) {
    this.#assertStarted();
    const result = await this.request("thread/start", params);
    this.threadId = result?.thread?.id || "";
    if (!this.threadId) throw new Error("Codex app-server did not return a thread id.");
    this.activeTurnId = "";
    this.completedTurnIds.clear();
    return result.thread;
  }

  async resumeThread(threadId, params = {}) {
    const result = await this.resumeThreadWithResult(threadId, params);
    return result.thread;
  }

  async resumeThreadWithResult(threadId, params = {}) {
    this.#assertStarted();
    const previousThreadId = this.threadId;
    const previousActiveTurnId = this.activeTurnId;
    const previousCompletedTurnIds = new Set(this.completedTurnIds);
    this.threadId = threadId;
    this.activeTurnId = "";
    this.completedTurnIds.clear();
    let result;
    try {
      result = await this.request("thread/resume", { ...params, threadId });
    } catch (error) {
      this.threadId = previousThreadId;
      this.activeTurnId = previousActiveTurnId;
      this.completedTurnIds = previousCompletedTurnIds;
      throw error;
    }
    this.threadId = result?.thread?.id || threadId;
    const resumedActiveTurnId = activeTurnIdFromResumeResult(result);
    this.activeTurnId = this.completedTurnIds.has(resumedActiveTurnId) ? "" : resumedActiveTurnId;
    return result;
  }

  async unsubscribeThread() {
    this.#assertThread();
    if (this.activeTurnId) throw new Error(`Turn ${this.activeTurnId} is still active.`);
    const threadId = this.threadId;
    const result = await this.request("thread/unsubscribe", { threadId });
    this.threadId = "";
    this.activeTurnId = "";
    this.completedTurnIds.clear();
    return result;
  }

  async forkThread(params = {}, { adopt = true } = {}) {
    this.#assertStarted();
    const threadId = String(params.threadId || this.threadId || "");
    if (!threadId) throw new Error("Codex app-server thread has not started.");
    const result = await this.request("thread/fork", { ...params, threadId });
    if (adopt) {
      this.threadId = result?.thread?.id || "";
      if (!this.threadId) throw new Error("Codex app-server did not return a forked thread id.");
      this.activeTurnId = "";
      this.completedTurnIds.clear();
    }
    return result;
  }

  async listThreadTurns({
    threadId = this.threadId,
    limit = 3,
    cursor = null,
    sortDirection = "desc",
    itemsView = "full",
  } = {}) {
    this.#assertStarted();
    if (!threadId) throw new Error("Codex app-server thread has not started.");
    return this.request("thread/turns/list", {
      threadId,
      limit,
      cursor,
      sortDirection,
      itemsView,
    });
  }

  async readThread({ threadId = this.threadId, includeTurns = false } = {}) {
    this.#assertStarted();
    if (!threadId) throw new Error("Codex app-server thread has not started.");
    const result = await this.request("thread/read", {
      threadId,
      includeTurns,
    });
    return result?.thread || null;
  }

  async listThreads(params = {}) {
    this.#assertStarted();
    return this.request("thread/list", params);
  }

  async searchThreads(searchTerm, params = {}) {
    this.#assertStarted();
    return this.request("thread/search", { ...params, searchTerm });
  }

  async searchThreadOccurrences(searchTerm, { threadId = this.threadId, ...params } = {}) {
    this.#assertStarted();
    if (!threadId) throw new Error("Codex app-server thread has not started.");
    return this.request("thread/searchOccurrences", { ...params, threadId, searchTerm });
  }

  async interruptThreadTurn(threadId, turnId) {
    this.#assertStarted();
    if (!threadId || !turnId) throw new Error("Codex thread and turn ids are required.");
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async listRealtimeVoices() {
    this.#assertStarted();
    return this.request("thread/realtime/listVoices", {});
  }

  async startRealtime(params = {}) {
    this.#assertThread();
    return this.request("thread/realtime/start", { ...params, threadId: this.threadId });
  }

  async appendRealtimeAudio(audio) {
    this.#assertThread();
    return this.request("thread/realtime/appendAudio", { threadId: this.threadId, audio });
  }

  async appendRealtimeText(text, role = "user") {
    this.#assertThread();
    return this.request("thread/realtime/appendText", { threadId: this.threadId, text, role });
  }

  async stopRealtime() {
    this.#assertThread();
    return this.request("thread/realtime/stop", { threadId: this.threadId });
  }

  async listSkills({ cwds = [this.cwd], forceReload = false } = {}) {
    this.#assertStarted();
    return this.request("skills/list", { cwds, forceReload });
  }

  async readConfig({ cwd = this.cwd, includeLayers = false } = {}) {
    this.#assertStarted();
    return this.request("config/read", { cwd, includeLayers });
  }

  async readRateLimits() {
    this.#assertStarted();
    return this.request("account/rateLimits/read", {});
  }

  async readAccount() {
    this.#assertStarted();
    return this.request("account/read", {});
  }

  async readAccountUsage() {
    this.#assertStarted();
    return this.request("account/usage/read", null);
  }

  async listModels({ limit = 50, cursor = null } = {}) {
    this.#assertStarted();
    return this.request("model/list", { limit, cursor });
  }

  async listMcpServers({ limit = 50, cursor = null, detail = "toolsAndAuthOnly" } = {}) {
    this.#assertThread();
    return this.request("mcpServerStatus/list", {
      threadId: this.threadId,
      limit,
      cursor,
      detail,
    });
  }

  async listPlugins({ cwds = [this.cwd] } = {}) {
    this.#assertStarted();
    return this.request("plugin/list", { cwds });
  }

  async listHooks({ cwds = [this.cwd] } = {}) {
    this.#assertStarted();
    return this.request("hooks/list", { cwds });
  }

  async setThreadName(name, threadId = this.threadId) {
    this.#assertStarted();
    if (!threadId) throw new Error("Codex app-server thread has not started.");
    return this.request("thread/name/set", { threadId, name });
  }

  async setThreadArchived(archived, threadId = this.threadId) {
    this.#assertStarted();
    if (!threadId) throw new Error("Codex app-server thread has not started.");
    return this.request(archived ? "thread/archive" : "thread/unarchive", { threadId });
  }

  async compactThread() {
    this.#assertThread();
    return this.request("thread/compact/start", { threadId: this.threadId });
  }

  async readThreadGoal() {
    this.#assertThread();
    return this.request("thread/goal/get", { threadId: this.threadId });
  }

  async setThreadGoal(objective) {
    this.#assertThread();
    return this.request("thread/goal/set", { threadId: this.threadId, objective, status: "active" });
  }

  async clearThreadGoal() {
    this.#assertThread();
    return this.request("thread/goal/clear", { threadId: this.threadId });
  }

  async startReview(target = { type: "uncommittedChanges" }) {
    this.#assertThread();
    if (this.activeTurnId) throw new Error(`Turn ${this.activeTurnId} is still active.`);
    const result = await this.request("review/start", {
      threadId: this.threadId,
      target,
      delivery: "inline",
    });
    const turnId = result?.turn?.id || "";
    if (turnId) this.activeTurnId = this.completedTurnIds.has(turnId) ? "" : turnId;
    return result;
  }

  async startTurn(text, params = {}) {
    this.#assertThread();
    if (this.activeTurnId) throw new Error(`Turn ${this.activeTurnId} is still active.`);

    const result = await this.request("turn/start", {
      ...params,
      threadId: this.threadId,
      input: normalizeUserInput(text),
    });
    const turnId = result?.turn?.id || "";
    if (!turnId) throw new Error("Codex app-server did not return a turn id.");
    this.activeTurnId = this.completedTurnIds.has(turnId) ? "" : turnId;
    return result.turn;
  }

  async steerTurn(text, params = {}) {
    this.#assertThread();
    if (!this.activeTurnId) throw new Error("There is no active turn to steer.");

    const expectedTurnId = this.activeTurnId;
    let result;
    try {
      result = await this.request("turn/steer", {
        ...params,
        threadId: this.threadId,
        expectedTurnId,
        input: normalizeUserInput(text),
      });
    } catch (error) {
      if (/no active turn/i.test(error.message)) this.activeTurnId = "";
      throw error;
    }
    if (result?.turnId !== expectedTurnId) {
      throw new Error(`Codex app-server steered unexpected turn ${result?.turnId || "unknown"}.`);
    }
    return result;
  }

  queueTurn(text, params = {}) {
    this.#assertThread();
    return new Promise((resolve, reject) => {
      this.pendingTurns.push({ text, params, resolve, reject });
      this.emit("queue-changed", this.pendingTurns.length);
      if (!this.activeTurnId) void this.#drainQueue();
    });
  }

  submit(text, { mode = "auto", ...params } = {}) {
    if (mode === "queue") return this.queueTurn(text, params);
    if (mode === "steer") return this.steerTurn(text, params);
    return this.activeTurnId ? this.steerTurn(text, params) : this.startTurn(text, params);
  }

  async interruptTurn() {
    this.#assertThread();
    if (!this.activeTurnId) return;
    await this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    });
  }

  request(method, params = {}) {
    return this.connection.request(method, params);
  }

  notify(method, params = {}) {
    this.connection.notify(method, params);
  }

  respond(id, result) {
    this.connection.respond(id, result);
  }

  respondError(id, error) {
    this.connection.respondError(id, error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.#unbindConnectionEvents();
    this.#rejectQueuedTurns(new Error("Codex app-server client closed."));
    if (this.ownsConnection) this.connection.close();
  }

  #bindConnectionEvents() {
    if (this.connectionEventsBound) return;
    this.connectionEventsBound = true;
    this.connection.on("notification", this.onConnectionNotification);
    this.connection.on("server-request", this.onConnectionServerRequest);
    this.connection.on("stderr", this.onConnectionStderr);
    this.connection.on("protocol-error", this.onConnectionProtocolError);
    this.connection.on("exit", this.onConnectionExit);
  }

  #unbindConnectionEvents() {
    if (!this.connectionEventsBound) return;
    this.connectionEventsBound = false;
    this.connection.off("notification", this.onConnectionNotification);
    this.connection.off("server-request", this.onConnectionServerRequest);
    this.connection.off("stderr", this.onConnectionStderr);
    this.connection.off("protocol-error", this.onConnectionProtocolError);
    this.connection.off("exit", this.onConnectionExit);
  }

  #handleNotification(message) {
    if (!this.#tracksMessage(message)) return;
    if (message.method === "turn/started") {
      const startedTurnId = message.params?.turn?.id || "";
      if (startedTurnId && !this.completedTurnIds.has(startedTurnId)) this.activeTurnId = startedTurnId;
    }
    if (message.method === "turn/completed") {
      const completedTurnId = message.params?.turn?.id || "";
      if (completedTurnId) {
        this.completedTurnIds.add(completedTurnId);
        while (this.completedTurnIds.size > 100) {
          this.completedTurnIds.delete(this.completedTurnIds.values().next().value);
        }
      }
      if (!completedTurnId || completedTurnId === this.activeTurnId) this.activeTurnId = "";
      queueMicrotask(() => void this.#drainQueue());
    }

    emitAppServerNotification(this, message);
  }

  #handleServerRequest(message) {
    if (!this.#tracksMessage(message)) return;
    this.emit("server-request", message);
  }

  #tracksMessage(message) {
    const messageThreadId = appServerMessageThreadId(message);
    if (!messageThreadId) return true;
    return Boolean(this.threadId) && messageThreadId === this.threadId;
  }

  async #drainQueue() {
    if (this.queueDraining || this.activeTurnId || !this.pendingTurns.length || this.closed) return;
    this.queueDraining = true;
    const next = this.pendingTurns.shift();
    this.emit("queue-changed", this.pendingTurns.length);
    try {
      const turn = await this.startTurn(next.text, next.params);
      next.resolve(turn);
    } catch (error) {
      next.reject(error);
    } finally {
      this.queueDraining = false;
      if (!this.activeTurnId && this.pendingTurns.length) queueMicrotask(() => void this.#drainQueue());
    }
  }

  #rejectQueuedTurns(error) {
    while (this.pendingTurns.length) this.pendingTurns.shift().reject(error);
  }

  #handleConnectionExit(error) {
    if (this.closed) return;
    this.started = false;
    this.closed = true;
    this.#rejectQueuedTurns(error);
    this.emit("exit", error);
    this.#unbindConnectionEvents();
  }

  #assertStarted() {
    if (!this.started) throw new Error("Codex app-server client has not initialized.");
  }

  #assertThread() {
    this.#assertStarted();
    if (!this.threadId) throw new Error("Codex app-server thread has not started.");
  }
}

function activeTurnIdFromResumeResult(result) {
  const turns = [
    ...(Array.isArray(result?.initialTurnsPage?.data) ? result.initialTurnsPage.data : []),
    ...(Array.isArray(result?.thread?.turns) ? result.thread.turns : []),
  ];
  const activeTurn = turns.find((turn) => turn?.status === "inProgress");
  return String(activeTurn?.id || "");
}

function normalizeUserInput(input) {
  if (Array.isArray(input)) return input;
  const text = String(input || "").trim();
  if (!text) throw new Error("Codex user input cannot be empty.");
  return [{ type: "text", text }];
}

function appServerMessageThreadId(message) {
  return String(
    message?.params?.threadId ||
      (message?.method === "thread/started" ? message?.params?.thread?.id : "") ||
      "",
  );
}
