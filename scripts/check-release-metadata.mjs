import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const app = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const mcp = JSON.parse(await readFile(resolve(root, 'mcp/package.json'), 'utf8'))
const citation = await readFile(resolve(root, 'CITATION.cff'), 'utf8')
const cited = citation.match(/^version:\s*["']?([^"'\s]+)["']?$/m)?.[1]

for (const [surface, version] of [['MCP', mcp.version], ['CITATION.cff', cited]]) {
  if (version !== app.version) {
    throw new Error(`${surface} version ${version ?? '<missing>'} does not match app ${app.version}`)
  }
}
console.log(`Release metadata agrees on ${app.version}.`)
