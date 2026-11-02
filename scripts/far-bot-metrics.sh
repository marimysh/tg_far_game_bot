#!/usr/bin/env bash
# Сбор метрик контуров far-bot для дашборда. Вывод: JSON в stdout.
# Запускается на VDS от пользователя с доступом к journalctl (marimysh), sudo не нужен.
# Классификация ошибок из journal за окно:
#   telegram — сбои опроса/отправки Telegram (pollLoop, стек src/tg.js, "poll error")
#   sheets   — ошибки Google Sheets API ("Sheets API" в тексте ошибки)
#   network  — потери пинга до шлюза (или 1.1.1.1) на момент замера
# Формат пригоден и для zabbix UserParameter (Low-level discovery не требуется).
set -u

LOGS_SINCE_1H="1 hour ago"
LOGS_SINCE_24H="24 hours ago"

count_re() { # text pattern -> count
  printf '%s\n' "$1" | grep -c "$2" 2>/dev/null || true
}

contour_json() { # name service appdir
  local name=$1 svc=$2 appdir=$3
  local active uptime blk err_1h err_24h tg_1h sheets_1h

  active=$(systemctl is-active "$svc" 2>/dev/null || echo unknown)
  local enter_ts
  enter_ts=$(systemctl show -p ActiveEnterTimestamp --value "$svc" 2>/dev/null || true)
  if [ "$active" = "active" ] && [ -n "$enter_ts" ] && [ "$enter_ts" != "n/a" ]; then
    uptime=$(( $(date +%s) - $(date -d "$enter_ts" +%s 2>/dev/null || echo 0) ))
  else
    uptime=0
  fi

  blk=$(journalctl -u "$svc" --since "$LOGS_SINCE_1H" --no-pager 2>/dev/null)
  err_1h=$(count_re "$blk" ' ERROR ')
  # telegram: подавленные "poll error" + реальные fetch failed со стеком tg.js
  tg_1h=$(( $(count_re "$blk" 'poll error') + $(printf '%s\n' "$blk" | grep -A3 ' ERROR .*fetch failed' | grep -c 'src/tg\.js' 2>/dev/null || true) ))
  sheets_1h=$(printf '%s\n' "$blk" | grep ' ERROR ' | grep -c 'Sheets API' 2>/dev/null || true)

  err_24h=$(journalctl -u "$svc" --since "$LOGS_SINCE_24H" --no-pager 2>/dev/null | grep -c ' ERROR ' 2>/dev/null || true)

  printf ',"%s":{"service":"%s","uptime_sec":%s,"errors_1h":%s,"errors_24h":%s,"telegram_errors_1h":%s,"sheets_errors_1h":%s}' \
    "$name" "$active" "$uptime" "$err_1h" "$err_24h" "$tg_1h" "$sheets_1h"
}

gw=$(ip route show default 2>/dev/null | awk 'NR==1 {print $3}')
target=${gw:-1.1.1.1}
ping_out=$(ping -c 10 -i 0.2 -W 1 "$target" 2>/dev/null || true)
loss=$(printf '%s\n' "$ping_out" | awk -F', ' '/packet loss/ {for(i=1;i<=NF;i++) if (match($i, /[0-9.]+%/)) {print substr($i, RSTART, RLENGTH-1); exit}}')
avg=$(printf '%s\n' "$ping_out" | awk -F'/' '/rtt|round-trip/ {print $5}')
[ -n "${loss:-}" ] || loss=-1
[ -n "${avg:-}" ] || avg=-1
net_status=ok
awk "BEGIN{exit !($loss >= 20)}" && net_status=problem

printf '{"generated_at":"%s","network":{"target":"%s","loss_pct":%s,"avg_ms":%s,"status":"%s"}' \
  "$(date -Is)" "$target" "$loss" "$avg" "$net_status"
contour_json prod far-bot.service /opt/far-bot
contour_json test far-bot-test.service /opt/far-bot-test
printf '}\n'
