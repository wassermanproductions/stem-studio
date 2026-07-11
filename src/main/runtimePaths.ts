import { isAbsolute, join, relative, resolve } from 'path'

/** Pure path contract for the app-managed runtime eligible for repair. */
export function privateRuntimeRoot(
  userData: string,
  platform: NodeJS.Platform
): string {
  return platform === 'win32'
    ? join(userData, 'runtime', 'v1')
    : join(userData, 'venv')
}

/** Reject any repair target that escapes the app's own user-data directory. */
export function assertScopedRuntimePath(userData: string, target: string): void {
  const rel = relative(resolve(userData), resolve(target))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Refusing to repair a runtime outside app user data.')
  }
}
