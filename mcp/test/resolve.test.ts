import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  ffmpegToolCandidates,
  repoRoot,
  workerRoot,
  workerPythonPath,
  defaultVenvPython,
  modelCacheDir,
  systemPythonCandidates
} from '../src/resolve.js'

describe('ffmpegToolCandidates', () => {
  it('searches homebrew, /usr/bin, /usr/local/bin in order', () => {
    expect(ffmpegToolCandidates('ffprobe')).toEqual([
      '/opt/homebrew/bin/ffprobe',
      '/usr/bin/ffprobe',
      '/usr/local/bin/ffprobe'
    ])
  })
})

describe('repoRoot', () => {
  it('honors STEMSTUDIO_ROOT when set', () => {
    expect(repoRoot({ STEMSTUDIO_ROOT: '/custom/repo' })).toBe('/custom/repo')
  })
  it('falls back to the package parent (a real absolute path) when unset', () => {
    const r = repoRoot({})
    expect(r.startsWith('/')).toBe(true)
    // resolve() collapses the ../.. so no literal segment remains.
    expect(r).not.toContain('/..')
  })
})

describe('workerRoot', () => {
  it('is <repo>/python', () => {
    expect(workerRoot({ STEMSTUDIO_ROOT: '/r' })).toBe('/r/python')
  })
})

describe('workerPythonPath / defaultVenvPython', () => {
  it('uses STEMSTUDIO_PYTHON when set', () => {
    expect(workerPythonPath({ STEMSTUDIO_PYTHON: '/venv/bin/python' })).toBe(
      '/venv/bin/python'
    )
  })
  it('falls back to <repo>/.venv/bin/python (posix)', () => {
    if (process.platform === 'win32') return
    expect(workerPythonPath({ STEMSTUDIO_ROOT: '/r' })).toBe('/r/.venv/bin/python')
    expect(defaultVenvPython({ STEMSTUDIO_ROOT: '/r' })).toBe('/r/.venv/bin/python')
  })
})

describe('modelCacheDir', () => {
  it('honors STEMSTUDIO_CACHE', () => {
    expect(modelCacheDir({ STEMSTUDIO_CACHE: '/cache' })).toBe('/cache')
  })
  it('falls back to ~/.stemstudio/models', () => {
    expect(modelCacheDir({})).toBe(join(homedir(), '.stemstudio', 'models'))
  })
})

describe('systemPythonCandidates', () => {
  it('puts STEMSTUDIO_PYTHON first, then the standard python3 paths', () => {
    const c = systemPythonCandidates({ STEMSTUDIO_PYTHON: '/p/python3' })
    expect(c[0]).toBe('/p/python3')
    expect(c).toContain('python3')
    expect(c).toContain('/opt/homebrew/bin/python3')
  })
  it('omits an empty override', () => {
    const c = systemPythonCandidates({ STEMSTUDIO_PYTHON: '' })
    expect(c[0]).toBe('python3')
  })
})
