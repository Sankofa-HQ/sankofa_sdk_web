import * as esbuild from 'esbuild'

esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'iife',
  globalName: 'Sankofa',
  outfile: 'dist/sankofa.min.js',
}).catch(() => process.exit(1))
