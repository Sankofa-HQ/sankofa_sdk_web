import * as esbuild from 'esbuild';

// IIFE bundle for HTML consumers that don't use a bundler. Exposes
// `SankofaPulse` as the global carrying `pulsePlugin` + `getPulse`.
// Mirrors the Switch package's bundling approach so a plain-HTML
// example can `<script src="sankofa-pulse.min.js"></script>` and
// then `window.Sankofa.init({ plugins: [SankofaPulse.pulsePlugin()] })`.
esbuild
  .build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    minify: true,
    sourcemap: true,
    format: 'iife',
    globalName: 'SankofaPulse',
    outfile: 'dist/sankofa-pulse.min.js',
  })
  .catch(() => process.exit(1));
