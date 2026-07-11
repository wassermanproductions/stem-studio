import { describe, expect, it } from 'vitest'
import { assertScopedRuntimePath, privateRuntimeRoot } from '../../src/main/runtimePaths'

describe('private runtime repair scope', () => {
  it('targets only the versioned Windows runtime below app user data', () => {
    const target = privateRuntimeRoot('C:\\Users\\Editor\\AppData\\Roaming\\stem-studio', 'win32')
    expect(target).toContain('stem-studio')
    expect(target).toContain('runtime')
    expect(target).toContain('v1')
  })

  it('accepts its managed target and rejects the user-data root or an escape', () => {
    const userData = '/Users/editor/Library/Application Support/stem-studio'
    expect(() => assertScopedRuntimePath(userData, privateRuntimeRoot(userData, 'darwin'))).not.toThrow()
    expect(() => assertScopedRuntimePath(userData, userData)).toThrow(/outside app user data/)
    expect(() => assertScopedRuntimePath(userData, '/Users/editor')).toThrow(/outside app user data/)
  })
})
