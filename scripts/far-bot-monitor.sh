#!/usr/bin/env bash
# Мониторинг контуров far-bot: активность systemd-сервиса + свежесть heartbeat бота.
# Алерт уходит в админ-чат контура через его же BOT_TOKEN (токен/чат берутся из .env
# контура через sudo rsync — секреты не дублируются). Срабатывания дедуплицируются
# файлом состояния; при восстановлении приходит "✅ восстановлен".
# Установка: crontab -e -> */5 * * * * /home/marimysh/far-bot-monitor.sh >/dev/null 2>&1
set -u

STATE_DIR="$HOME/.far-bot-monitor"
mkdir -p "$STATE_DIR"

send_tg() { # token chat thread text
  local token=$1 chat=$2 thread=$3 text=$4
  local args=(
    -s -X POST "https://api.telegram.org/bot${token}/sendMessage"
    --data-urlencode "chat_id=${chat}"
    --data-urlencode "text=${text}"
    --max-time 20 -o /dev/null -w '%{http_code}'
  )
  [ -n "$thread" ] && args+=(--data-urlencode "message_thread_id=${thread}")
  curl "${args[@]}" || true
}

read_env() { # appdir -> BOT_TOKEN / ADMIN_CHAT / ADMIN_THREAD из .env контура
  local dir=$1 tmp
  tmp=$(mktemp)
  if ! sudo -n rsync --chmod=F644 --chown="$(id -u):$(id -g)" "$dir/.env" "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    return 1
  fi
  BOT_TOKEN=$(grep '^BOT_TOKEN=' "$tmp" | cut -d= -f2-)
  local admin
  admin=$(grep '^ADMIN_CHAT_ID=' "$tmp" | cut -d= -f2-)
  ADMIN_CHAT=$(echo "$admin" | cut -d/ -f1)
  ADMIN_THREAD=$(echo "$admin" | cut -sd/ -f2)
  rm -f "$tmp"
  [ -n "${BOT_TOKEN:-}" ] && [ -n "${ADMIN_CHAT:-}" ]
}

check() { # name service appdir
  local name=$1 svc=$2 dir=$3
  local state="$STATE_DIR/$svc.alert"
  local problem=""

  if ! systemctl is-active --quiet "$svc" 2>/dev/null; then
    problem="сервис неактивен ($(systemctl is-active "$svc" 2>/dev/null || echo unknown))"
  elif ! journalctl -u "$svc" --since "3 minutes ago" --no-pager 2>/dev/null | grep -q " heartbeat "; then
    problem="нет heartbeat более 3 минут — возможен завис"
  fi

  if [ -n "$problem" ]; then
    if [ "$(cat "$state" 2>/dev/null || true)" != "$problem" ]; then
      echo "$problem" > "$state"
      if read_env "$dir"; then
        local logs
        logs=$(journalctl -u "$svc" -n 12 --no-pager 2>/dev/null | tail -12)
        send_tg "$BOT_TOKEN" "$ADMIN_CHAT" "${ADMIN_THREAD:-}" "🚨 far-bot ($name): ${problem}"$'\n---'$'\n'"${logs:0:3500}"
      fi
    fi
  elif [ -f "$state" ]; then
    rm -f "$state"
    if read_env "$dir"; then
      send_tg "$BOT_TOKEN" "$ADMIN_CHAT" "${ADMIN_THREAD:-}" "✅ far-bot ($name): восстановлен, контур работает"
    fi
  fi
}

check PROD far-bot.service /opt/far-bot
check TEST far-bot-test.service /opt/far-bot-test
