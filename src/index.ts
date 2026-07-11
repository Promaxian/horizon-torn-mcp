import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

import { getConfig } from "./config.js";
import { TornApiError, TornRequestError } from "./torn/errors.js";
import { TornClient } from "./torn/client.js";
import { TOOL_DEFINITIONS } from "./torn/tools/generated.js";

const config = getConfig();
const client = new TornClient({
  apiKey: config.apiKey,
  baseUrl: config.baseUrl,
  timeoutMs: config.timeoutMs
});

const server = new McpServer({
  name: "horizon-torn-mcp",
  version: "0.1.0"
});

for (const definition of TOOL_DEFINITIONS) {
  const inputSchema = buildInputSchema(definition.params);
  const toolName = definition.name.startsWith("torn_")
    ? definition.name.replace(/^torn_/, "horizon_torn_")
    : definition.name;

  server.tool(toolName, definition.description, inputSchema, async (args) => {
    try {
      const result = await client.request({
        method: definition.method,
        pathTemplate: definition.path,
        params: definition.params,
        args: args as Record<string, unknown>
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: formatError(error)
          }
        ],
        isError: true
      };
    }
  });
}

const app = express();
app.use(express.json());

const transports = new Map<string, SSEServerTransport>();

// SSE endpoint - GET establishes streaming connection
app.get("/sse", async (req, res) => {
  try {
    // Set required SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Accel-Buffering", "no");

    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);

    // Add session ID header for client to use in subsequent POST requests
    res.setHeader("mcp-session-id", transport.sessionId);

    res.on("close", () => {
      transports.delete(transport.sessionId);
    });

    await server.connect(transport);
  } catch (error) {
    console.error("SSE connection error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Failed to establish SSE connection",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }
});

// Messages endpoint - POST receives client messages
app.post("/messages", async (req, res) => {
  try {
    // Extract session ID from header or query parameter
    const sessionId = (req.get("mcp-session-id") || (req.query.sessionId as string)) as string;

    if (!sessionId) {
      res.status(400).json({ error: "Missing session ID" });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "Unknown or expired session ID" });
      return;
    }

    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Message handler error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Failed to handle message",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }
});

const port = parseInt(process.env.PORT || "3000", 10);
app.listen(port, "0.0.0.0", () => {
  console.error(`MCP network server running on port ${port}`);
});

function buildInputSchema(
  params: Array<{ name: string; required: boolean; description?: string }>
): Record<string, z.ZodTypeAny> {
  const schema: Record<string, z.ZodTypeAny> = {};

  for (const param of params) {
    let field = z.string();
    if (param.description) {
      field = field.describe(param.description);
    }

    schema[param.name] = param.required ? field.min(1) : field.optional();
  }

  return schema;
}

function formatError(error: unknown): string {
  if (error instanceof TornApiError) {
    return JSON.stringify(
      {
        type: error.name,
        message: error.message,
        status: error.status,
        endpoint: error.endpoint,
        details: error.details
      },
      null,
      2
    );
  }

  if (error instanceof TornRequestError) {
    return JSON.stringify(
      {
        type: error.name,
        message: error.message,
        endpoint: error.endpoint,
        details: error.causeValue
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      type: "UnknownError",
      message: error instanceof Error ? error.message : "Unknown error"
    },
    null,
    2
  );
}
