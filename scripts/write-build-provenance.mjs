/** Write a checksummed, build-system-neutral provenance record for releases. */
import { createHash } from 'node:crypto'
import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const release = resolve(root, 'release')
const platform = process.argv[2] ?? `${process.platform}-${process.arch}`

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

const materialNames = [
  'package-lock.json',
  'mcp/package-lock.json',
  'python/requirements-windows-cpu.lock',
  'python/requirements-windows-cuda.lock',
  'assets-manifest.json',
  'electron-builder.yml',
  ...process.argv.slice(3)
]
const materials = []
for (const name of materialNames) {
  const path = resolve(root, name)
  await access(path)
  materials.push({ uri: name, digest: { sha256: await sha256(path) } })
}

const subjects = []
for (const name of await readdir(release)) {
  const path = resolve(release, name)
  if ((await stat(path)).isFile() && /\.(exe|json|txt|md)$/i.test(name)) {
    subjects.push({ name: basename(path), digest: { sha256: await sha256(path) } })
  }
}

// Record the source that was actually checked out. For manually dispatched tag
// builds, GITHUB_SHA identifies the workflow branch rather than the tag commit.
const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8'
}).trim()
const sourceRef = process.env.STEM_SOURCE_REF ?? process.env.GITHUB_REF ?? null
const provenance = {
  schemaVersion: 1,
  predicateType: 'https://slsa.dev/provenance/v1',
  subject: subjects,
  buildDefinition: {
    buildType: 'https://github.com/electron-userland/electron-builder',
    externalParameters: {
      platform,
      ref: sourceRef,
      repository: process.env.GITHUB_REPOSITORY ?? null
    },
    resolvedDependencies: [
      { uri: `git+https://github.com/${process.env.GITHUB_REPOSITORY ?? 'local/stem-studio'}@${gitSha}`,
        digest: { sha1: gitSha } },
      ...materials
    ]
  },
  runDetails: {
    builder: {
      id: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : 'local-codex-verification'
    },
    metadata: {
      invocationId: process.env.GITHUB_RUN_ID ?? null,
      generatedAt: new Date().toISOString()
    }
  }
}

await writeFile(
  resolve(release, 'build-provenance.json'),
  `${JSON.stringify(provenance, null, 2)}\n`
)
console.log(`Wrote build provenance for ${subjects.length} release subjects.`)
