#!/usr/bin/env node
// Ensure every browser-facing package ships its IIFE/global min bundle in
// the published tarball. Adds a `prepublishOnly` that runs tsc + esbuild so
// `dist/*.min.js` is always fresh at publish time (jsDelivr serves it).
// react has no IIFE build (it targets bundlers), so it is left untouched.
// Idempotent.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKGS = join(ROOT, 'packages');
const BUNDLED = ['browser', 'catch', 'config', 'switch', 'pulse', 'replay-rrweb'];

const log = [];
for (const p of BUNDLED) {
  const dir = join(PKGS, p);
  if (!existsSync(join(dir, 'esbuild.config.js'))) {
    log.push(`${p}: SKIP (no esbuild.config.js)`);
    continue;
  }
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.scripts ||= {};
  if (!pkg.scripts.bundle) pkg.scripts.bundle = 'node esbuild.config.js';
  pkg.scripts.prepublishOnly = 'npm run build && npm run bundle';
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  log.push(`${p}: prepublishOnly = "${pkg.scripts.prepublishOnly}"`);
}
console.log(log.join('\n'));
console.log('\nDONE wiring ' + BUNDLED.length + ' packages.');
