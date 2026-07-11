# Modification notice

This derivative preserves the original Apache-2.0 `LICENSE`, `NOTICE`, Sam
Wasserman attribution, and citation metadata.

Frozen upstream implementation base:
`fa1bcd092cecca891cb6192d805999165df351e7`.

Windows support contributed and maintained by **Gumbii Digital**
([github.com/GumbiiDigital](https://github.com/GumbiiDigital)). These
modifications include native
Windows window/installer behavior, private uv-managed Python, bundled
FFmpeg/FFprobe resolution, Windows-safe paths and process cancellation,
packaged MCP runtime discovery, dependency and model pinning, and
Windows-only public-build licensing gates that leave the existing
macOS/Linux engine behavior unchanged. Generic changes live on
`feature/windows-port`; derivative identity and release branding are kept out
of this branch. The installed Windows MCP launcher is invoked through an
argument-safe command-processor contract and is tested from nested paths with
spaces, apostrophes, and Unicode.

Modified source, configuration, test, and documentation files whose syntax
permits comments carry a file-level notice pointing back to this manifest.
The following modified files cannot carry comments without becoming invalid
or changing their defined plain-text format, so this manifest is their
file-level modification notice:

- `package.json`
- `package-lock.json`
- `mcp/package.json`
- `mcp/package-lock.json`
- `NOTICE`

The renderer preview protocol is CORS-enabled as a privileged Electron scheme
and adds explicit cross-origin response headers while retaining absolute-path
validation and streamed file responses. A packaged-app regression exercises
real WAV files below a nested path containing spaces, an apostrophe, and
Unicode; it verifies protocol fetch, Web Audio decoding, four non-transparent
waveform canvases, and the platform-correct Show-in-Folder action.

Stable/commercial distribution remains gated on upstream/trademark permission,
platform code signing, final FFmpeg/H.264 counsel review, and the ordinary
third-party dependency/model review. Stem Studio source and app code are
Apache-2.0; packaged FFmpeg/FFprobe are separate GPL components; uv, TIGER
code, TIGER weights, and managed-Python packages retain their own notices.
