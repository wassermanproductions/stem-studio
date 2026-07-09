<div align="center">

# Stem Studio

**Un-marry a soundtrack.** Drop in a video or audio file where dialogue, music, and effects are mixed on one track — get back three clean stems ready for your edit.

</div>

---

A "married" mix is one where dialogue, music, and sound effects are baked onto a single track — which is what you get from most delivered videos and reference cuts, and exactly what you *don't* want when you need to rebalance, replace the score, or duck the music under a line. Stem Studio separates that one track into three:

- 🗣️ **Dialogue**
- 🎼 **Music**
- 💥 **SFX**

Output is three broadcast-ready **WAV** files (48 kHz, 24-bit). When the input is a video, Stem Studio can also remux the original picture with the three stems as separate, labelled audio tracks into a **`_STEMS.mov`** you drop straight into any NLE.

Stem Studio is part of Sam Wasserman's AI-film tool suite (Blockout, Motion Previs Studio, Storyboard Reference Studio).

> **Engine note.** This build ships with a **stub separation engine** — a frequency band-split that routes low frequencies to Music, the speech band (300–3400 Hz) to Dialogue, and the residual to SFX. It exists so the whole pipeline runs end-to-end today. A real ML separation model drops in behind the same interface (see [Engine contract](#engine-contract)) with no change to the app.

## What it does

1. Open a video (`mp4` / `mov` / `mkv` / `webm`) or audio (`wav` / `mp3` / `aac` / `flac` / `m4a`) file — drag-drop or **Open File**.
2. Stem Studio probes it (duration, sample rate, channels, whether it has picture), then normalizes the audio to the engine's working rate.
3. It runs the separation worker, streaming live progress: *Extracting audio → Loading model → Separating → Writing stems*.
4. You get `<name>_DIALOGUE.wav`, `<name>_MUSIC.wav`, `<name>_SFX.wav` in your chosen output folder — with per-stem preview playback and **Reveal in Finder**. Video inputs optionally also produce `<name>_STEMS.mov`.

Everything runs **locally** — no upload, no account.

## Requirements

- macOS (Windows/Linux targets are configured but untested).
- **ffmpeg / ffprobe** — `brew install ffmpeg` (Stem Studio looks in `/opt/homebrew/bin` and on `PATH`).
- **Python 3.10+** — `brew install python`. On first separation, Stem Studio builds its own virtual environment under the app's data folder and installs the worker's libraries; you don't manage it.

## Dev setup

```bash
npm install            # Node 22+
npm run dev            # run the app with hot reload
npm run build          # production build into out/
npm start              # run the production build
npm run typecheck      # strict TS (renderer+shared, main)
npm run lint           # ESLint
npm test               # Vitest unit tests
npm run package        # macOS DMG into release/ (unsigned by default)
```

### Python worker (dev)

For development the app prefers a **repo-local `.venv`** if one exists, so you can run the pipeline without the first-run setup screen:

```bash
python3 -m venv .venv
.venv/bin/pip install -r python/requirements.txt

# end-to-end worker test: synthesize a tone, separate it, assert 3 non-silent stems
PYTHONPATH=python .venv/bin/python python/test_worker.py
```

Run the worker CLI directly:

```bash
PYTHONPATH=python .venv/bin/python -m stemstudio_worker.separate \
  --input input.wav --outdir /tmp/stems
```

## Engine contract

The Python worker is engine-agnostic. `separate.py` owns the CLI, WAV I/O, and progress protocol; the actual separation is any object implementing the `Engine` protocol:

```python
class Engine(Protocol):
    def load(self, progress_cb) -> None: ...
    def separate(self, audio: np.ndarray, sr: int, progress_cb) -> dict[str, np.ndarray]:
        # returns {"dialogue": ..., "music": ..., "effects": ...}
        ...
```

**CLI:** `python -m stemstudio_worker.separate --input <wav> --outdir <dir>` writes `dialogue.wav`, `music.wav`, `effects.wav` into `<dir>`.

**Stdout — line-delimited JSON:**

```jsonc
{"event":"progress","stage":"loading|separating|writing","percent":0-100}
{"event":"done","outputs":{"dialogue":"…","music":"…","effects":"…"}}
{"event":"error","message":"…"}
```

To swap in a real model, implement the protocol in a new module and construct it in `separate.main()` — nothing else changes. The input sample rate the engine receives is `ENGINE_SAMPLE_RATE` (`src/shared/types.ts`), currently 44.1 kHz; the main process resamples every input to it.

## Pipeline

```
input.(mov|mp4|wav|…)
   │  ffprobe → duration / sample rate / channels / hasVideo
   │  ffmpeg  → stereo WAV @ ENGINE_SAMPLE_RATE (job temp dir)
   ▼
stemstudio_worker.separate  →  dialogue.wav · music.wav · effects.wav
   │  ffmpeg → each stem @ 48 kHz / 24-bit PCM  →  <name>_{DIALOGUE,MUSIC,SFX}.wav
   ▼  (video inputs, optional)
ffmpeg remux: -map 0:v + 3× -map N:a, -c:v copy -c:a pcm_s24le,
              track titles Dialogue/Music/SFX  →  <name>_STEMS.mov
```

## License

Apache-2.0 © 2026 Sam Wasserman. See [LICENSE](LICENSE) and [NOTICE](NOTICE) — retain the NOTICE and credit "Sam Wasserman (wassermanproductions.com)" in derivative works.
