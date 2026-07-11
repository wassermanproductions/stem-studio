# Third-party notices

Stem Studio remains Apache-2.0 source software. Packaged installers also carry
separately licensed components; an installer must not be described as
Apache-only.

- **FFmpeg and FFprobe for Windows**, BtbN GPL build
  `autobuild-2026-06-30-13-34`, FFmpeg commit
  `7d0e8420048cffd0ca3883b877ead2390496d0b2`, GPL-3.0-or-later. Native
  Windows preparation verifies the archive, both executables, license, required
  GPL configure flags, and absence of `--enable-nonfree`.
- **FFmpeg and FFprobe for macOS arm64**, source-built from FFmpeg commit
  `7d0e8420048cffd0ca3883b877ead2390496d0b2` using the pinned
  `mifi/ffmpeg-build-script` commit plus the committed portable-GPL patch. The
  build verifies source hashes, GPL/version3/x264 flags, no nonfree/OpenSSL,
  system-only dylinks, and H.264/AAC operation. Linux preserves its upstream
  behavior: no media binary is bundled and FFmpeg/FFprobe resolve from an
  explicit override, known system locations, or `PATH`.
- **uv 0.11.28**, Apache-2.0 or MIT. The Windows release archive is verified
  before packaging and its Apache license is shipped beside `uv.exe`.
- **TIGER model code**, MIT, vendored under
  `python/stemstudio_worker/vendor/tiger/` with its license.
- **TIGER-DnR model weights**, Apache-2.0, downloaded on first use from the
  pinned revision and verified against the hashes in `assets-manifest.json`.

The MVSEP checkpoint is not distributed, downloaded, or exposed by public
builds because its repository does not state an adequate model license.

## Bundled JavaScript runtime packages

The following list is generated from the exact root and MCP lockfiles. It
includes the renderer libraries compiled into the app and every production
dependency compiled into the standalone MCP bridge.

