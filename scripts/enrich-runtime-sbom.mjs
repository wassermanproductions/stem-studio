/** Add non-npm runtime, model, and managed-Python components to release SBOMs. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const release = resolve(root, 'release')
const assets = JSON.parse(await readFile(resolve(root, 'assets-manifest.json'), 'utf8'))
const mcpLock = JSON.parse(await readFile(resolve(root, 'mcp/package-lock.json'), 'utf8'))

function npmNameFromLockPath(path) {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

function integrityHash(integrity) {
  if (!integrity?.startsWith('sha512-')) return undefined
  return [{ alg: 'SHA-512', content: Buffer.from(integrity.slice(7), 'base64').toString('hex') }]
}

const mcpComponents = [
  {
    type: 'application',
    name: mcpLock.name,
    version: mcpLock.version,
    purl: `pkg:npm/${mcpLock.name}@${mcpLock.version}`,
    license: 'Apache-2.0',
    properties: [{ name: 'stemstudio:bundled-path', value: 'resources/mcp/index.js' }]
  },
  ...Object.entries(mcpLock.packages)
    .filter(([path, metadata]) => path && metadata.dev !== true)
    .map(([path, metadata]) => {
      const name = npmNameFromLockPath(path)
      return {
        type: 'library',
        name,
        version: metadata.version,
        purl: `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${metadata.version}`,
        license: typeof metadata.license === 'string' ? metadata.license : 'NOASSERTION',
        hashes: integrityHash(metadata.integrity),
        properties: [{ name: 'stemstudio:component-scope', value: 'bundled-mcp-production' }]
      }
    })
]

const runtimeComponents = new Map()
for (const profile of ['cpu', 'cuda']) {
  const lock = await readFile(resolve(root, `python/requirements-windows-${profile}.lock`), 'utf8')
  for (const match of lock.matchAll(/^([A-Za-z0-9_.-]+)==([^\s\\]+)(?:\s*\\)?$/gm)) {
    const name = match[1].toLowerCase().replaceAll('_', '-')
    const version = match[2]
    const key = `pypi:${name}@${version}`
    const existing = runtimeComponents.get(key)
    if (existing) existing.profiles.add(profile)
    else runtimeComponents.set(key, { name, version, profiles: new Set([profile]) })
  }
}

const uv = assets.assets.find((asset) => asset.name === 'uv Windows x64 archive')
const tigerFiles = assets.assets.filter((asset) => asset.repository === 'JusperLee/TIGER-DnR')
const btb = assets.assets.find((asset) => asset.name === 'BtbN FFmpeg Windows GPL archive')
const tigerRevision = tigerFiles[0].revision

const components = [
  ...mcpComponents,
  ...[...runtimeComponents.values()].map((component) => ({
    type: 'library',
    name: component.name,
    version: component.version,
    purl: `pkg:pypi/${component.name}@${encodeURIComponent(component.version)}`,
    license: 'NOASSERTION',
    properties: [{ name: 'stemstudio:managed-python-profiles', value: [...component.profiles].join(',') }]
  })),
  {
    type: 'application',
    name: 'uv',
    version: uv.version,
    purl: `pkg:github/astral-sh/uv@${uv.version}`,
    license: uv.license,
    hashes: [{ alg: 'SHA-256', content: uv.files['uv.exe'] }],
    properties: [{ name: 'stemstudio:platform', value: 'windows-x64' }]
  },
  ...['ffmpeg', 'ffprobe'].flatMap((name) => [
    {
      type: 'application',
      name,
      version: '7.1.5-1-g7d0e842004',
      purl: `pkg:github/BtbN/FFmpeg-Builds@${btb.buildScriptsCommit}?download_url=${encodeURIComponent(btb.url)}`,
      license: 'GPL-3.0-or-later',
      hashes: [{ alg: 'SHA-256', content: btb.files[`${name}.exe`] }],
      properties: [{ name: 'stemstudio:platform', value: 'windows-x64' }]
    },
    {
      type: 'application',
      name,
      version: '7.1.5-portable-gpl.1',
      purl: 'pkg:github/FFmpeg/FFmpeg@7d0e8420048cffd0ca3883b877ead2390496d0b2',
      license: 'GPL-3.0-or-later',
      properties: [{ name: 'stemstudio:platform', value: 'macos-arm64-source-build' }]
    }
  ]),
  {
    type: 'machine-learning-model',
    name: 'TIGER-DnR',
    version: tigerRevision,
    purl: `pkg:huggingface/JusperLee/TIGER-DnR@${tigerRevision}`,
    license: 'Apache-2.0',
    hashes: tigerFiles.map((file) => ({ alg: 'SHA-256', content: file.sha256 })),
    properties: tigerFiles.map((file) => ({ name: `stemstudio:model-file:${file.file}`, value: file.sha256 }))
  }
]

const spdxPath = resolve(release, 'stem-studio.spdx.json')
const spdx = JSON.parse(await readFile(spdxPath, 'utf8'))
const rootPackage = spdx.packages?.[0]
spdx.relationships ??= []
for (const [index, component] of components.entries()) {
  const id = `SPDXRef-StemRuntime-${index}`
  spdx.packages.push({
    SPDXID: id,
    name: component.name,
    versionInfo: component.version,
    downloadLocation: component.purl,
    filesAnalyzed: false,
    licenseConcluded: component.license,
    licenseDeclared: component.license,
    checksums: component.hashes?.map((hash) => ({
      algorithm: hash.alg.replace('-', ''),
      checksumValue: hash.content
    })),
    externalRefs: [{
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: component.purl
    }],
    comment: component.properties?.map((property) => `${property.name}=${property.value}`).join('; ')
  })
  if (rootPackage) {
    spdx.relationships.push({
      spdxElementId: rootPackage.SPDXID,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: id
    })
  }
}
await writeFile(spdxPath, `${JSON.stringify(spdx, null, 2)}\n`)

const cdxPath = resolve(release, 'stem-studio.cdx.json')
const cdx = JSON.parse(await readFile(cdxPath, 'utf8'))
cdx.components ??= []
cdx.dependencies ??= []
const rootRef = cdx.metadata?.component?.['bom-ref']
const rootDependency = cdx.dependencies.find((dependency) => dependency.ref === rootRef)
for (const [index, component] of components.entries()) {
  const ref = `stem-runtime-${index}`
  cdx.components.push({
    'bom-ref': ref,
    type: component.type,
    name: component.name,
    version: component.version,
    purl: component.purl,
    licenses: [{ expression: component.license }],
    hashes: component.hashes,
    properties: component.properties
  })
  cdx.dependencies.push({ ref, dependsOn: [] })
  if (rootDependency && !rootDependency.dependsOn.includes(ref)) rootDependency.dependsOn.push(ref)
}
await writeFile(cdxPath, `${JSON.stringify(cdx, null, 2)}\n`)
console.log(
  `Enriched SBOMs with ${components.length} runtime components ` +
  `(${mcpComponents.length} bundled MCP components).`
)
