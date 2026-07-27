import { CodexAppServerClient, CodexAppServerConnection } from "./codex-app-server-client.js";
import { remoteAppServerSpawn } from "./agent-hosts.js";

export class AgentHostAppServerPool {
  constructor({
    spawnCwd,
    localCommand = "codex",
    localEnv = process.env,
    spawnImpl,
    requestTimeoutMs,
    clientInfo,
  } = {}) {
    this.spawnCwd = spawnCwd || process.cwd();
    this.localCommand = localCommand;
    this.localEnv = localEnv;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientInfo = clientInfo;
    this.connections = new Map();
  }

  connectionFor(host) {
    const existing = this.connections.get(host.id);
    if (existing && !existing.closed) return existing;

    const spawn = host.type === "ssh"
      ? remoteAppServerSpawn(host)
      : { command: this.localCommand, args: ["app-server"] };
    const connection = new CodexAppServerConnection({
      command: spawn.command,
      args: spawn.args,
      cwd: this.spawnCwd,
      env: host.type === "local" ? this.localEnv : process.env,
      ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}),
      ...(this.requestTimeoutMs ? { requestTimeoutMs: this.requestTimeoutMs } : {}),
      ...(this.clientInfo ? { clientInfo: this.clientInfo } : {}),
    });
    connection.once("exit", () => {
      if (this.connections.get(host.id) === connection) this.connections.delete(host.id);
    });
    this.connections.set(host.id, connection);
    return connection;
  }

  clientFor(host, cwd) {
    return new CodexAppServerClient({
      cwd,
      connection: this.connectionFor(host),
    });
  }

  closeHost(hostId) {
    const connection = this.connections.get(String(hostId || ""));
    if (!connection) return;
    this.connections.delete(String(hostId || ""));
    connection.close();
  }

  close() {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}
