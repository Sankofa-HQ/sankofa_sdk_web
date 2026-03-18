import * as esbuild from 'esbuild'

esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'iife',
  globalName: 'SankofaReplay',
  external: ['@sankofa/browser'], // Avoid doubling up the core SDK if already loaded
  outfile: 'dist/sankofa-replay.min.js',
}).catch(() => process.exit(1))
