import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const noticePath = resolve(root, 'THIRD_PARTY_NOTICES.md')
const start = '<!-- BEGIN GENERATED JAVASCRIPT RUNTIME PACKAGES -->'
const end = '<!-- END GENERATED JAVASCRIPT RUNTIME PACKAGES -->'
const appRuntimeNames = new Set(['react', 'react-dom', 'scheduler', 'zustand'])

function packageName(path) {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

function license(metadata) {
  return typeof metadata.license === 'string' ? metadata.license : 'NOASSERTION'
}

const rootLock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'))
const mcpLock = JSON.parse(await readFile(resolve(root, 'mcp/package-lock.json'), 'utf8'))
const entries = new Map()

for (const [path, metadata] of Object.entries(rootLock.packages)) {
  if (!path) continue
  const name = packageName(path)
  if (appRuntimeNames.has(name)) {
    entries.set(`${name}@${metadata.version}`, { name, ...metadata, scope: 'app' })
  }
}
for (const [path, metadata] of Object.entries(mcpLock.packages)) {
  if (!path || metadata.dev === true) continue
  const name = packageName(path)
  entries.set(`${name}@${metadata.version}`, { name, ...metadata, scope: 'MCP' })
}

const rows = [...entries.values()]
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  .map((entry) => `| ${entry.name} | ${entry.version} | ${license(entry)} | ${entry.scope} |`)
const generated = [
  start,
  '| Package | Version | License | Bundled in |',
  '|---|---:|---|---|',
  ...rows,
  end
].join('\n')

const current = await readFile(noticePath, 'utf8')
const pattern = new RegExp(`${start}[\\s\\S]*?${end}`)
const updated = current.replace(pattern, generated)
if (updated === current && !current.includes('| Package | Version |')) {
  throw new Error('Generated notice markers are missing or invalid.')
}
if (process.argv.includes('--check')) {
  if (updated !== current) throw new Error('THIRD_PARTY_NOTICES.md is stale; run notices:generate.')
  console.log(`Third-party notices are current (${rows.length} JavaScript packages).`)
} else {
  await writeFile(noticePath, updated)
  console.log(`Generated notices for ${rows.length} JavaScript runtime packages.`)
}
