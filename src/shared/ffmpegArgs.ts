/**
 * Pure ffmpeg/ffprobe argument builders. No spawning, no fs — just the
 * argv arrays, so they can be unit-tested without touching the system.
 */

import {
  ENGINE_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  STEMS,
  STEM_LABELS,
  type StemKind
} from './types'

/** ffprobe args to emit JSON with format + stream info for a file. */
export function probeArgs(inputPath: string): string[] {
  return [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    inputPath
  ]
}

/**
 * ffmpeg args to extract/normalize input to a stereo WAV at the engine's
 * expected sample rate. `-vn` drops any video; `-ac 2` forces stereo so the
 * engine always sees two channels; PCM 16-bit is plenty for the analysis path.
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
 * 48 kHz, 24-bit PCM. Sample rate is forced; channel count is preserved.
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
 * ffmpeg args to conform the full original mix to the delivery spec: 48 kHz /
 * 24-bit PCM stereo WAV, video dropped. Produces `<basename>_MARRIED.wav` — the
 * fourth deliverable, format-identical to the three stems so all four WAVs are
 * sample-aligned and share one spec. Built from the same extracted audio path
 * as the stems (see job.ts) so it matches them exactly.
 */
export function marriedMixArgs(inWavPath: string, outWavPath: string): string[] {
  return [
    '-y',
    '-i',
    inWavPath,
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
 * separate, labelled audio tracks into a .mov (video stream copied, audio
 * re-encoded to 24-bit PCM). `stems` must be in canonical STEMS order.
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

  // Write both generic title metadata and the QuickTime handler name that NLEs
  // actually display for MOV audio tracks.
  STEMS.forEach((kind, i) => {
    args.push(`-metadata:s:a:${i}`, `title=${STEM_LABELS[kind]}`)
    args.push(`-metadata:s:a:${i}`, `handler_name=${STEM_LABELS[kind]}`)
  })

  args.push(outMovPath)
  return args
}
