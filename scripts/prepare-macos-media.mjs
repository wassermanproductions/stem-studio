/** Build and audit the pinned GPL FFmpeg/FFprobe pair for macOS arm64. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const temporaryDir = join(ROOT, 'build', 'runtime', '.macos-build')
const outputDir = join(ROOT, 'build', 'runtime', 'macos-arm64')
const patchPath = join(ROOT, 'build', 'ffmpeg', 'macos-arm64-gpl.patch')
const BUILD_COMMIT = '967cfb0c7d8ab000c466d00e4b6186f150ef4481'
const FFMPEG_COMMIT = '7d0e8420048cffd0ca3883b877ead2390496d0b2'
const LICENSE_SHA256 = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'

const sources = [
  {
    name: `ffmpeg-build-script-${BUILD_COMMIT}.tar.gz`,
    url: `https://github.com/mifi/ffmpeg-build-script/archive/${BUILD_COMMIT}.tar.gz`,
    sha256: '8fbfb070b6102dee71ac42b93b2e150a5ef841a10e2466edcb845dec3689903d',
    role: 'build-script'
  },
  {
    name: 'zlib-1.3.1.tar.gz',
    url: 'https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz',
    sha256: '9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23'
  },
  {
    name: 'x264-be4f0200.tar.gz',
    url: 'https://code.videolan.org/videolan/x264/-/archive/be4f0200/x264-be4f0200.tar.gz',
    sha256: '355270b5ca046609e4c5bd4eff7917a76e5926bd7fe426f8bcc3c67d8db6287b'
  },
  {
    name: 'libvpx-1.15.0.tar.gz',
    url: 'https://github.com/webmproject/libvpx/archive/refs/tags/v1.15.0.tar.gz',
    sha256: 'e935eded7d81631a538bfae703fd1e293aad1c7fd3407ba00440c95105d2011e'
  },
  {
    name: 'libwebp-1.4.0.tar.gz',
    url: 'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.4.0.tar.gz',
    sha256: '61f873ec69e3be1b99535634340d5bde750b2e4447caa1db9f61be3fd49ab1e5'
  },
  {
    name: 'dav1d-1.5.0.tar.gz',
    url: 'https://code.videolan.org/videolan/dav1d/-/archive/1.5.0/dav1d-1.5.0.tar.gz',
    sha256: '78b15d9954b513ea92d27f39362535ded2243e1b0924fde39f37a31ebed5f76b'
  },
  {
    name: 'svtav1-2.3.0.tar.gz',
    url: 'https://gitlab.com/AOMediaCodec/SVT-AV1/-/archive/v2.3.0/SVT-AV1-v2.3.0.tar.gz',
    sha256: 'ebb0b484ef4a0dc281e94342a9f73ad458496f5d3457eca7465bec943910c6c3'
  },
  {
    name: 'FFmpeg-release-7.1.5-portable-gpl.1.tar.gz',
    url: `https://github.com/FFmpeg/FFmpeg/archive/${FFMPEG_COMMIT}.tar.gz`,
    sha256: '2caafb2bbfb69c0518470651640e71ac7f5fb3117d188bf6ea2d909307a02b1d'
  }
]

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('prepare:ffmpeg:mac requires native macOS arm64.')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function download(source, destination) {
  run('curl', ['-fsSL', '--retry', '3', '-o', destination, source.url])
  const bytes = await readFile(destination)
  const actual = sha256(bytes)
  if (actual !== source.sha256) {
    throw new Error(`${source.name} checksum mismatch: expected ${source.sha256}, received ${actual}`)
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`)
  }
  return `${result.stdout}\n${result.stderr}`
}

/**
 * Enforce the same GPL provenance, linkage, and smoke checks on a prepared
 * FFmpeg/FFprobe pair regardless of whether it was built from source here or
 * downloaded from the pinned prebuilt asset. Throws loudly on any mismatch.
 */
async function auditMediaTools({ ffmpeg, ffprobe, license, workDir }) {
  if (sha256(await readFile(license)) !== LICENSE_SHA256) {
    throw new Error('FFmpeg GPLv3 license hash did not match the audited source.')
  }

  const configuration = run(ffmpeg, ['-hide_banner', '-buildconf'])
  for (const flag of ['--enable-gpl', '--enable-version3', '--enable-libx264']) {
    if (!configuration.includes(flag)) throw new Error(`macOS FFmpeg is missing ${flag}`)
  }
  for (const flag of ['--enable-nonfree', '--enable-openssl']) {
    if (configuration.includes(flag)) throw new Error(`macOS FFmpeg contains forbidden ${flag}`)
  }

  const linkage = run('otool', ['-L', ffmpeg])
  for (const line of linkage.split('\n').slice(1).map((line) => line.trim()).filter(Boolean)) {
    if (!line.startsWith('/usr/lib/') && !line.startsWith('/System/Library/')) {
      throw new Error(`macOS FFmpeg has a non-system dynamic dependency: ${line}`)
    }
  }

  const smoke = join(workDir, 'h264-aac-smoke.mp4')
  run(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', smoke
  ])
  const smokeProbe = JSON.parse(run(ffprobe, [
    '-v', 'error', '-show_streams', '-of', 'json', smoke
  ]).trim())
  const codecs = smokeProbe.streams.map((stream) => stream.codec_name)
  if (!codecs.includes('h264') || !codecs.includes('aac')) {
    throw new Error(`macOS media smoke did not produce H.264 + AAC: ${codecs}`)
  }
}

