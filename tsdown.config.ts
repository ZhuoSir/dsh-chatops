import { defineConfig } from 'tsdown'

// Host half: one ESM bundle at package root (main: index.js). All
// @deepseek-ai/* packages stay external — they are provided by the DSH
// profile the plugin installs into. wechaty / puppets stay external too:
// they are optional dependencies loaded lazily so the plugin still loads
// (and shows install guidance) when they are absent.
export default defineConfig({
  entry: { index: 'src/host/index.ts' },
  format: ['esm'],
  platform: 'node',
  outDir: '.',
  // The bundle lands at the package root (main: index.js), so cleaning the
  // outDir would mean cleaning the package itself — always off.
  clean: false,
  // Emit index.js (not index.mjs) to match package.json "main".
  fixedExtension: false,
  minify: false,
  sourcemap: false,
  external: [/^@deepseek-ai\//, 'wechaty', /^wechaty-puppet-/, 'qrcode-terminal'],
})
