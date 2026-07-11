import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import { createServer } from '../src/server.js'

interface RegisteredTool {
  inputSchema: ZodType
  description?: string
}

function separationTool(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = 'win32'
): RegisteredTool {
  const server = createServer(env, platform) as unknown as {
    _registeredTools: Record<string, RegisteredTool>
  }
  const tool = server._registeredTools.separate_stems
  if (!tool) throw new Error('separate_stems was not registered')
  return tool
}

describe('public engine schema', () => {
  const base = { input_path: 'C:\\Media\\scene.mov' }

  it('exposes licensed TIGER and Fast/High only in public Windows builds', () => {
    const tool = separationTool({})
    expect(tool.inputSchema.safeParse({ ...base, engine: 'tiger' }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ ...base, engine: 'mvsep' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ ...base, engine: 'stub' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ ...base, quality: 'max' }).success).toBe(false)
    expect(tool.description).not.toMatch(/stub/i)
  })

  it('allows the stub only under the explicit test-harness contract', () => {
    const tool = separationTool({ STEMSTUDIO_ENABLE_TEST_ENGINES: '1' })
    expect(tool.inputSchema.safeParse({ ...base, engine: 'stub' }).success).toBe(true)
  })

  it('retains the existing MVSEP/Max contract on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const tool = separationTool({}, platform)
      expect(tool.inputSchema.safeParse({ ...base, engine: 'mvsep' }).success).toBe(true)
      expect(tool.inputSchema.safeParse({ ...base, engine: 'stub' }).success).toBe(true)
      expect(tool.inputSchema.safeParse({ ...base, quality: 'max' }).success).toBe(true)
    }
  })
})
