/**
 * stem-studio-mcp bin entry. Connects the MCP server over the stdio transport.
 * No arguments; configuration is via env vars (STEMSTUDIO_ROOT / _PYTHON /
 * _CACHE) — see mcp/README.md.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // The server now runs until stdin closes; keep the process alive.
}

main().catch((err) => {
  // stdout is the JSON-RPC channel — diagnostics go to stderr only.
  process.stderr.write(`stem-studio-mcp fatal: ${(err as Error).stack ?? err}\n`)
  process.exit(1)
})
