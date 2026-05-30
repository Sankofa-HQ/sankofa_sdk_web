#!/usr/bin/env bash
# Publish the Sankofa Web SDK to npm.
# Run release-prep first (bumps versions, metadata, LICENSE), then this.
#
#   node scripts/release-prep.mjs
#   bash scripts/publish.sh            # dry run by default
#   bash scripts/publish.sh --live     # actually publish
#
# Requires: npm login (with 2FA) beforehand.
set -euo pipefail
cd "$(dirname "$0")/.."

LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

# Publish in dependency order: browser first (everything depends on it),
# pulse before react (react depends on pulse).
ORDER=(browser catch config switch pulse replay-rrweb react)

echo "==> Verifying npm auth"
npm whoami || { echo "Not logged in. Run: npm login"; exit 1; }

echo "==> Building all packages"
npm run build

echo "==> Versions to publish:"
for p in "${ORDER[@]}"; do
  v=$(node -p "require('./packages/$p/package.json').version")
  name=$(node -p "require('./packages/$p/package.json').name")
  printf '    %-26s %s\n' "$name" "$v"
done

for p in "${ORDER[@]}"; do
  dir="packages/$p"
  name=$(node -p "require('./$dir/package.json').name")
  if [ "$LIVE" -eq 1 ]; then
    echo "==> Publishing $name (live)"
    ( cd "$dir" && npm publish --access public )
  else
    echo "==> Dry run $name"
    ( cd "$dir" && npm publish --access public --dry-run )
  fi
done

echo "==> Done. $([ "$LIVE" -eq 1 ] && echo 'Published.' || echo 'Dry run only — re-run with --live to publish.')"
