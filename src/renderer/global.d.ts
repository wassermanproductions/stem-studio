import type { StemStudioAPI } from '../preload/index'

declare global {
  interface Window {
    stemstudio: StemStudioAPI
  }
}

export {}
