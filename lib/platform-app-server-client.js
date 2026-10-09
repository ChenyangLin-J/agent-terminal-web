import { EventEmitter } from "node:events";
import path from "node:path";

import { pathToFileURL } from 'node:url';
const { AgentSessionKernel, CodexAppServerProvider } = await import(process.env.AGENT_PLATFORM_CANDIDATE
  ? pathToFileURL(path.resolve(process.env.AGENT_PLATFORM_CANDIDATE, 'src/runtime/core/index.js')).href
  : '@agent-workbench/platform/runtime/core');

import {
  appServerMessageThreadId,
} from "./codex-app-server-client.js";
import { readJsonFileSync, writeJsonFileAtomicSync } from "./json-state-file.js";

const REQUEST_TYPE_METHODS = {
  command_approval: "item/commandExecution/requestApproval",
  file_approval: "item/fileChange/requestApproval",
  permission_approval: "item/permissions/requestApproval",
  user_input: "item/tool/requestUserInput",
  elicitation: "mcpServer/elicitation/request",
};

const KERNEL_OWNED_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "thread/unsubscribe",
  "thread/settings/update",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

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
    hasHostActiveWork: options.hasHostActiveWork,
  });
  platformKernels.set(connection, kernel);
  return kernel;
}

export function jsonFileBindingStore(file) {
  const readAll = () => readJsonFileSync(file, {
    label: "Platform runtime bindings",
    missingValue: {},
    validate: (value) => value && typeof value === "object" && !Array.isArray(value),
  });
  const writeAll = (records) => writeJsonFileAtomicSync(file, records, {
    label: "Platform runtime bindings",
  });
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
    if (typeof kernel.describeRuntime !== 'function') throw new TypeError('This adapter requires Platform v0.35.0+ (describeRuntime); set AGENT_PLATFORM_CANDIDATE when testing an unreleased candidate.');
    this.sessionId = String(sessionId);
    this.kernel = kernel;
    this.connection = connection;
    this.cwd = cwd;
    this.runtimeSessionId = "";
    this.ownsConnection = false;
    this.managesRuntimeLease = true;
    this.started = false;
    this.closed = false;
    this.connectionEventsBound = false;
    this.kernelUnsubscribe = null;
    this.pendingRequestTokens = new Set();
    this.onKernelEvent = (event) => this.#handleKernelEvent(event);
    this.onConnectionNotification = (message) => this.#handleConnectionNotification(message);
    this.onConnectionServerRequest = (message) => this.#handleConnectionServerRequest(message);
    this.onConnectionExit = (error) => this.#handleConnectionExit(error);
  }

  get threadId() {
    return this.describeRuntime().runtimeSessionId || this.runtimeSessionId;
  }

  get activeTurnId() {
    return this.describeRuntime().activeTurnId || "";
  }

  get runtimeLeaseExpiresAt() {
    return this.describeRuntime().runtimeLeaseExpiresAt;
  }

  // This is deliberately a read-only facade. Product adapters use it to
  // project execution state; the kernel remains the only owner of it.
  describeRuntime() {
    return this.kernel.describeRuntime(this.sessionId);
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
    this.#bindConnectionEvents();
    await this.connection.start();
    this.started = true;
    this.emit("ready");
  }

  async startThread(params = {}) {
    await this.#waitForRuntimeRelease();
    this.#assertStarted();
    const description = await this.kernel.attach(this.sessionId, {
      cwd: params.cwd || this.cwd,
      settings: params,
    });
    if (!description.runtimeSessionId) throw new Error("Codex app-server did not return a thread id.");
    this.runtimeSessionId = description.runtimeSessionId;
    return description.initialResult?.thread;
  }

  async resumeThread(threadId, params = {}) {
    const result = await this.resumeThreadWithResult(threadId, params);
    return result.thread;
  }

  async resumeThreadWithResult(threadId, params = {}) {
    await this.#waitForRuntimeRelease();
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
    this.runtimeSessionId = description.runtimeSessionId || normalizedThreadId;
    const result = description.initialResult;
    if (result?.thread) return result;
    return { thread: { id: this.threadId }, ...(result || {}) };
  }

  async unsubscribeThread() {
    this.#assertThread();
    const threadId = this.threadId;
    await this.kernel.releaseRuntime(this.sessionId, { reason: "unsubscribed" });
    this.runtimeSessionId = "";
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
      this.runtimeSessionId = forkedId;
    }
    return result;
  }

  async startTurn(text, params = {}) {
    await this.#waitForRuntimeRelease();
    this.#assertThread();
    const result = await this.kernel.submit(this.sessionId, text, { ...params, mode: "new" });
    return result.raw || { id: result.runtimeTurnId };
  }

  async steerTurn(text, params = {}) {
    await this.#waitForRuntimeRelease();
    this.#assertThread();
    if (!this.activeTurnId) throw new Error("There is no active turn to steer.");
    const result = await this.kernel.submit(this.sessionId, text, { ...params, mode: "steer" });
    return { ...result, turnId: result.runtimeTurnId };
  }

  async queueTurn(text, params = {}) {
    await this.#waitForRuntimeRelease();
    this.#assertThread();
    const promise = this.kernel
      .submit(this.sessionId, text, { ...params, mode: "queue" })
      .then((result) => result.raw || { id: result.runtimeTurnId });
    promise.catch(() => {});
    return promise;
  }

  cancelQueuedTurn(clientUserMessageId) {
    return this.kernel.cancelQueuedTurn(this.sessionId, clientUserMessageId);
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
    await this.#waitForRuntimeRelease();
    if (method === "thread/unsubscribe" && params?.threadId === this.threadId) {
      const binding = await this.kernel.releaseRuntime(this.sessionId, { reason: "unsubscribed" });
      if (binding) {
        this.runtimeSessionId = "";
        return { threadId: params.threadId };
      }
      // No live kernel Runtime — send the raw unsubscribe so the shared
      // App Server does not keep a stale subscription.
      const result = await this.connection.request(method, params);
      this.runtimeSessionId = "";
      return result;
    }
    if (method === "turn/interrupt" && params?.threadId === this.threadId) {
      if (!this.activeTurnId) return {};
      return this.kernel.interrupt(this.sessionId, params.turnId || this.activeTurnId);
    }
    if (method === "thread/fork") return this.connection.request(method, params);
    if (KERNEL_OWNED_METHODS.has(method)) {
      throw new Error(`Platform kernel operation must use the client facade: ${method}`);
    }
    try {
      return await this.kernel.extensionRequest(this.sessionId, method, params);
    } catch (error) {
      // Unknown provider extensions remain a raw passthrough for forward
      // compatibility; known Runtime operations never bypass the kernel.
      if (error?.code !== "RUNTIME_EXTENSION_UNSUPPORTED") throw error;
      return this.connection.request(method, params);
    }
  }

  notify(method, params = {}) {
    this.connection.notify(method, params);
  }

  respond(id, result) {
    if (this.pendingRequestTokens.delete(id)) {
      void this.kernel.respondToRequest(this.sessionId, id, result).catch((error) => {
        this.emit("request-error", error);
      });
      return;
    }
    this.connection.respond(id, result);
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
    this.connection.respondError(id, error);
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
    await this.#waitForRuntimeRelease();
    return this.kernel.extensionRequest(this.sessionId, method, params);
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
    return result;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.kernel.clearQueue?.(this.sessionId, new Error("Codex app-server client closed."));
    this.kernelUnsubscribe?.();
    this.kernelUnsubscribe = null;
    this.#unbindConnectionEvents();
    void this.kernel.detach(this.sessionId).catch(() => {});
  }

  #bindConnectionEvents() {
    if (this.connectionEventsBound) return;
    this.connectionEventsBound = true;
    this.connection.on("notification", this.onConnectionNotification);
    this.connection.on("server-request", this.onConnectionServerRequest);
    this.connection.on("exit", this.onConnectionExit);
  }

  #unbindConnectionEvents() {
    if (!this.connectionEventsBound) return;
    this.connectionEventsBound = false;
    this.connection.off("notification", this.onConnectionNotification);
    this.connection.off("server-request", this.onConnectionServerRequest);
    this.connection.off("exit", this.onConnectionExit);
  }

  #handleConnectionNotification(message) {
    const messageThreadId = appServerMessageThreadId(message);
    if (messageThreadId && messageThreadId !== this.threadId) return;
    this.emit("notification", message);
    // App Server errors are protocol notifications. Node throws an unhandled
    // `error` event, so only emit the named event when a consumer opted in.
    if (message?.method === "error" && this.listenerCount("error") === 0) return;
    if (message?.method) this.emit(message.method, message.params);
  }

  #handleConnectionServerRequest(message) {
    // Kernel-owned requests arrive through `request_opened`; only unscoped
    // provider requests retain the legacy raw facade path.
    if (!appServerMessageThreadId(message)) this.emit("server-request", message);
  }

  #handleConnectionExit(error) {
    if (this.closed) return;
    this.started = false;
    this.closed = true;
    this.kernelUnsubscribe?.();
    this.kernelUnsubscribe = null;
    this.#unbindConnectionEvents();
    this.emit("exit", error);
  }

  #handleKernelEvent(event) {
    if (event?.type === 'runtime_released') {
      this.emit('runtime-released', event.payload);
      return;
    }
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

  async #waitForRuntimeRelease() {
    await this.kernel.waitForRuntimeRelease(this.sessionId);
    if (this.closed) throw new Error('Codex app-server client is closed.');
  }

  #assertThread() {
    this.#assertStarted();
    if (!this.threadId) throw new Error("Codex app-server thread has not started.");
  }
}
