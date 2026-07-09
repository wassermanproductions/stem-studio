# AGENTS.md — running & modifying Stem Studio with an AI agent

Single source of truth for AI coding agents working on this repo. `CLAUDE.md` points here.

## What this app is

Electron + TypeScript + React desktop tool that separates a **married** film soundtrack (video or audio with dialogue+music+SFX on one track) into three stems: **Dialogue**, **Music**, **SFX**. Output: three 48 kHz / 24-bit WAVs, plus an optional multitrack `.mov` for NLE import when the input is video. Separation runs in a Python worker; the app manages its own venv. This build ships a **stub band-split engine** behind an engine-agnostic interface — a real ML model drops in later unchanged.

## Commands

```bash
npm install            # once; Node 22+
npm run dev            # app with hot reload
npm run build          # production build into out/
npm start              # run the production build
npm run typecheck      # strict TS, two projects (renderer+shared / main)
npm run lint           # ESLint
npm test               # Vitest unit tests (store machine, ffmpeg args, worker parser)
npm run package        # macOS DMG into release/ (unsigned)

# Python worker (dev): repo-local .venv is auto-used by the app if present
python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt
PYTHONPATH=python .venv/bin/python python/test_worker.py   # e2e: 3 non-silent stems
```

**Definition of done for any change: `npm run typecheck && npm run lint && npm test` green.** If you touched the worker, `python/test_worker.py` must pass too.

External tools: **ffmpeg/ffprobe** (resolved from `/opt/homebrew/bin` then PATH) and **python3 ≥ 3.10**.

## Repo map

```
src/shared/     DOM-free, Electron-free code shared everywhere (unit-tested):
                types.ts (IPC contract + constants — ENGINE_SAMPLE_RATE lives here),
                ffmpegArgs.ts (PURE argv builders), workerProtocol.ts (JSON-line parser).
src/main/       Electron main: index.ts (window, stem:// protocol, IPC, dialogs),
                ffmpeg.ts (probe/run), pythonEnv.ts (venv detect/create/install),
                job.ts (extract → setup → worker → convert → remux, + cancel).
src/preload/    Typed IPC bridge exposed as window.stemstudio. Keep in sync with main.
src/renderer/   React UI. store.ts (zustand job state machine), views/ (Drop/Ready/
                Progress/Done/Error), loadInput.ts (renderer-side actions), styles.css.
python/         stemstudio_worker/ package: separate.py (engine-agnostic CLI +
                Engine protocol), engine_stub.py (band-split placeholder).
                requirements.txt, test_worker.py.
tests/unit/     Vitest.
scripts/        make_test_tone.py — synthesize a 5s multi-band test WAV.
```

## Hard rules

1. **`src/shared/` stays pure** — no DOM, no Electron, no Node-only APIs beyond types. It runs under Vitest/Node and is imported by main, preload, and renderer.
2. **ffmpeg argv building lives in `src/shared/ffmpegArgs.ts` as pure functions** with unit tests. `src/main/ffmpeg.ts` only spawns them. Don't inline argv arrays in `job.ts`.
3. **The worker protocol is the contract.** Stdout is line-delimited JSON only (`progress` / `done` / `error`); anything else on stdout is treated as noise. Keep the engine behind the `Engine` protocol in `separate.py` — swap engines without touching the app or the JSON contract.
4. **Job state machine**: all UI status flows through `useStore` transitions in `src/renderer/store.ts` (`idle → ready → extracting → setup → separating → writing → done | error | cancelled`). The pure helpers (`canSeparate`, `stageProgress`, `statusForStage`) are unit-tested — keep them pure.
5. **Sample rates are constants** in `src/shared/types.ts`: `ENGINE_SAMPLE_RATE` (worker input), `OUTPUT_SAMPLE_RATE` / `OUTPUT_BIT_DEPTH` (delivery). Change there, not inline.
6. **Renderer never touches the filesystem or spawns** — everything goes through `window.stemstudio` (preload → IPC → main). Media preview uses the `stem://` protocol, not `file://`.

## Common tasks

- **Plug in a real separation engine**: add `python/stemstudio_worker/engine_<name>.py` implementing `load` / `separate`, add its deps to `requirements.txt`, and construct it in `separate.main()`. If it needs a different input rate, change `ENGINE_SAMPLE_RATE`.
- **Add an IPC method**: add the handler in `src/main/index.ts`, the typed method in `src/preload/index.ts` (`StemStudioAPI`), and call it from the renderer.
- **Change the output naming / format**: `STEM_SUFFIX` + `convertStemArgs` (WAVs), `remuxMultitrackArgs` (the `.mov`).
