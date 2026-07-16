import { EventEmitter } from "node:events";
import { spawn as spawnProcess } from "node:child_process";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class CodexAppServerClient extends EventEmitter {
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
    this.pendingTurns = [];
    this.completedTurnIds = new Set();
    this.queueDraining = false;
    this.threadId = "";
    this.activeTurnId = "";
    this.started = false;
    this.closed = false;
  }

  async start() {
    if (this.started) return;
    if (this.closed) throw new Error("Codex app-server client is closed.");

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

    await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
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
    this.#assertStarted();
    const result = await this.request("thread/resume", { ...params, threadId });
    this.threadId = result?.thread?.id || threadId;
    this.activeTurnId = "";
    this.completedTurnIds.clear();
    return result.thread;
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
    this.#handleExit(new Error("Codex app-server client closed."));
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

    if (message.id !== undefined) {
      this.emit("server-request", message);
    } else {
      this.emit("notification", message);
      this.emit(message.method, message.params);
    }
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

  #handleExit(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    while (this.pendingTurns.length) this.pendingTurns.shift().reject(error);
    if (!this.closed) this.emit("exit", error);
  }

  #assertStarted() {
    if (!this.started) throw new Error("Codex app-server client has not initialized.");
  }

  #assertThread() {
    this.#assertStarted();
    if (!this.threadId) throw new Error("Codex app-server thread has not started.");
  }
}

function normalizeUserInput(input) {
  if (Array.isArray(input)) return input;
  const text = String(input || "").trim();
  if (!text) throw new Error("Codex user input cannot be empty.");
  return [{ type: "text", text }];
}
