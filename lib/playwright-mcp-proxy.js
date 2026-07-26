import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  cleanMcpErrorMessage,
  createSharedMcpHttpProxy,
  SharedOnDemandMcpBackend,
} from "./shared-mcp-provider.js";

const require = createRequire(import.meta.url);
const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const DEFAULT_OUTPUT_MAX_SIZE = "52428800";
const DEFAULT_OUTPUT_DIR = "/home/ubuntu/.cache/codex-browser/playwright-output";
const DEFAULT_BROWSER_CONTROL =
  "/home/ubuntu/workspace/server-config/scripts/browser-handoffctl.sh";
const PLAYWRIGHT_PROVIDER_ROOT = path.dirname(
  require.resolve("@playwright/mcp/package.json"),
);
const PLAYWRIGHT_PROVIDER_ENTRY = path.join(PLAYWRIGHT_PROVIDER_ROOT, "cli.js");
const PLAYWRIGHT_TOOL_MANIFEST = fileURLToPath(
  new URL("../config/playwright-mcp-tools.json", import.meta.url),
);

export const PLAYWRIGHT_MCP_TOOLS = Object.freeze(
  JSON.parse(readFileSync(PLAYWRIGHT_TOOL_MANIFEST, "utf8")),
);

const PLAYWRIGHT_MCP_INSTRUCTIONS = [
  "Use this shared browser for read-only navigation, searching, reading, scrolling, inspection, and screenshots by default.",
  "Get explicit user confirmation immediately before publishing, commenting, liking, following, saving, sending, uploading, editing, deleting, purchasing, changing account settings, or any other consequential write.",
  "Only ask the user to enter passwords, one-time codes, or CAPTCHAs through the private Browser Hand-off page; never print cookies, tokens, or stored credentials.",
  "Calls from Agent sessions share one browser and are serialized.",
].join(" ");

export function createPlaywrightMcpProxy({
  idleMs = process.env.AGENT_PLAYWRIGHT_IDLE_MS || DEFAULT_IDLE_MS,
  logger = () => {},
  createConnection,
  ensureBrowser = () =>
    ensureBrowserHandoff({
      controlPath: process.env.BROWSER_HANDOFF_CONTROL || DEFAULT_BROWSER_CONTROL,
    }),
  cdpEndpoint = process.env.BROWSER_HANDOFF_CDP_ENDPOINT || DEFAULT_CDP_ENDPOINT,
  outputDir =
    process.env.PLAYWRIGHT_MCP_OUTPUT_DIR ||
    DEFAULT_OUTPUT_DIR,
} = {}) {
  const backend = new SharedOnDemandMcpBackend({
    providerId: "playwright",
    idleMs,
    logger,
    serializeCalls: true,
    createConnection:
      createConnection ||
      (() =>
        createPlaywrightProviderConnection({
          ensureBrowser,
          cdpEndpoint,
          outputDir,
          logger,
        })),
  });

  return createSharedMcpHttpProxy({
    providerId: "playwright",
    serverName: "agent-web-playwright-proxy",
    instructions: PLAYWRIGHT_MCP_INSTRUCTIONS,
    tools: PLAYWRIGHT_MCP_TOOLS,
    backend,
    logger,
    unknownToolMessage: (name) => `未知的 Playwright 工具：${name || "（空）"}`,
    unavailableMessage:
      "共享浏览器暂时不可用，请稍后重试；如需人工接管，可打开 Browser Hand-off。",
  });
}

export async function createPlaywrightProviderConnection({
  ensureBrowser,
  cdpEndpoint = DEFAULT_CDP_ENDPOINT,
  outputDir = DEFAULT_OUTPUT_DIR,
  logger = () => {},
} = {}) {
  if (typeof ensureBrowser !== "function") {
    throw new TypeError("ensureBrowser must be a function.");
  }
  await ensureBrowser();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      PLAYWRIGHT_PROVIDER_ENTRY,
      "--cdp-endpoint",
      cdpEndpoint,
      "--output-dir",
      outputDir,
      "--output-max-size",
      DEFAULT_OUTPUT_MAX_SIZE,
      "--codegen",
      "none",
    ],
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});

  const client = new Client({
    name: "agent-web-playwright-client",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    return {
      client,
      pid: transport.pid,
    };
  } catch (error) {
    await transport.close().catch(() => {});
    logger("playwright-provider-start-failed", {
      message: cleanMcpErrorMessage(error),
    });
    throw error;
  }
}

export function ensureBrowserHandoff({
  controlPath = DEFAULT_BROWSER_CONTROL,
  execFileImpl = execFile,
  timeoutMs = 30_000,
} = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      controlPath,
      ["start"],
      {
        timeout: timeoutMs,
        maxBuffer: 256 * 1024,
      },
      (error) => {
        if (error) {
          reject(new Error(`Browser Hand-off failed to start: ${cleanMcpErrorMessage(error)}`));
          return;
        }
        resolve();
      },
    );
  });
}
