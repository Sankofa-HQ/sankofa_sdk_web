import * as esbuild from 'esbuild';

// IIFE bundle for the plain-HTML example. Exposes `SankofaCatch` as
// the global carrying `catchPlugin` + `getCatch` + typed enums. Paired
// with the Sankofa / SankofaSwitch / SankofaConfig IIFEs on the CDN.
esbuild
  .build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    minify: true,
    sourcemap: true,
    format: 'iife',
    globalName: 'SankofaCatch',
    outfile: 'dist/sankofa-catch.min.js',
  })
  .catch(() => process.exit(1));
