#!/usr/bin/env bash
# Деплой контуром: deploy.sh <app-dir> <service>
# Пример: deploy.sh /opt/far-bot-test far-bot-test.service
# Код копируется с машины, на которой запущен скрипт (CI-runner), на сервер по SSH.
# .env, state.json, chats.json, digest-state.json, .deploy-notify НЕ трогаются —
# секреты и живое состояние живут только на сервере.
# Перед рестартом пишется .deploy-notify (версия + время): бот при старте шлёт
# уведомление об успешном деплое в админ-чат.
set -euo pipefail

APP_DIR="${1:?usage: deploy.sh <app-dir> <service>}"
SERVICE="${2:?usage: deploy.sh <app-dir> <service>}"
DEPLOY_USER="${DEPLOY_USER:?set DEPLOY_USER}"
DEPLOY_HOST="${DEPLOY_HOST:?set DEPLOY_HOST}"
OWNER="${DEPLOY_OWNER:-nz:nz}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

echo "== sync code to ${DEPLOY_USER}@${DEPLOY_HOST}:${APP_DIR}"
rsync -az --delete \
  --exclude .git --exclude node_modules \
  --exclude .env --exclude state.json --exclude 'state.json.tmp' --exclude chats.json \
  --exclude digest-state.json --exclude '.deploy-notify' \
  -e ssh \
  "$REPO_DIR/" "${DEPLOY_USER}@${DEPLOY_HOST}:/tmp/far-bot-deploy/"

echo "== apply to ${APP_DIR} and restart ${SERVICE}"
ssh "${DEPLOY_USER}@${DEPLOY_HOST}" bash -s -- "$APP_DIR" "$SERVICE" "$OWNER" "$SHA" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"; SERVICE="$2"; OWNER="$3"; SHA="$4"
sudo rsync -a --delete --chown="$OWNER" --chmod=D755,F644 \
  --exclude .env --exclude state.json --exclude 'state.json.tmp' --exclude chats.json \
  --exclude digest-state.json --exclude '.deploy-notify' \
  /tmp/far-bot-deploy/ "$APP_DIR/"
rm -rf /tmp/far-bot-deploy
# Marker для бота: при старте шлёт в админ-чат «версия задеплоена» и удаляет файл.
# Только rsync/systemctl через sudo — остальное в /tmp без привилегий.
printf 'version=%s service=%s deployed_at=%s\n' "$SHA" "$SERVICE" "$(date -Is)" > /tmp/far-bot-deploy-notify
sudo rsync --chmod=F644 --chown="$OWNER" /tmp/far-bot-deploy-notify "$APP_DIR/.deploy-notify"
rm -f /tmp/far-bot-deploy-notify
sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE"
sudo systemctl is-active --quiet "$SERVICE"
echo "== deployed: $(systemctl is-active "$SERVICE") $SERVICE"
REMOTE

echo "== ok"
