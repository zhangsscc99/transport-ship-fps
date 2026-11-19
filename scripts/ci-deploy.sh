#!/usr/bin/env bash
# Transport Ship FPS deploy gate: build → backup → deploy → pm2 restart →
# health check → rollback on failure.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data

echo "[1/5] build client"
npm run build

echo "[2/5] backup current dist"
if [ -d server/dist ]; then
  cp -a server/dist "server/dist.bak-$(date +%s)"
  ls -1dt server/dist.bak-* 2>/dev/null | tail -n +4 | xargs -r rm -rf   # keep last 3
fi

echo "[3/5] deploy new dist"
rm -rf server/dist && cp -a dist server/dist

echo "[4/5] restart under pm2"
if pm2 describe transport-fps >/dev/null 2>&1; then
  pm2 restart transport-fps --update-env >/dev/null
else
  pm2 start ecosystem.config.cjs >/dev/null
fi
pm2 save >/dev/null 2>&1 || true

echo "[5/5] health check"
for i in $(seq 1 25); do
  if curl -sf http://127.0.0.1:3028/api/health >/dev/null; then
    echo "DEPLOY OK"
    exit 0
  fi
  sleep 1
done

echo "DEPLOY FAILED"
bash scripts/rollback.sh
exit 1
