import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  promoteStagedDeliveries,
  stagedDeliveryPath,
  type StagedDelivery
} from '../../src/shared/atomicDeliveries'

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('atomic delivery promotion', () => {
  it('replaces a complete staged set only after every file is ready', async () => {
    root = await mkdtemp(join(tmpdir(), 'stem-delivery-'))
    const finalPath = join(root, 'mix_DIALOGUE.wav')
    const stagedPath = stagedDeliveryPath(finalPath, 'job-1')
    await writeFile(finalPath, 'old')
    await writeFile(stagedPath, 'new')
    await promoteStagedDeliveries([{ finalPath, stagedPath }], 'job-1')
    expect(await readFile(finalPath, 'utf8')).toBe('new')
  })

  it('restores prior deliverables when a later promotion fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'stem-delivery-'))
    const one = join(root, 'mix_DIALOGUE.wav')
    const two = join(root, 'mix_MUSIC.wav')
    const deliveries: StagedDelivery[] = [one, two].map((finalPath, index) => ({
      finalPath,
      stagedPath: stagedDeliveryPath(finalPath, `job-${index}`)
    }))
    await writeFile(one, 'old-one')
    await writeFile(two, 'old-two')
    await writeFile(deliveries[0]!.stagedPath, 'new-one')
    await expect(promoteStagedDeliveries(deliveries, 'failed-job')).rejects.toThrow()
    expect(await readFile(one, 'utf8')).toBe('old-one')
    expect(await readFile(two, 'utf8')).toBe('old-two')
  })

  it('uses compact sibling names even for long destination components', async () => {
    root = await mkdtemp(join(tmpdir(), 'stem-delivery-'))
    const finalPath = join(root, `${'a'.repeat(220)}.wav`)
    const stagedPath = stagedDeliveryPath(finalPath, '00000000-0000-4000-8000-000000000000')
    expect(basename(stagedPath)).toMatch(/^\.stemstudio-[0-9a-f]{20}\.partial\.wav$/)
    expect(basename(stagedPath).length).toBeLessThan(64)
  })
})
