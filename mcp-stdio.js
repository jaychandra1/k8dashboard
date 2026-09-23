#!/usr/bin/env node
// ============================================================
// Stdio MCP entry point — for agents that launch an MCP server by command
// (Claude Desktop, Cursor, …). It serves the same tools as the HTTP /mcp
// endpoint by talking to the running app's REST API.
//
// The app (npm start) must be running so this bridge has an API to call. Point
// it at a non-default address with MCP_API_BASE. Every API call is sent with
// `Authorization: Bearer <token>` (MCP_API_TOKEN, else KUBEPILOT_TOKEN, else
// ~/.config/kubepilot/token) and `X-KubePilot-Source: mcp`.
//
// MCP_ALLOW_WRITE=1 only decides which tools this bridge *offers* by default —
// the app's server is the authority and refuses MCP-sourced mutations unless
// writes are enabled there.
//
//   Example Claude Desktop config:
//   {
//     "mcpServers": {
//       "kubepilot": {
//         "command": "node",
//         "args": ["/absolute/path/to/kubepilot/mcp-stdio.js"],
//         "env": { "MCP_API_BASE": "http://127.0.0.1:3001", "MCP_ALLOW_WRITE": "0" }
//       }
//     }
//   }
// ============================================================
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, readApiToken } from './mcp.js';

const token = String(process.env.MCP_API_TOKEN || '').trim() || readApiToken();
if (!token) console.error('[KubePilot MCP] no API token found (set MCP_API_TOKEN / KUBEPILOT_TOKEN or start the app once to create ~/.config/kubepilot/token)');

const server = createMcpServer({
  apiBase: process.env.MCP_API_BASE || undefined,
  token,
  // allowWrite left undefined → createMcpServer reads MCP_ALLOW_WRITE for the default.
});
const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is safe for logs (stdout is the JSON-RPC channel).
console.error('[KubePilot MCP] stdio server ready');
