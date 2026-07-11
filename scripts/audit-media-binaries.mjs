/** Fail-closed redistribution audit for platform media binaries. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const platformIndex = process.argv.indexOf('--platform')
const requested = platformIndex >= 0 ? process.argv[platformIndex + 1] : undefined
const platform = requested || (process.platform === 'win32' ? 'windows' : process.platform)

if (platform === 'linux') {
  const builderConfig = await readFile(join(root, 'electron-builder.yml'), 'utf8')
  if (/runtime-bootstrap\/linux|ffmpeg[^\n]*extraResources/i.test(builderConfig)) {
    throw new Error('Linux packaging unexpectedly declares a bundled media binary.')
  }
  console.log('Linux redistribution audit passed: no media binary is bundled; override/PATH fallback remains.')
  process.exit(0)
}

if (platform !== 'windows' && platform !== 'mac') {
  throw new Error(
    `No audited redistributable bundled FFmpeg/FFprobe pair is pinned for ${platform}. ` +
    'Packaging is blocked; runtime overrides and PATH fallback remain available.'
  )
}
const isWindows = platform === 'windows'
if (
  (isWindows && (process.platform !== 'win32' || process.arch !== 'x64')) ||
  (!isWindows && (process.platform !== 'darwin' || process.arch !== 'arm64'))
) throw new Error(`The ${platform} media audit must run on its native target architecture.`)

const directory = join(root, 'build', 'runtime', isWindows ? 'windows' : 'macos-arm64')
const expected = isWindows ? {
  'ffmpeg.exe': '9b2f8ddda3958ce61433b07efc657ab078e71a36d6a0a3240da7eece70a75bc2',
  'ffprobe.exe': '4919faa7f0586eb05802908276f78096d3003335eaa38c378b6b1c44f1e19814',
  'LICENSE-FFmpeg.txt': '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'
} : JSON.parse(await readFile(join(directory, 'media-provenance.json'), 'utf8')).files
for (const [name, hash] of Object.entries(expected)) {
  const actual = createHash('sha256').update(await readFile(join(directory, name))).digest('hex')
  if (actual !== hash) throw new Error(`${name} failed the redistribution checksum audit.`)
}

const provenance = JSON.parse(
  await readFile(join(directory, 'media-provenance.json'), 'utf8')
)
const expectedBuildCommit = isWindows
  ? '7a83528ea3431e9eca982a712bc3a7cd0789d5d0'
  : '967cfb0c7d8ab000c466d00e4b6186f150ef4481'
if (
  provenance.buildScriptsCommit !== expectedBuildCommit ||
  provenance.ffmpegCommit !== '7d0e8420048cffd0ca3883b877ead2390496d0b2' ||
  (isWindows && provenance.archive?.sha256 !== '405b190f746db40539eb453967f72c0e69d8bf260b10ceff36e0c2149a9ad22f')
) {
  throw new Error('FFmpeg provenance does not match the approved Windows build.')
}

const ffmpegName = isWindows ? 'ffmpeg.exe' : 'ffmpeg'
const result = spawnSync(join(directory, ffmpegName), ['-hide_banner', '-buildconf'], {
  encoding: 'utf8',
  windowsHide: true
})
if (result.status !== 0) throw new Error(`FFmpeg build audit failed: ${result.stderr}`)
const configuration = `${result.stdout}\n${result.stderr}`
const requiredFlags = isWindows
  ? ['--enable-gpl', '--enable-version3', '--enable-libx264', '--disable-libfdk-aac']
  : ['--enable-gpl', '--enable-version3', '--enable-libx264']
for (const flag of requiredFlags) {
  if (!configuration.includes(flag)) throw new Error(`FFmpeg build audit is missing ${flag}`)
}
if (configuration.includes('--enable-nonfree')) {
  throw new Error('FFmpeg build audit found forbidden --enable-nonfree.')
}
if (!isWindows && configuration.includes('--enable-openssl')) {
  throw new Error('macOS FFmpeg build audit found forbidden --enable-openssl.')
}

console.log(`${platform} FFmpeg/FFprobe redistribution audit passed.`)