<!-- BEGIN GENERATED JAVASCRIPT RUNTIME PACKAGES -->
| Package | Version | License | Bundled in |
|---|---:|---|---|
| @hono/node-server | 1.19.14 | MIT | MCP |
| @modelcontextprotocol/sdk | 1.29.0 | MIT | MCP |
| accepts | 2.0.0 | MIT | MCP |
| ajv | 8.20.0 | MIT | MCP |
| ajv-formats | 3.0.1 | MIT | MCP |
| body-parser | 2.3.0 | MIT | MCP |
| bytes | 3.1.2 | MIT | MCP |
| call-bind-apply-helpers | 1.0.2 | MIT | MCP |
| call-bound | 1.0.4 | MIT | MCP |
| content-disposition | 1.1.0 | MIT | MCP |
| content-type | 1.0.5 | MIT | MCP |
| content-type | 2.0.0 | MIT | MCP |
| cookie | 0.7.2 | MIT | MCP |
| cookie-signature | 1.2.2 | MIT | MCP |
| cors | 2.8.6 | MIT | MCP |
| cross-spawn | 7.0.6 | MIT | MCP |
| debug | 4.4.3 | MIT | MCP |
| depd | 2.0.0 | MIT | MCP |
| dunder-proto | 1.0.1 | MIT | MCP |
| ee-first | 1.1.1 | MIT | MCP |
| encodeurl | 2.0.0 | MIT | MCP |
| es-define-property | 1.0.1 | MIT | MCP |
| es-errors | 1.3.0 | MIT | MCP |
| es-object-atoms | 1.1.2 | MIT | MCP |
| escape-html | 1.0.3 | MIT | MCP |
| etag | 1.8.1 | MIT | MCP |
| eventsource | 3.0.7 | MIT | MCP |
| eventsource-parser | 3.1.0 | MIT | MCP |
| express | 5.2.1 | MIT | MCP |
| express-rate-limit | 8.5.2 | MIT | MCP |
| fast-deep-equal | 3.1.3 | MIT | MCP |
| fast-uri | 3.1.3 | BSD-3-Clause | MCP |
| finalhandler | 2.1.1 | MIT | MCP |
| forwarded | 0.2.0 | MIT | MCP |
| fresh | 2.0.0 | MIT | MCP |
| function-bind | 1.1.2 | MIT | MCP |
| get-intrinsic | 1.3.0 | MIT | MCP |
| get-proto | 1.0.1 | MIT | MCP |
| gopd | 1.2.0 | MIT | MCP |
| has-symbols | 1.1.0 | MIT | MCP |
| hasown | 2.0.4 | MIT | MCP |
| hono | 4.12.28 | MIT | MCP |
| http-errors | 2.0.1 | MIT | MCP |
| iconv-lite | 0.7.3 | MIT | MCP |
| inherits | 2.0.4 | ISC | MCP |
| ip-address | 10.2.0 | MIT | MCP |
| ipaddr.js | 1.9.1 | MIT | MCP |
| is-promise | 4.0.0 | MIT | MCP |
| isexe | 2.0.0 | ISC | MCP |
| jose | 6.2.3 | MIT | MCP |
| json-schema-traverse | 1.0.0 | MIT | MCP |
| json-schema-typed | 8.0.2 | BSD-2-Clause | MCP |
| math-intrinsics | 1.1.0 | MIT | MCP |
| media-typer | 1.1.0 | MIT | MCP |
| merge-descriptors | 2.0.0 | MIT | MCP |
| mime-db | 1.54.0 | MIT | MCP |
| mime-types | 3.0.2 | MIT | MCP |
| ms | 2.1.3 | MIT | MCP |
| negotiator | 1.0.0 | MIT | MCP |
| object-assign | 4.1.1 | MIT | MCP |
| object-inspect | 1.13.4 | MIT | MCP |
| on-finished | 2.4.1 | MIT | MCP |
| once | 1.4.0 | ISC | MCP |
| parseurl | 1.3.3 | MIT | MCP |
| path-key | 3.1.1 | MIT | MCP |
| path-to-regexp | 8.4.2 | MIT | MCP |
| pkce-challenge | 5.0.1 | MIT | MCP |
| proxy-addr | 2.0.7 | MIT | MCP |
| qs | 6.15.3 | BSD-3-Clause | MCP |
| range-parser | 1.3.0 | MIT | MCP |
| raw-body | 3.0.2 | MIT | MCP |
| react | 18.3.1 | MIT | app |
| react-dom | 18.3.1 | MIT | app |
| require-from-string | 2.0.2 | MIT | MCP |
| router | 2.2.0 | MIT | MCP |
| safer-buffer | 2.1.2 | MIT | MCP |
| scheduler | 0.23.2 | MIT | app |
| send | 1.2.1 | MIT | MCP |
| serve-static | 2.2.1 | MIT | MCP |
| setprototypeof | 1.2.0 | ISC | MCP |
| shebang-command | 2.0.0 | MIT | MCP |
| shebang-regex | 3.0.0 | MIT | MCP |
| side-channel | 1.1.1 | MIT | MCP |
| side-channel-list | 1.0.1 | MIT | MCP |
| side-channel-map | 1.0.1 | MIT | MCP |
| side-channel-weakmap | 1.0.2 | MIT | MCP |
| statuses | 2.0.2 | MIT | MCP |
| toidentifier | 1.0.1 | MIT | MCP |
| type-is | 2.1.0 | MIT | MCP |
| unpipe | 1.0.0 | MIT | MCP |
| vary | 1.1.2 | MIT | MCP |
| which | 2.0.2 | ISC | MCP |
| wrappy | 1.0.2 | ISC | MCP |
| zod | 4.4.3 | MIT | MCP |
| zod-to-json-schema | 3.25.2 | ISC | MCP |
| zustand | 5.0.14 | MIT | app |
<!-- END GENERATED JAVASCRIPT RUNTIME PACKAGES -->
