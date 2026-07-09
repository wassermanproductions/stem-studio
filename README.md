<div align="center">

# Stem Studio

**Un-marry a soundtrack.** Drop in a video or audio file where dialogue, music, and effects are mixed on one track — get back three clean stems ready for your edit.

</div>

---

A "married" mix is one where dialogue, music, and sound effects are baked onto a single track — which is what you get from most delivered videos and reference cuts, and exactly what you *don't* want when you need to rebalance, replace the score, or duck the music under a line. Stem Studio separates that one track into three:

- 🗣️ **Dialogue**
- 🎼 **Music**
- 💥 **SFX**

Output is three broadcast-ready **WAV** files (48 kHz, 24-bit), plus a **`_MARRIED.wav`** — the full original mix conformed to the same spec so all four files are format-identical and sample-aligned. When the input is a video, Stem Studio can also remux the original picture with the three stems as separate, labelled audio tracks into a **`_STEMS.mov`** you drop straight into any NLE.

Stem Studio is part of Sam Wasserman's AI-film tool suite (Blockout, Motion Previs Studio, Storyboard Reference Studio).

> **Engine note.** This build separates with **TIGER-DnR**, a real ML source-separation model, and can also blend it with a second model, **MVSEP-CDX23** (HTDemucs-based), in the **Max** quality tier (see [Separation engine](#separation-engine)). A dependency-light band-split **stub** engine is still available (`--engine stub`) for tests and torch-free environments. All sit behind the same [engine contract](#engine-contract), so any drops in with no change to the app.

## What it does

1. Open a video (`mp4` / `mov` / `mkv` / `webm`) or audio (`wav` / `mp3` / `aac` / `flac` / `m4a`) file — drag-drop or **Open File**.
2. Stem Studio probes it (duration, sample rate, channels, whether it has picture), then normalizes the audio to the engine's working rate.
3. It runs the separation worker, streaming live progress: *Extracting audio → Loading model → Separating → Writing stems*.
4. You get `<name>_DIALOGUE.wav`, `<name>_MUSIC.wav`, `<name>_SFX.wav`, and `<name>_MARRIED.wav` (the conformed full mix) in your chosen output folder — with per-stem preview playback and **Reveal in Finder**. Video inputs optionally also produce `<name>_STEMS.mov`.

Everything runs **locally** — no upload, no account.

## Requirements

- macOS (Apple silicon → MPS), or Linux arm64 + CUDA (e.g. an [NVIDIA DGX Spark](#running-on-nvidia-dgx-spark)). Windows targets are configured but untested.
- **ffmpeg / ffprobe** — macOS `brew install ffmpeg`; Linux `sudo apt install ffmpeg`. Stem Studio looks in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, then `PATH`.
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
# TIGER-DnR (default); weights cache in a repo-local dir for dev
PYTHONPATH=python STEMSTUDIO_CACHE_DIR=cache/models .venv/bin/python \
  -m stemstudio_worker.separate --input input.wav --outdir /tmp/stems \
  --engine tiger --quality fast

# torch-free band-split stub
PYTHONPATH=python .venv/bin/python -m stemstudio_worker.separate \
  --input input.wav --outdir /tmp/stems --engine stub
```

## Separation engine

Stem Studio separates with **TIGER-DnR** ([JusperLee/TIGER](https://github.com/JusperLee/TIGER), model code MIT; weights [JusperLee/TIGER-DnR](https://huggingface.co/JusperLee/TIGER-DnR), Apache-2.0, ~17 MB / 4.22 M params). A minimal subset of the model code is **vendored** into `python/stemstudio_worker/vendor/tiger/` (so setup does not depend on cloning a repo at runtime); the weights download from the Hugging Face Hub on first run into a cache dir (`userData/models` in the app), reported through the "Loading model" progress stage. See [NOTICE](NOTICE) for attribution.

- **Device.** Selection order everywhere is **CUDA → MPS → CPU**; override with `STEMSTUDIO_DEVICE=cuda|mps|cpu`. On Apple silicon that means MPS; on an NVIDIA box (e.g. a [DGX Spark](#running-on-nvidia-dgx-spark)) it means CUDA. TIGER is float32 (MPS has no float64); one MPS-only op (`adaptive_avg_pool1d` with non-divisible sizes) is transparently routed to CPU. GPU is *strongly* preferred — CPU is ~100× slower. Run `python -m stemstudio_worker.separate --probe` to print the resolved device as one JSON line.
- **Quality modes** (`--quality fast|high|max`, UI selector). `fast` is a single TIGER pass. `high` is a **test-time-augmentation ensemble**: separate a few time-shifted copies, un-shift, and average (on the synthetic eval set `high` scores ≥ `fast` on every stem, overall +13.03 vs +12.57 dB SI-SDR, for ~3× the runtime). `max` additionally runs the **MVSEP-CDX23** model and blends the two per stem — see [Cross-model "Max" tier](#cross-model-max-tier). The UI defaults the tier to the detected device (**cuda → Max, mps → High, cpu → Fast**); you can always change it.
- **Chunked overlap-add.** Long audio is processed in bounded ~30 s blocks with a 1 s Hann-crossfaded overlap (`pipeline.chunked_overlap_add`), so peak memory is independent of input length and blocks join without seams. (The model also chunks internally in 12 s windows.)
- **Mixture consistency ("nothing lost").** After separation the residual `mix − (dialogue + music + effects)` is folded back into the effects stem, so the three stems sum to the original mix **sample-for-sample** (verified `max|residual| < 1e-6`). The worker writes 32-bit float stems to preserve this bit-exactly through to the ffmpeg delivery step.

### Second engine: MVSEP-CDX23

The **Max** tier's second model is **MVSEP-CDX23** ([ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing](https://github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing)), an HTDemucs-based DnR model run through `demucs` (MIT). Its three checkpoints (~54 MB each `.th`) download from the project's GitHub Releases on first use into the same `userData/models` cache; they are **never committed**. `--engine mvsep` runs a single checkpoint; the Max tier on CUDA uses the 3-checkpoint ensemble. Its device policy is **CUDA if present, else CPU** — MPS is skipped automatically (HTDemucs has known complex-tensor MPS issues) unless you force `STEMSTUDIO_DEVICE=mps`.

### Cross-model "Max" tier

`--quality max` runs **both** TIGER (high/TTA) **and** MVSEP-CDX23, then blends them per stem with fixed, empirically-chosen weights (`engine_max.MAX_BLEND_WEIGHTS`), and applies mixture consistency so the three stems still sum to the input. The weights were picked by scoring tiger-high, mvsep, and candidate blends on the synthetic eval set and keeping whatever measured best per stem — see the table below. Because MVSEP on macOS CPU is slow, use Max on a CUDA machine; on Apple silicon **High** is the sensible default.

### Evaluation

`python/eval/` proves the engine works and lets you regression-test it:

```bash
# 1) synthesize 3 reference triplets (say-generated speech + synth music + SFX)
PYTHONPATH=python .venv/bin/python -m eval.make_eval_set --outdir python/eval/data

# 2) score an engine/quality on them (SI-SDR per stem + improvement over the mix)
PYTHONPATH=python STEMSTUDIO_CACHE_DIR=cache/models \
  .venv/bin/python -m eval.evaluate --data python/eval/data --engine tiger --quality high
PYTHONPATH=python STEMSTUDIO_CACHE_DIR=cache/models \
  .venv/bin/python -m eval.evaluate --data python/eval/data --engine mvsep
PYTHONPATH=python STEMSTUDIO_CACHE_DIR=cache/models \
  .venv/bin/python -m eval.evaluate --data python/eval/data --quality max
PYTHONPATH=python .venv/bin/python -m eval.evaluate --data python/eval/data --engine stub
```

SI-SDR is implemented directly in numpy (`pipeline.si_sdr`). On the synthetic set, mean SI-SDR is **+12.57 dB** (tiger-fast) / **+13.03 dB** (tiger-high) / **−0.78 dB** (stub). This material is synthetic — scores are for regression/sanity, not absolute quality claims; real film mixes will differ.

#### Max-tier blend measurements

Mean SI-SDR (dB) over the 3 synthetic clips, **with mixture consistency applied exactly as shipped**. MVSEP wins dialogue and music; TIGER wins effects (and effects also absorbs the consistency residual, so pushing dialogue/music toward MVSEP drags effects down). An even **50/50** blend measured best overall and beats tiger-high by ~+1.07 dB without badly regressing any stem — that is what the Max tier ships (`engine_max.MAX_BLEND_WEIGHTS = {0.5, 0.5, 0.5}`, weight on TIGER per stem).

| config | dialogue | music | effects | overall |
|--------|----------|-------|---------|---------|
| tiger-high | +11.06 | +17.23 | +11.42 | +13.24 |
| mvsep (single ckpt) | +13.31 | +19.11 | +8.74 | +13.72 |
| **max — 50/50 (shipped)** | **+13.04** | **+18.94** | **+10.94** | **+14.31** |
| max — {d0.2, m0.2, e0.5} | +13.46 | +19.28 | +9.68 | +14.14 |
| max — {d0.25, m0.25, e0.5} | +13.45 | +19.27 | +9.91 | +14.21 |

Runtime on this machine (Apple M-series, 3 clips / 36 s audio): tiger-high on MPS, MVSEP single-checkpoint on CPU RTF ≈ 0.62× (a cached 15 s mix separates in ~10 s). MVSEP is much faster on CUDA, where the Max tier uses the 3-checkpoint ensemble by default.




## Engine contract

The Python worker is engine-agnostic. `separate.py` owns the CLI, WAV I/O, and progress protocol; the actual separation is any object implementing the `Engine` protocol:

```python
class Engine(Protocol):
    def load(self, progress_cb) -> None: ...
    def separate(self, audio: np.ndarray, sr: int, progress_cb) -> dict[str, np.ndarray]:
        # returns {"dialogue": ..., "music": ..., "effects": ...}
        ...
```

**CLI:** `python -m stemstudio_worker.separate --input <wav> --outdir <dir> [--engine tiger|mvsep|stub] [--quality fast|high|max] [--cache-dir <dir>]` writes `dialogue.wav`, `music.wav`, `effects.wav` into `<dir>` (defaults: `--engine tiger --quality fast`). `--quality max` blends TIGER-high with MVSEP-CDX23 (implies both engines). `python -m stemstudio_worker.separate --probe` prints one JSON line describing the device/torch stack and exits.

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
   │      (--quality max: TIGER-high + MVSEP-CDX23, blended per stem)
   │  ffmpeg → each stem @ 48 kHz / 24-bit PCM  →  <name>_{DIALOGUE,MUSIC,SFX}.wav
   │  ffmpeg → full mix @ 48 kHz / 24-bit PCM   →  <name>_MARRIED.wav
   ▼  (video inputs, optional)
ffmpeg remux: -map 0:v + 3× -map N:a, -c:v copy -c:a pcm_s24le,
              track titles Dialogue/Music/SFX  →  <name>_STEMS.mov
```

The `_STEMS.mov` carries the three stems + video; the format-identical, sample-aligned **`<name>_MARRIED.wav`** (the conformed full mix) is delivered as a fourth standalone WAV alongside the stems.

## Running on NVIDIA DGX Spark

Stem Studio runs on an **NVIDIA DGX Spark** (GB10 Grace Blackwell, DGX OS = Ubuntu-based, arm64, CUDA, 128 GB unified memory) — where the **Max** tier is the default and comfortably fast. First-run steps:

1. **ffmpeg** — `sudo apt update && sudo apt install -y ffmpeg`. Stem Studio resolves `ffmpeg`/`ffprobe` from `/usr/bin`, `/usr/local/bin`, then `PATH`.
2. **Python 3.10+** — DGX OS ships a suitable `python3`; Stem Studio builds and manages its own venv under the app's data folder on first separation (no manual venv needed).
3. **PyTorch + CUDA** — first-run setup installs the worker's libraries, then checks `torch.cuda.is_available()`. If an NVIDIA GPU is present (`nvidia-smi`) but the default wheel is CPU-only, it automatically reinstalls `torch`/`torchaudio` from the CUDA aarch64 index (`https://download.pytorch.org/whl/cu128`; cu128 = CUDA 12.8, required for Blackwell). This step is a large download — allow a few minutes.
4. **Expected behavior** — the device probe reports `cuda`, so the UI defaults the quality selector to **Max** (TIGER-high + the MVSEP 3-checkpoint ensemble, blended). MVSEP's checkpoints download on first Max run. Everything runs locally on the GPU.

Packaging Linux builds (AppImage + `.deb`, arm64) is configured in `electron-builder.yml` under `linux`.

## License

Apache-2.0 © 2026 Sam Wasserman. See [LICENSE](LICENSE) and [NOTICE](NOTICE) — retain the NOTICE and credit "Sam Wasserman (wassermanproductions.com)" in derivative works.
