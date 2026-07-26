import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  integrationMcpLaunch,
  readIntegrationCredential,
} from "./integrations.js";

const DEFAULT_IDLE_MS = 60_000;
const AMAP_INTEGRATION_ID = "amap";
const AMAP_PROVIDER_ENTRY = fileURLToPath(
  new URL("../node_modules/@amap/amap-maps-mcp-server/build/index.js", import.meta.url),
);

export const AMAP_MCP_TOOLS = [
  {
    name: "maps_regeocode",
    description: "将一个高德经纬度坐标转换为行政区划地址信息",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "经纬度" },
      },
      required: ["location"],
    },
  },
  {
    name: "maps_geo",
    description: "将详细的结构化地址转换为经纬度坐标。支持对地标性名胜景区、建筑物名称解析为经纬度坐标",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "待解析的结构化地址信息" },
        city: { type: "string", description: "指定查询的城市" },
      },
      required: ["address"],
    },
  },
  {
    name: "maps_ip_location",
    description: "IP 定位根据用户输入的 IP 地址，定位 IP 的所在位置",
    inputSchema: {
      type: "object",
      properties: {
        ip: { type: "string", description: "IP地址" },
      },
      required: ["ip"],
    },
  },
  {
    name: "maps_weather",
    description: "根据城市名称或者标准adcode查询指定城市的天气",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名称或者adcode" },
      },
      required: ["city"],
    },
  },
  {
    name: "maps_search_detail",
    description: "查询关键词搜或者周边搜获取到的POI ID的详细信息",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "关键词搜或者周边搜获取到的POI ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "maps_bicycling",
    description: "骑行路径规划用于规划骑行通勤方案，规划时会考虑天桥、单行线、封路等情况。最大支持 500km 的骑行路线规划",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出发点经纬度，坐标格式为：经度，纬度" },
        destination: { type: "string", description: "目的地经纬度，坐标格式为：经度，纬度" },
      },
      required: ["origin", "destination"],
    },
  },
  {
    name: "maps_direction_walking",
    description: "步行路径规划 API 可以根据输入起点终点经纬度坐标规划100km 以内的步行通勤方案，并且返回通勤方案的数据",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出发点经度，纬度，坐标格式为：经度，纬度" },
        destination: { type: "string", description: "目的地经度，纬度，坐标格式为：经度，纬度" },
      },
      required: ["origin", "destination"],
    },
  },
  {
    name: "maps_direction_driving",
    description: "驾车路径规划 API 可以根据用户起终点经纬度坐标规划以小客车、轿车通勤出行的方案，并且返回通勤方案的数据。",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出发点经度，纬度，坐标格式为：经度，纬度" },
        destination: { type: "string", description: "目的地经度，纬度，坐标格式为：经度，纬度" },
      },
      required: ["origin", "destination"],
    },
  },
  {
    name: "maps_direction_transit_integrated",
    description: "公交路径规划 API 可以根据用户起终点经纬度坐标规划综合各类公共（火车、公交、地铁）交通方式的通勤方案，并且返回通勤方案的数据，跨城场景下必须传起点城市与终点城市",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "出发点经度，纬度，坐标格式为：经度，纬度" },
        destination: { type: "string", description: "目的地经度，纬度，坐标格式为：经度，纬度" },
        city: { type: "string", description: "公共交通规划起点城市" },
        cityd: { type: "string", description: "公共交通规划终点城市" },
      },
      required: ["origin", "destination", "city", "cityd"],
    },
  },
  {
    name: "maps_distance",
    description: "距离测量 API 可以测量两个经纬度坐标之间的距离,支持驾车、步行以及球面距离测量",
    inputSchema: {
      type: "object",
      properties: {
        origins: {
          type: "string",
          description: "起点经度，纬度，可以传多个坐标，使用竖线隔离，比如120,30|120,31，坐标格式为：经度，纬度",
        },
        destination: { type: "string", description: "终点经度，纬度，坐标格式为：经度，纬度" },
        type: { type: "string", description: "距离测量类型,1代表驾车距离测量，0代表直线距离测量，3步行距离测量" },
      },
      required: ["origins", "destination"],
    },
  },
  {
    name: "maps_text_search",
    description: "关键词搜，根据用户传入关键词，搜索出相关的POI",
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "string", description: "搜索关键词" },
        city: { type: "string", description: "查询城市" },
        types: { type: "string", description: "POI类型，比如加油站" },
      },
      required: ["keywords"],
    },
  },
  {
    name: "maps_around_search",
    description: "周边搜，根据用户传入关键词以及坐标location，搜索出radius半径范围的POI",
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "string", description: "搜索关键词" },
        location: { type: "string", description: "中心点经度纬度" },
        radius: { type: "string", description: "搜索半径" },
      },
      required: ["location"],
    },
  },
];

const AMAP_TOOL_NAMES = new Set(AMAP_MCP_TOOLS.map((tool) => tool.name));

