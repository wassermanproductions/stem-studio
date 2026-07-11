# Windows 11 x64 VM acceptance checklist

Use a clean Windows 11 x64 VM with no system Python, FFmpeg, or FFprobe on
`PATH`. Record the installer SHA-256, VM build, app version, and exact machines
tested in the release evidence.

- Verify the published `SHA256SUMS` before launch. For the unsigned prerelease,
  confirm SmartScreen shows the expected unknown-publisher flow and document
  **More info → Run anyway**; any different warning is a failure.
- Run a Microsoft Defender custom scan against the installer and installed
  directory; record a clean result or the exact detection.
- Install per-user without elevation into the default path, then repeat with a
  selectable nested path containing spaces, an apostrophe, Unicode, and
  `OneDrive - Studio`. Verify Start Menu and desktop shortcuts.
- At 100% and 150% display scaling, verify native Windows controls, usable
  layout, correct icon, taskbar grouping, and the generic/community identity.
- Confirm **Show in Folder** opens File Explorer and selects each delivered WAV
  and optional multitrack MOV.
- With system Python/FFmpeg removed from `PATH`, run first-use setup: 6 GB
  preflight, progress, cancel/resume, explicit **Repair private runtime**, CPU
  fallback, and atomic readiness must all behave as documented.
- Run the primary flow on video and audio from the nested OneDrive-style path.
  Verify four 48 kHz/24-bit sample-aligned WAVs, mixture consistency, waveform
  preview, labelled Dialogue/Music/SFX MOV tracks, and no orphaned processes
  after cancellation.
- Uninstall silently and interactively. Verify application files and shortcuts
  are removed, while the distinct per-user data root is intentionally retained;
  generic and derivative builds must never overwrite each other.

Windows native CI automates resource, stripped-`PATH`, silent install/launch/
uninstall, shortcut, best-effort Defender, nested-path stub, and process checks. Scaling,
SmartScreen interaction, full managed TIGER primary flow, and visual File
Explorer/taskbar behavior remain manual release acceptance.
