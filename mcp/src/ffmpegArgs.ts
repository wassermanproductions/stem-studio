// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.
/**
 * Pure ffmpeg/ffprobe argv builders — no spawning, no fs. Mirrors the app's
 * `src/shared/ffmpegArgs.ts` (which cannot be imported here). Unit-tested.
 */

import {
  ENGINE_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  STEMS,
  STEM_LABELS,
  type StemKind
} from './types.js'

/** ffprobe args to emit JSON with format + stream info for a file. */
export function probeArgs(inputPath: string): string[] {
  return ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', inputPath]
}

/**
 * ffmpeg args to extract/normalize input to a stereo WAV at the engine's
 * expected sample rate. `-vn` drops video; `-ac 2` forces stereo; PCM 16-bit
 * is plenty for the analysis path.
 */
export function extractAudioArgs(inputPath: string, outWavPath: string): string[] {
  return [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '2',
    '-ar',
    String(ENGINE_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    outWavPath
  ]
}

/**
 * ffmpeg args to convert a worker-produced stem WAV to the delivery format:
 * 48 kHz, 24-bit PCM. Sample rate forced; channel count preserved.
 */
export function convertStemArgs(inWavPath: string, outWavPath: string): string[] {
  return [
    '-y',
    '-i',
    inWavPath,
    '-ar',
    String(OUTPUT_SAMPLE_RATE),
    '-c:a',
    'pcm_s24le',
    outWavPath
  ]
}

/**
 * ffmpeg args to conform the original input's audio into a delivery-format
 * "married" mix WAV (48 kHz / 24-bit, stereo). Video (if any) is dropped —
 * this is the mixed reference track that sits alongside the split stems.
 */
export function marriedMixArgs(inputPath: string, outWavPath: string): string[] {
  return [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '2',
    '-ar',
    String(OUTPUT_SAMPLE_RATE),
    '-c:a',
    'pcm_s24le',
    outWavPath
  ]
}

/**
 * ffmpeg args to remux the original video with the three delivered stems as
 * separate, labelled audio tracks into a .mov (video copied, audio 24-bit
 * PCM). `stems` must be in canonical STEMS order. Copied from the app's
 * remuxMultitrackArgs.
 */
export function remuxMultitrackArgs(
  videoPath: string,
  stems: Record<StemKind, string>,
  outMovPath: string
): string[] {
  const args = ['-y', '-i', videoPath]
  for (const kind of STEMS) args.push('-i', stems[kind])

  args.push('-map', '0:v')
  for (let i = 0; i < STEMS.length; i++) args.push('-map', String(i + 1) + ':a')

  args.push('-c:v', 'copy', '-c:a', 'pcm_s24le')

  // Include the QuickTime handler name NLEs use for MOV track labels.
  STEMS.forEach((kind, i) => {
    args.push(`-metadata:s:a:${i}`, `title=${STEM_LABELS[kind]}`)
    args.push(`-metadata:s:a:${i}`, `handler_name=${STEM_LABELS[kind]}`)
  })

  args.push(outMovPath)
  return args
}
