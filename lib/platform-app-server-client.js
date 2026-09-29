import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import path from "node:path";

import { AgentSessionKernel, CodexAppServerProvider } from "@agent-workbench/platform/runtime/core";

import {
  CodexAppServerClient,
  appServerMessageThreadId,
} from "./codex-app-server-client.js";

const REQUEST_TYPE_METHODS = {
  command_approval: "item/commandExecution/requestApproval",
  file_approval: "item/fileChange/requestApproval",
  permission_approval: "item/permissions/requestApproval",
  user_input: "item/tool/requestUserInput",
  elicitation: "mcpServer/elicitation/request",
};

function normalizeRejection(error) {
  if (error && typeof error === "object" && error.code != null) {
    return { code: error.code, message: String(error.message || "Request rejected.") };
  }
  return { code: -32000, message: error?.message || String(error || "Request rejected.") };
}

// Platform runtime sessions expect `server-request` events to carry respond/reject
// closures; the shared Agent Web connection emits the raw JSON-RPC message instead.
function platformConnectionFor(connection) {
  const shim = new EventEmitter();
  shim.setMaxListeners(0);
  shim.start = () => connection.start();
  shim.request = (method, params) => connection.request(method, params);
  shim.notify = (method, params) => connection.notify(method, params);
  shim.close = () => {};
  connection.on("notification", (message) => shim.emit("notification", message));
  connection.on("server-request", (message) => {
    shim.emit("server-request", {
      id: message.id,
      method: message.method,
      params: message.params,
      respond: (result) => connection.respond(message.id, result),
      reject: (error) => connection.respondError(message.id, normalizeRejection(error)),
    });
  });
  connection.on("exit", (details) => shim.emit("exit", details));
  connection.on("stderr", (text) => shim.emit("stderr", text));
  connection.on("protocol-error", (error, raw) => shim.emit("protocol-error", error, raw));
  return shim;
}

const platformKernels = new WeakMap();

export function platformKernelFor(connection, options = {}) {
  let kernel = platformKernels.get(connection);
  if (kernel) return kernel;
  kernel = new AgentSessionKernel({
    provider: new CodexAppServerProvider({ connection: platformConnectionFor(connection) }),
    bindingStore: options.bindingStore,
    validateRequest: () => {},
    requestTimeoutMs: options.requestTimeoutMs ?? 24 * 60 * 60_000,
    runtimeLeaseMs: options.runtimeLeaseMs ?? 30 * 60_000,
    detachedLeaseMs: options.detachedLeaseMs,
  });
  platformKernels.set(connection, kernel);
  return kernel;
}

