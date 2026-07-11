/** Prepare checksum-verified Windows-only runtime assets on native Windows x64. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import extract from 'extract-zip'

const UV = {
  version: '0.11.28',
  archive: 'uv-x86_64-pc-windows-msvc.zip',
  sha256: '0a23463216d09c6a72ff80ef5dc5a795f07dc1575cb84d24596c2f124a441b7b',
  executableSha256: '533fe4044bc50b05ac89f4d07925597fdb5285369724e8986ecab356818f09ee',
  licenseSha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
  url: 'https://github.com/astral-sh/uv/releases/download/0.11.28/uv-x86_64-pc-windows-msvc.zip'
}

const MEDIA = {
  release: 'autobuild-2026-06-30-13-34',
  buildCommit: '7a83528ea3431e9eca982a712bc3a7cd0789d5d0',
  ffmpegCommit: '7d0e8420048cffd0ca3883b877ead2390496d0b2',
  archive: 'ffmpeg-n7.1.5-1-g7d0e842004-win64-gpl-7.1.zip',
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-06-30-13-34/ffmpeg-n7.1.5-1-g7d0e842004-win64-gpl-7.1.zip',
  sha256: '405b190f746db40539eb453967f72c0e69d8bf260b10ceff36e0c2149a9ad22f',
  files: {
    'ffmpeg.exe': '9b2f8ddda3958ce61433b07efc657ab078e71a36d6a0a3240da7eece70a75bc2',
    'ffprobe.exe': '4919faa7f0586eb05802908276f78096d3003335eaa38c378b6b1c44f1e19814',
    'LICENSE.txt': '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'
  }
}

const REQUIRED_FLAGS = [
  '--enable-gpl',
  '--enable-version3',
  '--enable-libx264',
  '--disable-libfdk-aac'
]
const FORBIDDEN_FLAGS = ['--enable-nonfree']
const ROOT = resolve(import.meta.dirname, '..')
const outputDir = join(ROOT, 'build', 'runtime', 'windows')
const temporaryDir = join(ROOT, 'build', 'runtime', '.windows-download')

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(
    'prepare:win-runtime must run on native Windows x64. Cross-packaging runtime binaries is unsupported.'
  )
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function verifyHash(label, bytes, expected) {
  const actual = sha256(bytes)
  if (actual !== expected) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, received ${actual}`)
  }
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function findFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFile(path, name)
      if (nested) return nested
    } else if (basename(path).toLowerCase() === name.toLowerCase()) {
      return path
    }
  }
  return null
}

function verifyBuildConfiguration(ffmpegPath) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-buildconf'], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) {
    throw new Error(`Unable to inspect FFmpeg build configuration: ${result.stderr}`)
  }
  const configuration = `${result.stdout}\n${result.stderr}`
  for (const flag of REQUIRED_FLAGS) {
    if (!configuration.includes(flag)) throw new Error(`FFmpeg is missing required flag ${flag}`)
  }
  for (const flag of FORBIDDEN_FLAGS) {
    if (configuration.includes(flag)) throw new Error(`FFmpeg contains forbidden flag ${flag}`)
  }
  return configuration
}

await rm(temporaryDir, { recursive: true, force: true })
await rm(outputDir, { recursive: true, force: true })
await mkdir(temporaryDir, { recursive: true })
await mkdir(outputDir, { recursive: true })

// uv bootstrapper.
const uvArchive = await download(UV.url)
verifyHash(UV.archive, uvArchive, UV.sha256)
const uvArchivePath = join(temporaryDir, UV.archive)
await writeFile(uvArchivePath, uvArchive)
const uvExtract = join(temporaryDir, 'uv')
await mkdir(uvExtract)
await extract(uvArchivePath, { dir: uvExtract })
const uvExe = await readFile(join(uvExtract, 'uv.exe'))
verifyHash('uv.exe', uvExe, UV.executableSha256)
await writeFile(join(outputDir, 'uv.exe'), uvExe)
await writeFile(join(outputDir, 'uv.exe.sha256'), `${sha256(uvExe)}  uv.exe\n`)
const uvLicense = await download('https://raw.githubusercontent.com/astral-sh/uv/0.11.28/LICENSE-APACHE')
verifyHash('uv LICENSE-APACHE', uvLicense, UV.licenseSha256)
await writeFile(join(outputDir, 'LICENSE-uv-apache'), uvLicense)

// Redistributable GPL FFmpeg/FFprobe pair.
const mediaArchive = await download(MEDIA.url)
verifyHash(MEDIA.archive, mediaArchive, MEDIA.sha256)
const mediaArchivePath = join(temporaryDir, MEDIA.archive)
await writeFile(mediaArchivePath, mediaArchive)
const mediaExtract = join(temporaryDir, 'media')
await mkdir(mediaExtract)
await extract(mediaArchivePath, { dir: mediaExtract })

for (const [name, expected] of Object.entries(MEDIA.files)) {
  const source = await findFile(mediaExtract, name)
  if (!source) throw new Error(`${name} was not found in ${MEDIA.archive}`)
  const bytes = await readFile(source)
  verifyHash(name, bytes, expected)
  const destinationName = name === 'LICENSE.txt' ? 'LICENSE-FFmpeg.txt' : name
  await writeFile(join(outputDir, destinationName), bytes)
}

const configuration = verifyBuildConfiguration(join(outputDir, 'ffmpeg.exe'))
const probeVersion = spawnSync(join(outputDir, 'ffprobe.exe'), ['-version'], {
  encoding: 'utf8',
  windowsHide: true
})
if (probeVersion.status !== 0) throw new Error(`ffprobe validation failed: ${probeVersion.stderr}`)

await writeFile(
  join(outputDir, 'media-provenance.json'),
  `${JSON.stringify({
    provider: 'BtbN/FFmpeg-Builds',
    release: MEDIA.release,
    buildScriptsCommit: MEDIA.buildCommit,
    ffmpegCommit: MEDIA.ffmpegCommit,
    archive: { name: MEDIA.archive, url: MEDIA.url, sha256: MEDIA.sha256 },
    files: MEDIA.files,
    requiredConfigureFlags: REQUIRED_FLAGS,
    forbiddenConfigureFlags: FORBIDDEN_FLAGS,
    verifiedBuildConfiguration: configuration.trim()
  }, null, 2)}\n`
)

await rm(temporaryDir, { recursive: true, force: true })
console.log(`Prepared verified Windows runtime assets in ${outputDir}`)
