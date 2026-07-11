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

- **Source checkout:** Node ≥ 20 runs the stdio server.
- **Installed app:** use the packaged launcher described below; it runs the bridge through Electron's embedded Node, so no separate Node installation is required. Packaged builds share the app's worker, FFmpeg/FFprobe where bundled, model cache, and private Python runtime.
- A **Python worker environment** — a venv with the worker's deps. Check it with the `setup_status` tool and create it with `setup_environment`, or point `STEMSTUDIO_PYTHON` at an existing venv python.

## Environment variables

All optional — sensible fallbacks are built in.

| Var | Meaning | Fallback |
|---|---|---|
| `STEMSTUDIO_ROOT` | Repo root that contains `python/` (the worker package). | This package's own repo (`mcp/..`). |
| `STEMSTUDIO_PYTHON` | Optional override for the worker Python. | Installed app private runtime; source checkout `<repo>/.venv/bin/python`. |
| `STEMSTUDIO_RESOURCES` | Installed Electron `resources` directory. | Auto-detected when the MCP bundle is packaged. |
| `STEMSTUDIO_USER_DATA` | Shared app data directory; useful for isolated CI. | Electron's distribution-specific user-data root when packaged. |
| `STEMSTUDIO_USER_DATA_FOLDER` | Distribution-specific folder name for an MCP launcher. Packaged builds read the same value from `stem-studio-distribution.json`. | `stem-studio`. |
| `STEMSTUDIO_CACHE` | Model-weights cache dir. | Packaged app's `models/`; source checkout `~/.stemstudio/models`. |
| `STEMSTUDIO_WINDOWS_PROFILE` | Windows setup profile: `cpu` or experimental `cuda`. | `cpu`; failed CUDA setup automatically rebuilds the CPU profile. |
| `SMOKE_SEPARATION_TIMEOUT_MS` | Integration-smoke timeout for a long `separate_stems` call. | 20 minutes for TIGER, 5 minutes for the stub. |

The worker is always launched with `PYTHONPATH=<repo>/python`.

---

## Build

```bash
cd mcp
npm install
npm run build        # tsc/tsup -> dist/index.js  (bin: stem-studio-mcp)
npm run typecheck    # strict TS, no emit
npm test             # Vitest unit tests (arg builders, worker parser, job registry, env resolution)
npm run smoke        # build, then drive the server end-to-end with the CI-only stub
```

Point registrations at the built entry: **`<abs repo path>/mcp/dist/index.js`**.

### Installed launcher (no external Node)

Every packaged app includes the bridge at `resources/mcp/index.js` and a
launcher beside it. Register the launcher, not the JavaScript file:

- Windows: `<chosen install directory>\resources\mcp\stem-studio-mcp.cmd`
- macOS: `<Stem Studio.app>/Contents/Resources/mcp/stem-studio-mcp`
- Linux unpacked/AppImage resource tree: `resources/mcp/stem-studio-mcp`

The launcher sets `ELECTRON_RUN_AS_NODE=1`, invokes the packaged Electron
executable, and automatically discovers the adjacent distribution descriptor,
worker, media tools, and the same user-data/model/runtime paths as the GUI.

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
| `separate_stems` | `input_path`, `output_dir?`, `quality?` (`fast`\|`high` on Windows; existing macOS/Linux also expose `max`), `engine?` (`tiger` on Windows; existing macOS/Linux also expose `mvsep`), `multitrack_video?`, `polish_dialogue?` (default `false`), `wait?` (default `true`) | Runs the local separation pipeline. Delivers `_DIALOGUE/_MUSIC/_SFX.wav` + `_MARRIED.wav` (and `_STEMS.mov` for video when `multitrack_video`). `polish_dialogue` adds an optional pass that reduces music/effects bleed in the dialogue stem (the bleed is folded into effects, so the stems still sum exactly). `wait:true` blocks + emits progress notifications; `wait:false` returns a `job_id`. |
| `check_job` | `job_id` | Status (`running`/`done`/`error`/`cancelled`), `stage`, `percent`, and on `done` the output paths. |
| `cancel_job` | `job_id` | Kills the process tree and cleans temp. Returns the resulting status. |
| `setup_status` | — | Readiness report: venv python present, `torch`/`numpy`/`soundfile` importable, compute device, model-cache presence. |
| `setup_environment` | `wait?` (default `true`) | On Windows, provisions pinned CPython 3.12.10 and the hashed CPU lock with bundled uv; otherwise creates the existing source venv. Long-running; supports `wait:false` + `check_job`. |

**Runtimes / timeouts.** `probe_media`, `check_job`, `cancel_job`, and `setup_status` are sub-second. `separate_stems` runs in **minutes** — TIGER on a GPU is roughly real-time-ish and much slower on CPU; `high` takes longer. `setup_environment` is several minutes on first run. For long tools, give `wait:true` a generous timeout or use `wait:false` and poll `check_job`.

Public Windows MCP schemas expose only TIGER Fast/High. The existing macOS/Linux schema retains MVSEP/Max and the dependency-light stub. Windows tests enable the stub explicitly; Windows source research builds must set both `STEMSTUDIO_RESEARCH_BUILD=1` and `STEMSTUDIO_ENABLE_UNLICENSED_ENGINES=1` explicitly.

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
| `probe_media` errors "Could not run ffprobe" | Confirm the installed resource path or set `STEMSTUDIO_FFPROBE`; source checkouts can install ffmpeg on PATH. |
| `setup_status` → `ready:false`, `pythonExists:false` | No venv at the resolved path. Run `setup_environment`, or set `STEMSTUDIO_PYTHON` to an existing venv python. |
| `setup_status` → `depsImportable:false` | The venv is missing `torch`/`numpy`/`soundfile`. Run `setup_environment` to (re)install `python/requirements.txt`. |
| `separate_stems` fails immediately with a worker error | The worker rejected the requested `engine`/`quality`. Use a supported engine and `fast`/`high`, or update the worker. |
| Worker can't find its package | `STEMSTUDIO_ROOT` doesn't point at a repo containing `python/stemstudio_worker/`. Set it, or run the server from within the repo. |

The server is local-only: it spawns local binaries and reads/writes local files. Nothing is exposed off-machine.
