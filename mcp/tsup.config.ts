import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Keep the built bin runnable directly (`node dist/index.js`) and via the
  // `stem-studio-mcp` bin shim; the shebang makes it executable on PATH too.
  banner: { js: '#!/usr/bin/env node' },
  splitting: false,
  dts: false
})