export function jsonFileBindingStore(file) {
  const readAll = () => {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  const writeAll = (records) => {
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.tmp`;
    fsSync.writeFileSync(tempFile, JSON.stringify(records, null, 2));
    fsSync.renameSync(tempFile, file);
  };
  return {
    async load(sessionId) {
      return readAll()[String(sessionId)] || null;
    },
    async save(sessionId, patch = {}) {
      const records = readAll();
      records[String(sessionId)] = { ...(records[String(sessionId)] || {}), ...patch };
      writeAll(records);
      return records[String(sessionId)];
    },
  };
}

export class PlatformAppServerClient extends EventEmitter {
  constructor({ sessionId, connection, kernel, cwd = process.cwd() } = {}) {
    super();
    this.setMaxListeners(0);
    if (!sessionId) throw new TypeError("sessionId is required.");
    if (!connection?.request || !connection?.on) throw new TypeError("A shared connection is required.");
    if (!kernel) throw new TypeError("A Platform session kernel is required.");
    this.sessionId = String(sessionId);
    this.kernel = kernel;
    this.connection = connection;
    this.cwd = cwd;
    this.io = new CodexAppServerClient({ cwd, connection });
    this.ownsConnection = false;
    this.pendingTurns = [];
    this.started = false;
    this.closed = false;
    this.kernelUnsubscribe = null;
    this.pendingRequestTokens = new Set();
    this.onKernelEvent = (event) => this.#handleKernelEvent(event);
  }

  get threadId() {
    return this.io.threadId;
  }

  set threadId(value) {
    this.io.threadId = value || "";
  }

  get activeTurnId() {
    return this.io.activeTurnId;
  }

  set activeTurnId(value) {
    this.io.activeTurnId = value || "";
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
    const latestEventId = this.kernel.replay(this.sessionId).latestEventId;
    this.kernelUnsubscribe = this.kernel.subscribe(this.sessionId, this.onKernelEvent, {
      afterEventId: latestEventId,
    });
    await this.io.start();
    this.io.on("notification", (message) => {
      this.emit("notification", message);
      if (message?.method) this.emit(message.method, message.params);
    });
    this.io.on("exit", (error) => {
      this.started = false;
      this.closed = true;
      this.kernelUnsubscribe?.();
      this.kernelUnsubscribe = null;
      this.emit("exit", error);
    });
    this.io.on("server-request", (message) => {
      // Kernel-owned requests (tracked by this Session's thread) arrive through
      // `request_opened` kernel events; forward only unscoped requests that the
      // kernel cannot attribute.
      if (!appServerMessageThreadId(message)) this.emit("server-request", message);
    });
    this.started = true;
    this.emit("ready");
  }

  async startThread(params = {}) {
    this.#assertStarted();
    const description = await this.kernel.attach(this.sessionId, {
      cwd: params.cwd || this.cwd,
      settings: params,
    });
    if (!description.runtimeSessionId) throw new Error("Codex app-server did not return a thread id.");
    this.threadId = description.runtimeSessionId;
    this.io.completedTurnIds.clear();
    return description.initialResult?.thread;
  }

  async resumeThread(threadId, params = {}) {
    const result = await this.resumeThreadWithResult(threadId, params);
    return result.thread;
  }

  async resumeThreadWithResult(threadId, params = {}) {
    this.#assertStarted();
    const normalizedThreadId = String(threadId || "");
    if (!normalizedThreadId) throw new TypeError("threadId is required.");
    await this.kernel.bindingStore.save(this.sessionId, {
      runtimeProvider: "codex",
      runtimeSessionId: normalizedThreadId,
      released: false,
      releaseReason: null,
      cwd: params.cwd || this.cwd,
    });
    const description = await this.kernel.attach(this.sessionId, {
      cwd: params.cwd || this.cwd,
      settings: params,
    });
    this.threadId = description.runtimeSessionId || normalizedThreadId;
    this.activeTurnId = description.activeTurnId || "";
    const result = description.initialResult;
    if (result?.thread) return result;
    return { thread: { id: this.threadId }, ...(result || {}) };
  }

  async unsubscribeThread() {
    this.#assertThread();
    const threadId = this.threadId;
    await this.kernel.releaseRuntime(this.sessionId, { reason: "unsubscribed" });
    this.threadId = "";
    this.activeTurnId = "";
    return { threadId };
  }

  async forkThread(params = {}, { adopt = true } = {}) {
    this.#assertStarted();
    const threadId = String(params.threadId || this.threadId || "");
    if (!threadId) throw new Error("Codex app-server thread has not started.");
    const result = await this.request("thread/fork", { ...params, threadId });
    if (adopt) {
      const forkedId = String(result?.thread?.id || "");
      if (!forkedId) throw new Error("Codex app-server did not return a forked thread id.");
      await this.kernel.releaseRuntime(this.sessionId, { reason: "fork-adopted" }).catch(() => null);
      await this.kernel.bindingStore.save(this.sessionId, {
        runtimeProvider: "codex",
        runtimeSessionId: forkedId,
        released: true,
        releaseReason: "fork-adopted",
      });
      this.threadId = forkedId;
      this.activeTurnId = "";
      this.io.completedTurnIds.clear();
    }
    return result;
  }

  async startTurn(text, params = {}) {
    this.#assertThread();
    const result = await this.kernel.submit(this.sessionId, text, { ...params, mode: "new" });
    if (result.status !== "completed" && result.runtimeTurnId) this.activeTurnId = result.runtimeTurnId;
    return result.raw || { id: result.runtimeTurnId };
  }

  async steerTurn(text, params = {}) {
    this.#assertThread();
    if (!this.activeTurnId) throw new Error("There is no active turn to steer.");
    const result = await this.kernel.submit(this.sessionId, text, { ...params, mode: "steer" });
    return { ...result, turnId: result.runtimeTurnId };
  }

  queueTurn(text, params = {}) {
    this.#assertThread();
    const promise = this.kernel
      .submit(this.sessionId, text, { ...params, mode: "queue" })
      .then((result) => result.raw || { id: result.runtimeTurnId });
    promise.catch(() => {});
    return promise;
  }

  submit(text, { mode = "auto", ...params } = {}) {
    if (mode === "queue") return this.queueTurn(text, params);
    if (mode === "steer") return this.steerTurn(text, params);
    return this.activeTurnId ? this.steerTurn(text, params) : this.startTurn(text, params);
  }

  async interruptTurn() {
    this.#assertThread();
    if (!this.activeTurnId) return;
    await this.kernel.interrupt(this.sessionId, this.activeTurnId);
  }

  async interruptThreadTurn(threadId, turnId) {
    this.#assertStarted();
    if (!threadId || !turnId) throw new Error("Codex thread and turn ids are required.");
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async request(method, params = {}) {
    if (method === "thread/unsubscribe" && params?.threadId === this.threadId) {
      const binding = await this.kernel
        .releaseRuntime(this.sessionId, { reason: "unsubscribed" })
        .catch((error) => {
          if (error?.code === "TURN_ACTIVE") throw error;
          return null;
        });
      if (binding) {
        this.threadId = "";
        this.activeTurnId = "";
        return { threadId: params.threadId };
      }
      // No live kernel Runtime — send the raw unsubscribe so the shared
      // App Server does not keep a stale subscription.
      const result = await this.io.request(method, params);
      this.threadId = "";
      this.activeTurnId = "";
      return result;
    }
    if (method === "turn/interrupt" && params?.threadId === this.threadId) {
      if (!this.activeTurnId) return {};
      return this.kernel.interrupt(this.sessionId, params.turnId || this.activeTurnId);
    }
    return this.io.request(method, params);
  }

  notify(method, params = {}) {
    this.io.notify(method, params);
  }

  respond(id, result) {
    if (this.pendingRequestTokens.delete(id)) {
      void this.kernel.respondToRequest(this.sessionId, id, result).catch((error) => {
        this.emit("request-error", error);
      });
      return;
    }
    this.io.respond(id, result);
  }

  respondError(id, error) {
    if (this.pendingRequestTokens.delete(id)) {
      void this.kernel
        .rejectRequest(this.sessionId, id, normalizeRejection(error))
        .catch((rejectError) => {
          this.emit("request-error", rejectError);
        });
      return;
    }
    this.io.respondError(id, error);
  }

  renewRuntimeLease() {
    this.kernel.renewRuntimeLease(this.sessionId);
  }

  async detach() {
    return this.kernel.detach(this.sessionId);
  }

  async releaseRuntime(reason = "explicit") {
    return this.kernel.releaseRuntime(this.sessionId, { reason });
  }

  async #extension(method, params = {}) {
    return this.request(method, params);
  }

  async readThread({ threadId = this.threadId, includeTurns = false } = {}) {
    this.#assertStarted();
    if (!threadId) throw new Error("Codex app-server thread has not started.");
    const result = await this.#extension("thread/read", { threadId, includeTurns });
    return result?.thread || null;
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
    return this.#extension("thread/turns/list", { threadId, limit, cursor, sortDirection, itemsView });
  }

  async listThreads(params = {}) {
    this.#assertStarted();
    return this.#extension("thread/list", params);
  }

  async searchThreads(searchTerm, params = {}) {
    this.#assertStarted();
    return this.#extension("thread/search", { ...params, searchTerm });
  }

  async searchThreadOccurrences(searchTerm, { threadId = this.threadId, ...params } = {}) {
    this.#assertStarted();
    if (!threadId) throw new Error("Codex app-server thread has not started.");
    return this.#extension("thread/searchOccurrences", { ...params, threadId, searchTerm });
  }

  async listRealtimeVoices() {
    this.#assertStarted();
    return this.#extension("thread/realtime/listVoices", {});
  }

  async startRealtime(params = {}) {
    this.#assertThread();
    return this.#extension("thread/realtime/start", { ...params, threadId: this.threadId });
  }

  async appendRealtimeAudio(audio) {
    this.#assertThread();
    return this.#extension("thread/realtime/appendAudio", { threadId: this.threadId, audio });
  }

  async appendRealtimeText(text, role = "user") {
    this.#assertThread();
    return this.#extension("thread/realtime/appendText", { threadId: this.threadId, text, role });
  }

  async stopRealtime() {
    this.#assertThread();
    return this.#extension("thread/realtime/stop", { threadId: this.threadId });
  }

  async listSkills({ cwds = [this.cwd], forceReload = false } = {}) {
    this.#assertStarted();
    return this.#extension("skills/list", { cwds, forceReload });
  }

  async readConfig({ cwd = this.cwd, includeLayers = false } = {}) {
    this.#assertStarted();
    return this.#extension("config/read", { cwd, includeLayers });
  }

  async readRateLimits() {
    this.#assertStarted();
    return this.#extension("account/rateLimits/read", {});
  }

  async readAccount() {
    this.#assertStarted();
    return this.#extension("account/read", {});
  }

  async readAccountUsage() {
    this.#assertStarted();
    return this.#extension("account/usage/read", null);
  }

  async listModels({ limit = 50, cursor = null } = {}) {
    this.#assertStarted();
    return this.#extension("model/list", { limit, cursor });
  }

  async listMcpServers({ limit = 50, cursor = null, detail = "toolsAndAuthOnly" } = {}) {
    this.#assertThread();
    return this.#extension("mcpServerStatus/list", {
      threadId: this.threadId,
      limit,
      cursor,
      detail,
    });
  }

  async listPlugins({ cwds = [this.cwd] } = {}) {
    this.#assertStarted();
    return this.#extension("plugin/list", { cwds });
  }

  async listHooks({ cwds = [this.cwd] } = {}) {
    this.#assertStarted();
    return this.#extension("hooks/list", { cwds });
  }

  async setThreadName(name, threadId = this.threadId) {
    this.#assertStarted();
    if (!threadId) throw new Error("Codex app-server thread has not started.");
    return this.#extension("thread/name/set", { threadId, name });
  }

  async setThreadArchived(archived, threadId = this.threadId) {
    this.#assertStarted();
    if (!threadId) throw new Error("Codex app-server thread has not started.");
    return this.#extension(archived ? "thread/archive" : "thread/unarchive", { threadId });
  }

  async compactThread() {
    this.#assertThread();
    return this.#extension("thread/compact/start", { threadId: this.threadId });
  }

  async readThreadGoal() {
    this.#assertThread();
    return this.#extension("thread/goal/get", { threadId: this.threadId });
  }

  async setThreadGoal(objective) {
    this.#assertThread();
    return this.#extension("thread/goal/set", { threadId: this.threadId, objective, status: "active" });
  }

  async clearThreadGoal() {
    this.#assertThread();
    return this.#extension("thread/goal/clear", { threadId: this.threadId });
  }

  async startReview(target = { type: "uncommittedChanges" }) {
    this.#assertThread();
    if (this.activeTurnId) throw new Error(`Turn ${this.activeTurnId} is still active.`);
    const result = await this.#extension("review/start", {
      threadId: this.threadId,
      target,
      delivery: "inline",
    });
    const turnId = result?.turn?.id || "";
    if (turnId && !this.io.completedTurnIds.has(turnId)) this.activeTurnId = turnId;
    return result;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.kernel.clearQueue?.(this.sessionId, new Error("Codex app-server client closed."));
    this.kernelUnsubscribe?.();
    this.kernelUnsubscribe = null;
    void this.kernel.detach(this.sessionId).catch(() => {});
    this.io.close();
  }

  #handleKernelEvent(event) {
    if (event?.type === "request_opened") {
      const requestToken = event.payload?.requestToken;
      if (requestToken) this.pendingRequestTokens.add(requestToken);
      this.emit("server-request", {
        id: requestToken,
        method: REQUEST_TYPE_METHODS[event.payload?.requestType] || event.payload?.requestType,
        params: event.payload?.request || {},
      });
      return;
    }
    if (event?.type === "request_expired") {
      if (event.payload?.requestToken) this.pendingRequestTokens.delete(event.payload.requestToken);
      this.emit("request-expired", {
        id: event.payload?.requestToken,
        reason: event.payload?.reason || "expired",
      });
      return;
    }
    if (event?.type === "turn_queued") {
      this.emit("queue-changed", event.payload?.queueLength ?? 0);
    }
  }

  #assertStarted() {
    if (!this.started) throw new Error("Codex app-server client has not initialized.");
  }

  #assertThread() {
    this.#assertStarted();
    if (!this.threadId) throw new Error("Codex app-server thread has not started.");
  }
}
