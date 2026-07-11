// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
/**
 * stem-studio-mcp bin entry. Connects the MCP server over the stdio transport.
 * No arguments; configuration is via env vars (STEMSTUDIO_ROOT / _PYTHON /
 * _CACHE) — see mcp/README.md.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { terminateAllProcesses } from './process.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()
  let shutdownPromise: Promise<void> | null = null
  const shutdown = (exitAfter: boolean, code = 0): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        await terminateAllProcesses()
        try {
          await server.close()
        } catch {
          // The stdio transport may already have closed itself.
        }
        if (exitAfter) process.exit(code)
      })()
    }
    return shutdownPromise
  }

  transport.onclose = () => { void shutdown(false) }
  process.stdin.once('end', () => { void shutdown(false) })
  process.once('SIGINT', () => { void shutdown(true, 130) })
  process.once('SIGTERM', () => { void shutdown(true, 143) })
  await server.connect(transport)
  // The server now runs until stdin closes; keep the process alive.
}

main().catch(async (err) => {
  // stdout is the JSON-RPC channel — diagnostics go to stderr only.
  process.stderr.write(`stem-studio-mcp fatal: ${(err as Error).stack ?? err}\n`)
  await terminateAllProcesses().catch(() => {})
  process.exit(1)
})
