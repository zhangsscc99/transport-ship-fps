#!/usr/bin/env bash
# Bundle each *.test.ts into a runnable *.test.js next to it (game code
# inlined, node builtins external) because src/**/*.ts uses bundler-style
# extensionless imports that Node's ESM loader cannot execute directly.
# Output is committed so `node --test src/game/*.test.js` works without a
# build step.
set -euo pipefail
cd "$(dirname "$0")/.."

shopt -s nullglob globstar
files=(src/**/*.test.ts)
if [ ${#files[@]} -eq 0 ]; then
  echo "no *.test.ts files found" >&2
  exit 1
fi

for f in "${files[@]}"; do
  npx esbuild "$f" --bundle --platform=node --format=esm --outfile="${f%.ts}.js"
done

# Do not rely on `node --test <dir>` or generate a directory-entry index.js
# shim: Node 26+ scans <dir> for *.test.ts too and fails on extensionless
# imports. Always invoke the built bundles explicitly:
#   node --test src/game/*.test.js
dirs=$(printf '%s\n' "${files[@]}" | xargs -n1 dirname | sort -u)
echo "built test bundles: ${dirs//$'\n'/, }/*.test.js"
