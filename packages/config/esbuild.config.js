import * as esbuild from 'esbuild';

// IIFE bundle for the HTML example — exposes `SankofaConfig` global
// carrying `configPlugin` + `getConfig`. Paired with the
// SankofaSwitch IIFE + the main Sankofa IIFE.
esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'iife',
  globalName: 'SankofaConfig',
  outfile: 'dist/sankofa-config.min.js',
}).catch(() => process.exit(1));
