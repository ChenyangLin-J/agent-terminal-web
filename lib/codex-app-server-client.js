import { EventEmitter } from "node:events";
import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppServerConnection } from "@agent-workbench/platform/runtime/core";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_APP_SERVER_ARGS = ["app-server", "--enable", "realtime_conversation"];

function executablePath(command, environment) {
  if (path.isAbsolute(command)) return command;
  for (const directory of String(environment?.PATH || process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, command);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* Try the next launch directory. */ }
  }
  throw new Error(`App Server executable is unavailable: ${command}`);
}

function emitAppServerNotification(emitter, message) {
  emitter.emit("notification", message);
  if (message.method === "error" && emitter.listenerCount("error") === 0) return;
  emitter.emit(message.method, message.params);
}

/** Product launch defaults and legacy facade over Platform's shared transport.
 * JSON-RPC parsing, pending calls, writes and bounded teardown belong to Platform. */
export class CodexAppServerConnection extends AppServerConnection {
  constructor({ command = "codex", args = DEFAULT_APP_SERVER_ARGS, cwd = process.cwd(), env = process.env,
    spawnImpl = spawnProcess, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    clientInfo = { name: "agent_terminal_web", title: "Agent Terminal Web", version: "0.1.0" },
  } = {}) {
    super({ command: executablePath(command, env), args, cwd, env, spawnProcess: spawnImpl, requestTimeoutMs,
      initializeParams: { clientInfo, capabilities: { experimentalApi: true } },
      maxBufferBytes: 32 * 1024 * 1024, maxLineBytes: 32 * 1024 * 1024,
    });
  }

  get started() { return this.state === 'ready'; }
  get closed() { return this.state === 'closed'; }
  get serverInfo() { return this.initializeResult; }

  async start() {
    try { return await super.start(); }
    catch (error) { this.emit('exit', { error }); throw error; }
  }

  emit(type, ...values) {
    if (type === 'notification') {
      const message = values[0]?.message || values[0];
      super.emit(type, message);
      if (message?.method && (message.method !== 'error' || this.listenerCount('error') > 0)) {
        super.emit(message.method, message.params);
      }
      return true;
    }
    if (type === 'server-request') {
      const { id, method, params } = values[0];
      return super.emit(type, { id, method, params });
    }
    if (type === 'exit') {
      if (this.facadeExitHandled) return false;
      this.facadeExitHandled = true;
      const details = values[0];
      return super.emit(type, details?.error || new Error('Codex app-server exited.'));
    }
    return super.emit(type, ...values);
  }
}

export class CodexAppServerClient extends EventEmitter {
  constructor({
    command = "codex",
    args = DEFAULT_APP_SERVER_ARGS,
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

  cancelQueuedTurn(clientUserMessageId) {
    const index = this.pendingTurns.findIndex((turn) => turn.params?.clientUserMessageId === clientUserMessageId);
    if (index < 0) throw new Error('The queued Turn is no longer pending.');
    const [turn] = this.pendingTurns.splice(index, 1);
    turn.reject(Object.assign(new Error('The queued Turn was cancelled.'), { code: 'QUEUED_TURN_CANCELLED' }));
    this.emit('queue-changed', this.pendingTurns.length);
    return { clientUserMessageId, remaining: this.pendingTurns.length };
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

export function appServerMessageThreadId(message) {
  return String(
    message?.params?.threadId ||
      (message?.method === "thread/started" ? message?.params?.thread?.id : "") ||
      "",
  );
}