export class SharedOnDemandMcpBackend {
  constructor({
    createConnection,
    idleMs = DEFAULT_IDLE_MS,
    logger = () => {},
  }) {
    this.createConnection = createConnection;
    this.idleMs = Math.max(1, Number(idleMs) || DEFAULT_IDLE_MS);
    this.logger = logger;
    this.connection = null;
    this.starting = null;
    this.closing = null;
    this.activeCalls = 0;
    this.idleTimer = null;
  }

  status() {
    return {
      activeCalls: this.activeCalls,
      idleMs: this.idleMs,
      providerPid: this.connection?.pid || null,
      state: this.closing
        ? "stopping"
        : this.connection
          ? "running"
          : this.starting
            ? "starting"
            : "stopped",
    };
  }

  async callTool(params) {
    this.cancelIdleStop();
    this.activeCalls += 1;
    try {
      const connection = await this.getConnection();
      try {
        const result = await connection.client.callTool(params);
        return connection.redact ? connection.redact(result) : result;
      } catch (error) {
        if (!connection.redact) throw error;
        throw new Error(connection.redact(String(error?.message || error)));
      }
    } finally {
      this.activeCalls -= 1;
      this.scheduleIdleStop();
    }
  }

  async getConnection() {
    if (this.closing) await this.closing;
    if (this.connection) return this.connection;
    if (this.starting) return this.starting;

    const starting = this.createConnection();
    this.starting = starting;
    try {
      const connection = await starting;
      this.connection = connection;
      this.logger("amap-provider-started", { pid: connection.pid || null });
      return connection;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  scheduleIdleStop() {
    if (this.activeCalls || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.close("idle").catch((error) => {
        this.logger("amap-provider-stop-failed", { message: cleanErrorMessage(error) });
      });
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  cancelIdleStop() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async close(reason = "manual") {
    this.cancelIdleStop();
    if (this.closing) return this.closing;

    const closing = (async () => {
      let connection = this.connection;
      if (!connection && this.starting) {
        try {
          connection = await this.starting;
        } catch {
          return;
        }
      }
      this.connection = null;
      if (!connection) return;
      await connection.client.close();
      this.logger("amap-provider-stopped", {
        pid: connection.pid || null,
        reason,
      });
    })();
    this.closing = closing;
    try {
      await closing;
    } finally {
      if (this.closing === closing) this.closing = null;
    }
  }
}

export function createAmapMcpProxy({
  integrationRoot,
  idleMs = process.env.AGENT_AMAP_IDLE_MS || DEFAULT_IDLE_MS,
  logger = () => {},
  createConnection,
} = {}) {
  const backend = new SharedOnDemandMcpBackend({
    idleMs,
    logger,
    createConnection:
      createConnection ||
      (() => createAmapProviderConnection({ integrationRoot, logger })),
  });

  return {
    backend,
    async handlePost(req, res) {
      const mcpServer = createAmapMcpServer({ backend, logger });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger("amap-mcp-request-failed", { message: cleanErrorMessage(error) });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      } finally {
        await mcpServer.close().catch(() => {});
      }
    },
    handleUnsupported(_req, res) {
      res.set("Allow", "POST");
      res.status(405).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      });
    },
  };
}

function createAmapMcpServer({ backend, logger }) {
  const mcpServer = new Server(
    {
      name: "agent-web-amap-proxy",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: AMAP_MCP_TOOLS,
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = String(request.params.name || "");
    if (!AMAP_TOOL_NAMES.has(name)) {
      return toolError(`未知的高德地图工具：${name || "（空）"}`);
    }

    try {
      return await backend.callTool({
        name,
        arguments: request.params.arguments || {},
      });
    } catch (error) {
      logger("amap-tool-call-failed", {
        name,
        message: cleanErrorMessage(error),
      });
      return toolError("高德地图暂时不可用，请稍后重试或检查 Agent 的集成设置。");
    }
  });

  return mcpServer;
}

async function createAmapProviderConnection({ integrationRoot, logger }) {
  const [credential, launch] = await Promise.all([
    readIntegrationCredential(AMAP_INTEGRATION_ID, { root: integrationRoot }),
    Promise.resolve(integrationMcpLaunch(AMAP_INTEGRATION_ID)),
  ]);
  if (!credential) {
    throw new Error("Amap integration is not configured.");
  }

  const env = {};
  for (const [environmentName, fieldId] of Object.entries(launch.env)) {
    const value = credential[fieldId];
    if (!value) throw new Error("Amap integration credential is incomplete.");
    env[environmentName] = value;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [AMAP_PROVIDER_ENTRY],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});

  const client = new Client({
    name: "agent-web-amap-client",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    return {
      client,
      pid: transport.pid,
      redact: (value) => redactProviderValue(value, Object.values(credential)),
    };
  } catch (error) {
    await transport.close().catch(() => {});
    logger("amap-provider-start-failed", { message: cleanErrorMessage(error) });
    throw error;
  }
}

function toolError(text) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError: true,
  };
}

function redactProviderValue(value, secrets) {
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of secrets) {
      if (secret) redacted = redacted.split(secret).join("[redacted]");
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactProviderValue(item, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactProviderValue(item, secrets),
      ]),
    );
  }
  return value;
}

function cleanErrorMessage(error) {
  return String(error?.message || "Unknown error")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 300);
}
