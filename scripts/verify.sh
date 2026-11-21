#!/usr/bin/env bash
# Local verify gate: typecheck → unit tests → build → health check.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/4] tsc --noEmit"
npx tsc --noEmit

echo "[2/4] unit tests"
bash scripts/build-tests.sh
node --test src/game/*.test.js

echo "[3/4] vite build"
npm run build

echo "[4/4] health check"
curl -sf http://127.0.0.1:3028/api/health
echo
echo "VERIFY OK"
