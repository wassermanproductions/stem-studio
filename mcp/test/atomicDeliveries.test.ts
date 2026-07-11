import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { promoteStagedDeliveries, stagedDeliveryPath } from '../src/atomicDeliveries.js'

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('MCP delivery promotion', () => {
  it('rolls back an existing output when promotion is cancelled', async () => {
    root = await mkdtemp(join(tmpdir(), 'stem-mcp-delivery-'))
    const finalPath = join(root, 'mix_DIALOGUE.wav')
    const stagedPath = stagedDeliveryPath(finalPath, 'cancelled-job')
    await writeFile(finalPath, 'previous')
    await writeFile(stagedPath, 'candidate')
    await expect(promoteStagedDeliveries(
      [{ finalPath, stagedPath }],
      'cancelled-job',
      () => { throw new Error('Cancelled') }
    )).rejects.toThrow('Cancelled')
    expect(await readFile(finalPath, 'utf8')).toBe('previous')
  })

  it('keeps staging components short for Windows long-path outputs', () => {
    const finalPath = join('C:\\', 'OneDrive - Studio', `${'界'.repeat(100)}.mov`)
    const stagedPath = stagedDeliveryPath(finalPath, '00000000-0000-4000-8000-000000000000')
    expect(basename(stagedPath)).toMatch(/^\.stemstudio-[0-9a-f]{20}\.partial\.mov$/)
    expect(basename(stagedPath).length).toBeLessThan(64)
  })
})
