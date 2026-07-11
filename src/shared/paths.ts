/** Return the final component of either a POSIX or Windows/UNC path. */
export function displayBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Encode an absolute path without interpreting drive letters or UNC prefixes. */
export function stemPreviewUrl(path: string): string {
  return `stem://media?path=${encodeURIComponent(path)}`
}
