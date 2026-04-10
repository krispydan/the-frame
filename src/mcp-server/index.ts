#!/usr/bin/env node
/**
 * Stdio MCP server bridge for The Frame.
 *
 * Claude Desktop and Claude Code's .mcp.json both need a local subprocess
 * that speaks MCP over stdin/stdout. This script bridges that to The Frame's
 * HTTP MCP endpoint at https://theframe.getjaxy.com/api/mcp.
 *
 * It fetches the tool list on startup, registers each tool with the MCP SDK,
 * and proxies tool calls to the HTTP endpoint with the API key.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.FRAME_MCP_URL || "https://theframe.getjaxy.com/api/mcp";
const API_KEY = process.env.FRAME_API_KEY || "";

if (!API_KEY) {
  console.error("FRAME_API_KEY is required");
  process.exit(1);
}

/** Send a JSON-RPC request to the HTTP MCP endpoint */
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });

  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message || JSON.stringify(json.error));
  }
  return json.result;
}

async function main() {
  // Fetch available tools from the HTTP endpoint
  const listResult = (await rpc("tools/list")) as {
    tools: Array<{
      name: string;
      description: string;
      inputSchema: { type: string; properties?: Record<string, unknown> };
    }>;
  };

  const server = new McpServer({
    name: "the-frame",
    version: "1.0.0",
  });

  // Register each tool as a passthrough to the HTTP endpoint.
  // We use a loose zod schema since the real validation happens server-side.
  for (const tool of listResult.tools) {
    server.tool(
      tool.name,
      tool.description,
      // Accept any object — the HTTP endpoint validates
      z.object({}).passthrough(),
      async (args) => {
        try {
          const result = await rpc("tools/call", {
            name: tool.name,
            arguments: args,
          });

          // The HTTP endpoint returns { content: [...] } or a plain object
          const content = (result as { content?: unknown[] })?.content;
          if (Array.isArray(content)) {
            return { content: content as Array<{ type: "text"; text: string }> };
          }

          // Wrap plain results as text
          return {
            content: [
              {
                type: "text" as const,
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    );
  }

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
