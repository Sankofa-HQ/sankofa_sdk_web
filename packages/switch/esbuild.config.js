import * as esbuild from 'esbuild';

// IIFE bundle for the plain-HTML example. Exposes `SankofaSwitch` as
// the global that carries `switchPlugin` + `getSwitch`. The existing
// browser IIFE uses `Sankofa`; this package ships under its own global
// so HTML consumers can `window.SankofaSwitch.switchPlugin(...)` and
// pass the result to `Sankofa.init({ plugins: [...] })`.
esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'iife',
  globalName: 'SankofaSwitch',
  outfile: 'dist/sankofa-switch.min.js',
}).catch(() => process.exit(1));
