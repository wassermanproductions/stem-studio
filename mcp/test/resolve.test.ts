// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
import { describe, it, expect } from 'vitest'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  ffmpegToolCandidates,
  repoRoot,
  workerRoot,
  workerPythonPath,
  defaultVenvPython,
  modelCacheDir,
  systemPythonCandidates,
  resourcesRoot,
  distributionUserDataFolder,
  windowsRequirementsPath
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

describe('distributionUserDataFolder', () => {
  it('uses the neutral generic fallback', () => {
    expect(distributionUserDataFolder({}, null)).toBe('stem-studio')
  })

  it('honors an explicit launcher contract', () => {
    expect(
      distributionUserDataFolder({ STEMSTUDIO_USER_DATA_FOLDER: 'stem-studio-partner' }, null)
    ).toBe('stem-studio-partner')
  })

  it('rejects separators and traversal', () => {
    expect(() =>
      distributionUserDataFolder({ STEMSTUDIO_USER_DATA_FOLDER: '../escape' }, null)
    ).toThrow('Invalid STEMSTUDIO_USER_DATA_FOLDER')
  })
})

describe('repoRoot', () => {
  it('honors STEMSTUDIO_ROOT when set', () => {
    expect(repoRoot({ STEMSTUDIO_ROOT: '/custom/repo' })).toBe(resolve('/custom/repo'))
  })
  it('falls back to the package parent (a real absolute path) when unset', () => {
    const r = repoRoot({})
    expect(isAbsolute(r)).toBe(true)
    // resolve() collapses the ../.. so no literal segment remains.
    expect(r.split(/[\\/]/)).not.toContain('..')
  })
})

describe('workerRoot', () => {
  it('is <repo>/python', () => {
    expect(workerRoot({ STEMSTUDIO_ROOT: '/r' })).toBe(join(resolve('/r'), 'python'))
  })

  it('shares the installed app resources when provided', () => {
    const env = { STEMSTUDIO_RESOURCES: '/app/resources' }
    const resources = resolve('/app/resources')
    expect(resourcesRoot(env)).toBe(resources)
    expect(workerRoot(env)).toBe(join(resources, 'python'))
    expect(windowsRequirementsPath('cpu', env)).toBe(
      join(resources, 'python', 'requirements-windows-cpu.lock')
    )
  })
})

describe('workerPythonPath / defaultVenvPython', () => {
  it('uses STEMSTUDIO_PYTHON when set', () => {
    expect(workerPythonPath({ STEMSTUDIO_PYTHON: '/venv/bin/python' })).toBe(
      resolve('/venv/bin/python')
    )
  })
  it('falls back to <repo>/.venv/bin/python (posix)', () => {
    if (process.platform === 'win32') return
    expect(workerPythonPath({ STEMSTUDIO_ROOT: '/r' })).toBe('/r/.venv/bin/python')
    expect(defaultVenvPython({ STEMSTUDIO_ROOT: '/r' })).toBe('/r/.venv/bin/python')
  })

  it('shares the packaged Electron venv outside Windows', () => {
    if (process.platform === 'win32') return
    const env = { STEMSTUDIO_RESOURCES: '/app/resources' }
    const expectedRoot = process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'stem-studio')
      : join(homedir(), '.config', 'stem-studio')
    expect(defaultVenvPython(env)).toBe(join(expectedRoot, 'venv', 'bin', 'python'))
    expect(modelCacheDir(env)).toBe(join(expectedRoot, 'models'))
  })
})

describe('modelCacheDir', () => {
  it('honors STEMSTUDIO_CACHE', () => {
    expect(modelCacheDir({ STEMSTUDIO_CACHE: '/cache' })).toBe(resolve('/cache'))
  })
  it('falls back to the platform source-data root', () => {
    const expectedRoot = process.platform === 'win32'
      ? join(homedir(), 'AppData', 'Roaming', 'stem-studio')
      : join(homedir(), '.stemstudio')
    expect(modelCacheDir({})).toBe(join(expectedRoot, 'models'))
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
