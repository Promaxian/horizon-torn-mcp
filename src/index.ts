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

// Map to store SSE transports by session ID
const transports = new Map<string, SSEServerTransport>();

/**
 * POST /sse - Initialize a new SSE connection
 * Client sends initialize request and receives session ID in response headers
 */
app.post("/sse", async (req, res) => {
  try {
    // Set required SSE and MCP headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("X-Accel-Buffering", "no");

    // Create transport and store by session ID
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    // Return session ID in response header
    res.setHeader("mcp-session-id", sessionId);

    // Clean up when connection closes
    res.on("close", () => {
      transports.delete(sessionId);
    });

    // Connect the server to this transport
    await server.connect(transport);
  } catch (error) {
    console.error("SSE POST connection error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Failed to establish SSE connection",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }
});

/**
 * POST /messages - Client sends messages to server
 * Messages include the session ID to route to correct transport
 */
app.post("/messages", async (req, res) => {
  try {
    // Extract session ID from header (preferred) or query parameter
    const sessionId = req.get("mcp-session-id") || (req.query.sessionId as string);

    if (!sessionId) {
      res.status(400).json({ error: "Missing session ID" });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "Unknown or expired session ID" });
      return;
    }

    // Forward message to transport
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

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", name: "horizon-torn-mcp", version: "0.1.0" });
});

// Root endpoint - simple status page
app.get("/", (req, res) => {
  res.json({
    name: "horizon-torn-mcp",
    version: "0.1.0",
    description: "MCP server exposing Torn City API v2 endpoints as tools",
    endpoints: {
      health: "GET /health",
      sse: "POST /sse (initialize connection)",
      messages: "POST /messages (send messages)"
    }
  });
});

// CORS preflight
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  res.sendStatus(204);
});

// Start server
const port = parseInt(process.env.PORT || "3000", 10);
app.listen(port, "0.0.0.0", () => {
  console.error(`MCP server running on port ${port}`);
  console.error(`POST http://localhost:${port}/sse to initialize`);
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
