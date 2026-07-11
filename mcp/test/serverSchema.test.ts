import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { createServer } from '../src/server.js'

interface RegisteredTool {
  inputSchema: ZodType
  description?: string
}

function separationTool(env: NodeJS.ProcessEnv): RegisteredTool {
  const server = createServer(env) as unknown as {
    _registeredTools: Record<string, RegisteredTool>
  }
  const tool = server._registeredTools.separate_stems
  if (!tool) throw new Error('separate_stems was not registered')
  return tool
}

describe('public engine schema', () => {
  const base = { input_path: 'C:\\Media\\scene.mov' }

  it('exposes licensed TIGER only by default', () => {
    const tool = separationTool({})
    expect(tool.inputSchema.safeParse({ ...base, engine: 'tiger' }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ ...base, engine: 'stub' }).success).toBe(false)
    expect(tool.description).not.toMatch(/stub/i)
  })

  it('allows the stub only under the explicit test-harness contract', () => {
    const tool = separationTool({ STEMSTUDIO_ENABLE_TEST_ENGINES: '1' })
    expect(tool.inputSchema.safeParse({ ...base, engine: 'stub' }).success).toBe(true)
  })
})
