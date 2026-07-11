# FFmpeg corresponding source

Windows installers use the BtbN GPL build from release
`autobuild-2026-06-30-13-34`, built with FFmpeg commit
`7d0e8420048cffd0ca3883b877ead2390496d0b2` and build-script commit
`7a83528ea3431e9eca982a712bc3a7cd0789d5d0`. The packaged pair is GPL-3.0-or-later
and separate from Stem Studio's Apache-2.0 source. The release audit requires
GPL/version3/x264, rejects `--enable-nonfree`, and verifies every packaged file.

macOS arm64 packages build the pair from source using
`mifi/ffmpeg-build-script@967cfb0c7d8ab000c466d00e4b6186f150ef4481`
plus `build/ffmpeg/macos-arm64-gpl.patch`. The wrapper verifies every source
archive before compiling and packages only FFmpeg, FFprobe, GPLv3 text, and
provenance. Linux has no bundled media binary and retains the documented system
FFmpeg/FFprobe requirement.

Run `node scripts/fetch-ffmpeg-source.mjs` to retrieve and verify both the exact
FFmpeg source archive and the BtbN build-script source archive. Release CI
attaches both archives, their checksums/provenance, the binary license, this
source tree, and SBOMs beside the installer. Retain them with any redistribution.
