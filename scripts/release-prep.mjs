#!/usr/bin/env node
// Release prep for the Sankofa Web SDK monorepo.
// - bumps every package to TARGET_VERSION
// - repins internal @sankofa/* deps to TARGET_VERSION
// - ensures license, description, repository metadata
// - writes an MIT LICENSE into every package
// - writes a minimal README where one is missing
// Idempotent: safe to re-run.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKGS = join(ROOT, 'packages');
const TARGET_VERSION = '0.2.0';
const YEAR = 2026;
const HOLDER = 'Sankofa HQ';
const REPO = 'https://github.com/Sankofa-HQ/sankofa_sdk_web';

const DESCRIPTIONS = {
  '@sankofa/browser': 'Sankofa Web SDK — privacy-first product analytics, event tracking, and identity for the browser. Self-hosted and open source.',
  '@sankofa/catch': 'Sankofa Catch — JavaScript error tracking, crash reporting, breadcrumbs, and Web Vitals for the browser.',
  '@sankofa/config': 'Sankofa Config — type-safe remote configuration for web apps.',
  '@sankofa/switch': 'Sankofa Switch — feature flags, A/B testing, and progressive rollouts for the browser.',
  '@sankofa/pulse': 'Sankofa Pulse — in-app surveys, NPS, and CSAT feedback for web apps.',
  '@sankofa/replay-rrweb': 'Sankofa Session Replay — rrweb-powered session recording and heatmaps for the browser.',
  '@sankofa/react': 'Sankofa React — provider and hooks bindings for the Sankofa Web SDK.',
};

const MIT = `MIT License

Copyright (c) ${YEAR} ${HOLDER}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// Rebuild each package.json with a clean, conventional key order.
function reorder(pkg) {
  const order = [
    'name', 'version', 'description', 'license', 'author', 'homepage',
    'repository', 'bugs', 'keywords', 'type', 'main', 'module', 'types',
    'exports', 'files', 'sideEffects', 'scripts', 'dependencies',
    'peerDependencies', 'devDependencies', 'publishConfig',
  ];
  const out = {};
  for (const k of order) if (k in pkg) out[k] = pkg[k];
  for (const k of Object.keys(pkg)) if (!(k in out)) out[k] = pkg[k];
  return out;
}

const dirs = readdirSync(PKGS).filter((d) => existsSync(join(PKGS, d, 'package.json')));
const changed = [];

for (const d of dirs) {
  const dir = join(PKGS, d);
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  pkg.version = TARGET_VERSION;
  if (DESCRIPTIONS[pkg.name]) pkg.description = DESCRIPTIONS[pkg.name];
  pkg.license = 'MIT';
  if (!pkg.repository) pkg.repository = { type: 'git', url: REPO };
  // Scoped packages must be published with public access.
  pkg.publishConfig = { access: 'public' };

  // Repin internal workspace deps to the target version.
  for (const field of ['dependencies', 'peerDependencies']) {
    if (!pkg[field]) continue;
    for (const dep of Object.keys(pkg[field])) {
      if (dep.startsWith('@sankofa/')) pkg[field][dep] = TARGET_VERSION;
    }
  }

  writeFileSync(pkgPath, JSON.stringify(reorder(pkg), null, 2) + '\n');

  // LICENSE in every package so it ships in the tarball.
  writeFileSync(join(dir, 'LICENSE'), MIT);

  // Minimal README if missing.
  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) {
    writeFileSync(
      readmePath,
      `# ${pkg.name}\n\n${pkg.description || ''}\n\nPart of the [Sankofa Web SDK](${REPO}).\n\n## License\n\nMIT\n`,
    );
    changed.push(`${pkg.name}: created README.md`);
  }

  changed.push(`${pkg.name} -> ${TARGET_VERSION} (license, description, publishConfig, LICENSE)`);
}

console.log(changed.join('\n'));
console.log('\nDONE: prepped ' + dirs.length + ' packages.');