/** The pinned prebuilt darwin-<arch> asset from the manifest, or null. */
async function manifestPrebuilt() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'assets-manifest.json'), 'utf8'))
  for (const asset of manifest.assets ?? []) {
    const pinned = asset.prebuilt?.[`darwin-${process.arch}`]
    if (pinned?.url && pinned?.sha256 && pinned?.name) return pinned
  }
  return null
}

const buildFromSource = process.argv.includes('--build-from-source')
const prebuilt = await manifestPrebuilt()

if (prebuilt && !buildFromSource) {
  await rm(temporaryDir, { recursive: true, force: true })
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(temporaryDir, { recursive: true })

  const archive = join(temporaryDir, prebuilt.name)
  await download(prebuilt, archive)
  run('tar', ['-xzf', archive, '-C', join(ROOT, 'build', 'runtime')])

  const provenancePath = join(outputDir, 'media-provenance.json')
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'))
  if (provenance.buildScriptsCommit !== BUILD_COMMIT || provenance.ffmpegCommit !== FFMPEG_COMMIT) {
    throw new Error('Prebuilt macOS media provenance does not match the pinned commits.')
  }
  for (const [name, hash] of Object.entries(provenance.files)) {
    const actual = sha256(await readFile(join(outputDir, name)))
    if (actual !== hash) {
      throw new Error(`Prebuilt ${name} checksum mismatch: expected ${hash}, received ${actual}`)
    }
  }

  await auditMediaTools({
    ffmpeg: join(outputDir, 'ffmpeg'),
    ffprobe: join(outputDir, 'ffprobe'),
    license: join(outputDir, 'LICENSE-FFmpeg.txt'),
    workDir: temporaryDir
  })

  await rm(temporaryDir, { recursive: true, force: true })
  console.log(`Downloaded audited macOS arm64 media tools into ${outputDir}`)
  process.exit(0)
}

await rm(temporaryDir, { recursive: true, force: true })
await rm(outputDir, { recursive: true, force: true })
await mkdir(temporaryDir, { recursive: true })
await mkdir(outputDir, { recursive: true })

const buildArchive = join(temporaryDir, sources[0].name)
await download(sources[0], buildArchive)
const extracted = join(temporaryDir, 'source')
await mkdir(extracted)
run('tar', ['-xzf', buildArchive, '-C', extracted])
const sourceDirName = (await readdir(extracted, { withFileTypes: true }))
  .find((entry) => entry.isDirectory())?.name
if (!sourceDirName) throw new Error('The macOS build-script archive contained no source directory.')
const sourceDir = join(extracted, sourceDirName)
run('patch', ['-p1', '-i', patchPath], { cwd: sourceDir })

const packagesDir = join(sourceDir, 'packages')
await mkdir(packagesDir, { recursive: true })
for (const source of sources.slice(1)) {
  await download(source, join(packagesDir, source.name))
}

run('bash', ['build-ffmpeg', '--build'], {
  cwd: sourceDir,
  stdio: 'inherit',
  env: { ...process.env, NUMJOBS: process.env.NUMJOBS || '4' }
})

const ffmpeg = join(sourceDir, 'workspace', 'bin', 'ffmpeg')
const ffprobe = join(sourceDir, 'workspace', 'bin', 'ffprobe')
const license = join(
  packagesDir,
  'FFmpeg-release-7.1.5-portable-gpl.1',
  'COPYING.GPLv3'
)

await auditMediaTools({ ffmpeg, ffprobe, license, workDir: temporaryDir })

await copyFile(ffmpeg, join(outputDir, 'ffmpeg'))
await copyFile(ffprobe, join(outputDir, 'ffprobe'))
await copyFile(license, join(outputDir, 'LICENSE-FFmpeg.txt'))
const outputHashes = {
  ffmpeg: sha256(await readFile(ffmpeg)),
  ffprobe: sha256(await readFile(ffprobe)),
  'LICENSE-FFmpeg.txt': sha256(await readFile(license))
}
await writeFile(
  join(outputDir, 'media-provenance.json'),
  `${JSON.stringify({
    provider: 'mifi/ffmpeg-build-script',
    buildScriptsCommit: BUILD_COMMIT,
    ffmpegCommit: FFMPEG_COMMIT,
    patch: 'build/ffmpeg/macos-arm64-gpl.patch',
    sources,
    files: outputHashes,
    requiredConfigureFlags: ['--enable-gpl', '--enable-version3', '--enable-libx264'],
    forbiddenConfigureFlags: ['--enable-nonfree', '--enable-openssl'],
    linkagePolicy: 'system libraries and frameworks only',
    h264AacSmoke: true
  }, null, 2)}\n`
)
await rm(temporaryDir, { recursive: true, force: true })
console.log(`Prepared audited macOS arm64 media tools in ${outputDir}`)
