# Stem Studio MCP — drive the separation pipeline from an AI agent

`stem-studio-mcp` is a small [MCP](https://modelcontextprotocol.io) **stdio** server that lets any MCP client — **Claude Code, Codex, or any other** — run the Stem Studio pipeline **headlessly**: probe a file, separate a married soundtrack into Dialogue / Music / SFX stems, and (for video) remux a multitrack `.mov`. **No Electron and no running app are involved** — the server spawns `ffmpeg`/`ffprobe` and the Python separation worker itself.

This is the agent-integration guide. For the product itself, see the [main README](../README.md).

---

## How it works

```
 MCP client  ──stdio (JSON-RPC)──▶  stem-studio-mcp  ──spawns──▶  ffmpeg / ffprobe
 (Claude Code)                      (this server)     ──spawns──▶  python -m stemstudio_worker.separate
```

The server reimplements only the thin pipeline pieces it needs (ffprobe probe, ffmpeg extract/convert/remux arg-building, the Python worker spawn + line-JSON parsing, venv resolution), mirroring the app's `src/shared` + `src/main` logic. It cannot import the Electron code, so those contracts (sample rates, stem naming, the worker JSON protocol) are re-declared in `mcp/src/` and unit-tested.

The separation pipeline is: **probe → extract audio to a temp job dir (44.1 kHz stereo WAV) → run the worker → convert stems to 48 kHz / 24-bit WAVs** named `<basename>_DIALOGUE/_MUSIC/_SFX.wav`, plus `<basename>_MARRIED.wav` (the conformed original mix) → optional `<basename>_STEMS.mov` remux for video inputs. **File paths in, file paths out — audio is never streamed through the protocol.**

---

## Requirements

- **Node ≥ 20** (the server) and **ffmpeg / ffprobe** on the machine (`brew install ffmpeg`). ffmpeg is resolved from `PATH` plus `/opt/homebrew/bin`, `/usr/bin`, `/usr/local/bin`.
- A **Python worker environment** — a venv with the worker's deps. Check it with the `setup_status` tool and create it with `setup_environment`, or point `STEMSTUDIO_PYTHON` at an existing venv python.

## Environment variables

All optional — sensible fallbacks are built in.

| Var | Meaning | Fallback |
|---|---|---|
| `STEMSTUDIO_ROOT` | Repo root that contains `python/` (the worker package). | This package's own repo (`mcp/..`). |
| `STEMSTUDIO_PYTHON` | Path to the venv python that runs the worker. | `<repo>/.venv/bin/python`. |
| `STEMSTUDIO_CACHE` | Model-weights cache dir (TIGER). | `~/.stemstudio/models`. |

The worker is always launched with `PYTHONPATH=<repo>/python`.

---

## Build

```bash
cd mcp
npm install
npm run build        # tsc/tsup -> dist/index.js  (bin: stem-studio-mcp)
npm run typecheck    # strict TS, no emit
npm test             # Vitest unit tests (arg builders, worker parser, job registry, env resolution)
npm run smoke        # build, then drive the server over stdio end-to-end with the stub engine
```

Point registrations at the built entry: **`<abs repo path>/mcp/dist/index.js`**.

## Connect

### Claude Code

```bash
claude mcp add stem-studio -- node /ABS/PATH/TO/stem-studio/mcp/dist/index.js
```

Add env vars if you don't rely on the fallbacks:

```bash
claude mcp add stem-studio \
  --env STEMSTUDIO_PYTHON=/ABS/PATH/TO/stem-studio/.venv/bin/python \
  -- node /ABS/PATH/TO/stem-studio/mcp/dist/index.js
```

Then `/mcp` in a session should list **stem-studio**. Remove with `claude mcp remove stem-studio`.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.stem-studio]
command = "node"
args = ["/ABS/PATH/TO/stem-studio/mcp/dist/index.js"]

