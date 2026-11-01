#!/usr/bin/env bash
# Деплой контуром: deploy.sh <app-dir> <service>
# Пример: deploy.sh /opt/far-bot-test far-bot-test.service
# Код копируется с машины, на которой запущен скрипт (CI-runner), на сервер по SSH.
# .env, state.json и chats.json НЕ трогаются — секреты и живое состояние живут только на сервере.
set -euo pipefail

APP_DIR="${1:?usage: deploy.sh <app-dir> <service>}"
SERVICE="${2:?usage: deploy.sh <app-dir> <service>}"
DEPLOY_USER="${DEPLOY_USER:?set DEPLOY_USER}"
DEPLOY_HOST="${DEPLOY_HOST:?set DEPLOY_HOST}"
OWNER="${DEPLOY_OWNER:-nz:nz}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "== sync code to ${DEPLOY_USER}@${DEPLOY_HOST}:${APP_DIR}"
rsync -az --delete \
  --exclude .git --exclude node_modules \
  --exclude .env --exclude state.json --exclude 'state.json.tmp' --exclude chats.json \
  -e ssh \
  "$REPO_DIR/" "${DEPLOY_USER}@${DEPLOY_HOST}:/tmp/far-bot-deploy/"

echo "== apply to ${APP_DIR} and restart ${SERVICE}"
ssh "${DEPLOY_USER}@${DEPLOY_HOST}" bash -s -- "$APP_DIR" "$SERVICE" "$OWNER" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"; SERVICE="$2"; OWNER="$3"
sudo rsync -a --delete --chown="$OWNER" --chmod=D755,F644 \
  --exclude .env --exclude state.json --exclude 'state.json.tmp' --exclude chats.json \
  /tmp/far-bot-deploy/ "$APP_DIR/"
rm -rf /tmp/far-bot-deploy
sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE"
sudo systemctl is-active --quiet "$SERVICE"
echo "== deployed: $(systemctl is-active "$SERVICE") $SERVICE"
REMOTE

echo "== ok"
