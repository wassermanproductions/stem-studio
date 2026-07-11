import { describe, expect, it } from 'vitest'
import { displayBasename, stemPreviewUrl } from '@shared/paths'

describe('displayBasename', () => {
  it('supports POSIX, drive-letter, and UNC paths', () => {
    expect(displayBasename('/exports/clip_DIALOGUE.wav')).toBe('clip_DIALOGUE.wav')
    expect(displayBasename('C:\\Users\\Editor\\clip_DIALOGUE.wav')).toBe('clip_DIALOGUE.wav')
    expect(displayBasename('\\\\server\\share\\clip_DIALOGUE.wav')).toBe('clip_DIALOGUE.wav')
  })

  it('round-trips drive-letter, UNC, spaces, apostrophes, and Unicode in preview URLs', () => {
    for (const path of [
      "C:\\Users\\Film Editor\\O'Brien\\场景.wav",
      '\\\\server\\OneDrive - Studio\\场景.wav'
    ]) {
      expect(new URL(stemPreviewUrl(path)).searchParams.get('path')).toBe(path)
    }
  })
})