[mcp_servers.stem-studio.env]
STEMSTUDIO_PYTHON = "/ABS/PATH/TO/stem-studio/.venv/bin/python"
```

### Any generic MCP client (JSON)

```json
{
  "mcpServers": {
    "stem-studio": {
      "command": "node",
      "args": ["/ABS/PATH/TO/stem-studio/mcp/dist/index.js"],
      "env": {
        "STEMSTUDIO_ROOT": "/ABS/PATH/TO/stem-studio",
        "STEMSTUDIO_PYTHON": "/ABS/PATH/TO/stem-studio/.venv/bin/python",
        "STEMSTUDIO_CACHE": "/ABS/PATH/TO/models-cache"
      }
    }
  }
}
```

Omit any `env` entry to take its fallback.

---

## Tools

Six tools. Every path is a **local file path** (never a URL or stream); every output is a file path.

| Tool | Input | Does |
|---|---|---|
| `probe_media` | `path` | Returns `duration`, `sample_rate`, `channels`, `has_video`, `format`. Fast (<1s). Errors clearly if the file is missing / has no audio / ffprobe is absent. |
| `separate_stems` | `input_path`, `output_dir?`, `quality?` (`fast`\|`high`\|`max`, default `fast`), `engine?` (`tiger`\|`mvsep`\|`stub`), `multitrack_video?`, `wait?` (default `true`) | Runs the full pipeline. Delivers `_DIALOGUE/_MUSIC/_SFX.wav` + `_MARRIED.wav` (and `_STEMS.mov` for video when `multitrack_video`). `wait:true` blocks + emits progress notifications; `wait:false` returns a `job_id`. |
| `check_job` | `job_id` | Status (`running`/`done`/`error`/`cancelled`), `stage`, `percent`, and on `done` the output paths. |
| `cancel_job` | `job_id` | Kills the process tree and cleans temp. Returns the resulting status. |
| `setup_status` | — | Readiness report: venv python present, `torch`/`numpy`/`soundfile` importable, compute device, model-cache presence. |
| `setup_environment` | `wait?` (default `true`) | Creates the venv (python3 ≥ 3.10) and pip-installs `python/requirements.txt`, streaming progress. Long-running; supports `wait:false` + `check_job`. |

**Runtimes / timeouts.** `probe_media`, `check_job`, `cancel_job`, `setup_status` are sub-second. `separate_stems` runs in **minutes** — the `stub` engine is seconds; `tiger` on Apple-silicon MPS is roughly real-time-ish and much slower on CPU; `quality` `high`/`max` multiply that. `setup_environment` is **several minutes** on first run (PyTorch is a large download). For the long tools, either give the `wait:true` call a generous client timeout, or use `wait:false` and poll `check_job`.

> `quality:'max'` and `engine:'mvsep'` may not exist in every worker snapshot; the server passes the flags straight through and surfaces the worker's error cleanly rather than pre-validating.

---

## Example agent session

```jsonc
// 1. Confirm the Python env is ready before a long run.
setup_status {}
// → { "ready": true, "pythonPath": ".../.venv/bin/python", "device": "mps", ... }
//   (if not ready:  setup_environment { "wait": false }  then poll check_job)

// 2. Inspect the input.
probe_media { "path": "/clips/scene12.mov" }
// → { "duration": 84.2, "sample_rate": 48000, "channels": 2, "has_video": true, "format": "mov / aac" }

// 3. Separate — blocking, with a multitrack .mov since it's a video.
separate_stems {
  "input_path": "/clips/scene12.mov",
  "output_dir": "/clips/stems",
  "quality": "high",
  "multitrack_video": true
}
// → { "status": "done",
//     "stems": { "dialogue": "/clips/stems/scene12_DIALOGUE.wav",
//                "music":    "/clips/stems/scene12_MUSIC.wav",
//                "sfx":      "/clips/stems/scene12_SFX.wav" },
//     "married": "/clips/stems/scene12_MARRIED.wav",
//     "multitrack_video": "/clips/stems/scene12_STEMS.mov" }

// --- or, for a long job, fire-and-poll ---
separate_stems { "input_path": "/clips/reel.mov", "wait": false }
// → { "job_id": "…", "status": "running" }
check_job { "job_id": "…" }      // repeat every few seconds
// → { "status": "separating", "percent": 41 }  …then… { "status": "done", "result": { … } }
cancel_job { "job_id": "…" }     // if you need to abort
```

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `probe_media` errors "Could not run ffprobe" | ffmpeg isn't installed / on PATH. `brew install ffmpeg`. |
| `setup_status` → `ready:false`, `pythonExists:false` | No venv at the resolved path. Run `setup_environment`, or set `STEMSTUDIO_PYTHON` to an existing venv python. |
| `setup_status` → `depsImportable:false` | The venv is missing `torch`/`numpy`/`soundfile`. Run `setup_environment` to (re)install `python/requirements.txt`. |
| `separate_stems` fails immediately with a worker error | The worker rejected the `engine`/`quality` (e.g. `mvsep`/`max` not in this build). Use `tiger`/`stub` and `fast`/`high`, or update the worker. |
| Worker can't find its package | `STEMSTUDIO_ROOT` doesn't point at a repo containing `python/stemstudio_worker/`. Set it, or run the server from within the repo. |

The server is local-only: it spawns local binaries and reads/writes local files. Nothing is exposed off-machine.
