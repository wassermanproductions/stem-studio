import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const sources = [
  {
    name: 'FFmpeg-7d0e8420048cffd0ca3883b877ead2390496d0b2.tar.gz',
    url: 'https://github.com/FFmpeg/FFmpeg/archive/7d0e8420048cffd0ca3883b877ead2390496d0b2.tar.gz',
    sha256: '2caafb2bbfb69c0518470651640e71ac7f5fb3117d188bf6ea2d909307a02b1d'
  },
  {
    name: 'FFmpeg-Builds-7a83528ea3431e9eca982a712bc3a7cd0789d5d0.tar.gz',
    url: 'https://github.com/BtbN/FFmpeg-Builds/archive/7a83528ea3431e9eca982a712bc3a7cd0789d5d0.tar.gz',
    sha256: '0f0f15e02b4fd1b1bc37d2e3a6f57cd7a2078c31a51c8546110d3ccb40029d30'
  },
  {
    name: 'ffmpeg-build-script-967cfb0c7d8ab000c466d00e4b6186f150ef4481.tar.gz',
    url: 'https://github.com/mifi/ffmpeg-build-script/archive/967cfb0c7d8ab000c466d00e4b6186f150ef4481.tar.gz',
    sha256: '8fbfb070b6102dee71ac42b93b2e150a5ef841a10e2466edcb845dec3689903d'
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
  }
]
const outputDir = resolve(import.meta.dirname, '..', 'release', 'corresponding-source')
await mkdir(outputDir, { recursive: true })

const checksumLines = []
for (const source of sources) {
  const destination = resolve(outputDir, source.name)
  const partial = `${destination}.partial`
  await rm(partial, { force: true })
  const download = spawnSync(
    process.platform === 'win32' ? 'curl.exe' : 'curl',
    ['--fail', '--location', '--retry', '3', '--retry-all-errors', '--output', partial, source.url],
    { stdio: 'inherit' }
  )
  if (download.status !== 0) {
    await rm(partial, { force: true })
    throw new Error(`Source download failed (curl exit ${download.status}): ${source.url}`)
  }
  const bytes = await readFile(partial)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== source.sha256) {
    await rm(partial, { force: true })
    throw new Error(`${source.name} checksum mismatch: expected ${source.sha256}, received ${actual}`)
  }
  await rm(destination, { force: true })
  await writeFile(destination, bytes)
  await rm(partial, { force: true })
  checksumLines.push(`${source.sha256}  ${source.name}`)
}

await writeFile(resolve(outputDir, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`)
await writeFile(
  resolve(outputDir, 'SOURCE_PROVENANCE.json'),
  `${JSON.stringify({ sources }, null, 2)}\n`
)
