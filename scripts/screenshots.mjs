/**
 * Capture the four README screenshots by driving the built app under Playwright.
 *
 * Runs the real pipeline (repo-local .venv + cached model weights) end to end on
 * a short real married mix, and shoots each UI state at 1440x900 @2x:
 *
 *   drop.png       — pristine hero / drop view
 *   ready.png      — file loaded: file card + quality selector + options
 *   separating.png — mid-separation splitting visualization (~40-70%)
 *   stems.png      — done view, four waveform lanes rendered, playhead advanced
 *
 * Usage:
 *   node scripts/screenshots.mjs "/abs/path/to/input.mov"
 *
 * The input path defaults to the repo's own demo mix if omitted. File selection
 * is stubbed by monkey-patching dialog.showOpenDialog in the main process, so no
 * native dialog appears; everything else (probe, separation, delivery) is real.
 */

import { _electron as electron } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

const INPUT = process.argv[2]
if (!INPUT || !existsSync(INPUT)) {
  console.error(`Input file not found: ${INPUT ?? '(none provided)'}`)
  console.error('Usage: node scripts/screenshots.mjs "/abs/path/to/input.mov"')
  process.exit(1)
}

const OUT_DIR = join(repoRoot, 'docs', 'screenshots')
// Deliver the real stems into a throwaway dir whose path reads naturally in the
// UI's output-folder field (it's cleaned up at the end).
const STEMS_OUT = process.env.SCREENSHOT_STEMS_DIR || join(repoRoot, '.screenshot-stems')

const VIEWPORT = { width: 1440, height: 900 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The launched Electron app — module-scoped so shoot() can reach its window. */
let app

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  await rm(STEMS_OUT, { recursive: true, force: true })
  await mkdir(STEMS_OUT, { recursive: true })

  app = await electron.launch({
    args: [
      join(repoRoot, 'out', 'main', 'index.js'),
      // Retina-crisp captures: render the backing store at 2x.
      '--force-device-scale-factor=2',
      '--high-dpi-support=1'
    ],
    cwd: repoRoot,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  })

  // Stub the open-file dialog and the output-folder picker in the main process:
  // the Open button resolves straight to our demo input, and the output folder
  // is pinned to a throwaway dir so no native dialogs appear.
  await app.evaluate(
    ({ dialog }, { input, stemsOut }) => {
      dialog.showOpenDialog = async (_win, opts) => {
        const wantsDir =
          opts && Array.isArray(opts.properties) && opts.properties.includes('openDirectory')
        return { canceled: false, filePaths: [wantsDir ? stemsOut : input] }
      }
    },
    { input: INPUT, stemsOut: STEMS_OUT }
  )

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Size the window generously. We deliberately do NOT call
  // page.setViewportSize(): that pins the CDP device-scale-factor to 1 and
  // defeats the --force-device-scale-factor=2 launch flag, so captures would be
  // 1x. Native window sizing keeps the 2x backing store for retina-crisp PNGs.
  const win = await app.browserWindow(page)
  await win.evaluate((w, v) => {
    w.setContentSize(v.width, v.height)
    w.webContents.setZoomFactor(1)
  }, VIEWPORT)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await sleep(600)

  // 1) drop.png — pristine hero.
  await page.waitForSelector('.dropzone', { state: 'visible' })
  await sleep(400)
  await shoot(page, 'drop.png')

  // 2) ready.png — load the file via the stubbed dialog, pin the output folder,
  //    force the Fast tier (don't run Max — too slow), then shoot.
  await page.click('.dropzone')
  await page.waitForSelector('.file-card', { state: 'visible' })
  // Pin output folder through the stubbed directory picker.
  await page.click('.folder-row .btn-ghost')
  await page.waitForFunction(
    (dir) => !!document.querySelector('.folder-path')?.textContent?.includes(dir.split('/').pop()),
    STEMS_OUT
  )
  // Select Fast quality explicitly.
  await page.click('.quality-seg:has(.q-name:has-text("Fast"))')
  await page.waitForSelector('.quality-seg.active:has-text("Fast")')
  await sleep(400)
  await shoot(page, 'ready.png')

  // 3) separating.png — start the run and catch a mid-flight frame with the
  //    overall progress in a lively 40-70% band.
  await page.click('.btn-primary.btn-lg')
  await page.waitForSelector('.splitter', { state: 'visible' })
  await captureMidSeparation(page)

  // 4) stems.png — wait for the done view and for all four lane canvases to be
  //    actually painted, advance the playhead by seeking, then shoot.
  await page.waitForSelector('.done-header', { state: 'visible', timeout: 10 * 60 * 1000 })
  await page.waitForSelector('.lane', { state: 'visible' })
  await page.waitForFunction(() => {
    const canvases = Array.from(document.querySelectorAll('canvas.lane-canvas'))
    if (canvases.length < 4) return false
    // Every lane canvas must have non-blank pixels drawn.
    return canvases.every((c) => {
      const ctx = c.getContext('2d')
      if (!ctx || c.width === 0 || c.height === 0) return false
      const { data } = ctx.getImageData(0, 0, c.width, c.height)
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true
      return false
    })
  }, undefined, { timeout: 60_000 })
  // Seek ~30% into the timeline by clicking the married lane's waveform.
  const wrap = await page.$('.lane.married .lane-canvas-wrap')
  const box = await wrap.boundingBox()
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2)
  await sleep(500)
  await shoot(page, 'stems.png')

  await app.close()
  await rm(STEMS_OUT, { recursive: true, force: true })
  console.log('Done. Screenshots in docs/screenshots/')
}

async function captureMidSeparation(page) {
  // Poll the overall percent shown in the progress header; grab the frame when
  // it lands in a lively band. Fall back to the last seen separating frame.
  const deadline = Date.now() + 6 * 60 * 1000
  let shot = false
  while (Date.now() < deadline) {
    const info = await page.evaluate(() => {
      const pctEl = document.querySelector('.progress-pct')
      const done = !!document.querySelector('.done-header')
      const splitting = !!document.querySelector('.splitter.active')
      const pct = pctEl ? parseInt(pctEl.textContent || '0', 10) : 0
      return { pct, done, splitting }
    })
    if (info.done) break
    if (info.splitting && info.pct >= 45 && info.pct <= 68) {
      await sleep(150)
      await shoot(page, 'separating.png')
      shot = true
      break
    }
    await sleep(400)
  }
  if (!shot) {
    // Best-effort: shoot whatever separating frame is on screen right now.
    if (await page.$('.splitter')) await shoot(page, 'separating.png')
  }
}

async function shoot(page, name) {
  // Capture through Electron's own webContents.capturePage, which honours the
  // window's device scale factor (2x here) and returns a full-resolution PNG —
  // unlike page.screenshot under CDP viewport emulation, which flattens to 1x.
  const path = join(OUT_DIR, name)
  const win = await app.browserWindow(page)
  const dataUrl = await win.evaluate(async (w) => {
    const img = await w.webContents.capturePage()
    return img.toDataURL()
  })
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
  await writeFile(path, Buffer.from(base64, 'base64'))
  console.log(`  shot ${name}`)
}

main().catch(async (err) => {
  console.error(err)
  process.exit(1)
})
