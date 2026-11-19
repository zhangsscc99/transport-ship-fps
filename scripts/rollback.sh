#!/usr/bin/env bash
# Restore the most recent dist backup and restart the server.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data

latest=$(ls -dt server/dist.bak-* 2>/dev/null | head -1 || true)
if [ -z "$latest" ]; then
  echo "ROLLBACK FAILED: no server/dist.bak-* backup found"
  exit 1
fi

echo "restoring $latest"
rm -rf server/dist
cp -a "$latest" server/dist

if pm2 describe transport-fps >/dev/null 2>&1; then
  pm2 restart transport-fps --update-env >/dev/null
else
  pm2 start ecosystem.config.cjs >/dev/null
fi

for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:3028/api/health >/dev/null; then echo "ROLLBACK OK"; exit 0; fi
  sleep 1
done
echo "ROLLBACK FAILED: server did not come up"
exit 1
