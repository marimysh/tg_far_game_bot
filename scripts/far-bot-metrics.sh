#!/usr/bin/env bash
# Сбор метрик контуров far-bot для дашборда. Вывод: JSON в stdout.
# Запускается на VDS от пользователя с доступом к journalctl (marimysh), sudo не нужен.
# Ошибки классифицируются строго в один тип (приоритет сверху вниз):
#   network  — нет ответа от хоста вообще (fetch failed): не отличить, кто не ответил,
#              это сетевой уровень (и Telegram, и Google могли не ответить);
#   telegram — HTTP-ответ от Bot API (Telegram ... failed: HTTP ...);
#   sheets   — HTTP-ответ Google Sheets API (Sheets API ... failed: HTTP ...);
#   internal — всё остальное (ошибки логики бота, валидации и пр.).
# Формат пригоден и для zabbix UserParameter в будущем.
set -u

LOGS_SINCE_1H="1 hour ago"
LOGS_SINCE_24H="24 hours ago"

# Один проход по журналу: "net tg sheets internal"
classify() { # service since
  journalctl -u "$1" --since "$2" --no-pager 2>/dev/null | awk '
    /poll error/ && /fetch failed/ { net++; next }
    / ERROR / {
      if (/fetch failed/) { net++; next }
      if (/Telegram/)     { tg++; next }
      if (/Sheets API/ || /digest read error/ || /sheets\.js/) { sheets++; next }
      internal++; next
    }
    END { printf "%d %d %d %d", net+0, tg+0, sheets+0, internal+0 }'
}

errors_json() { # service since
  read -r net tg sheets internal <<<"$(classify "$1" "$2")"
  local total=$(( net + tg + sheets + internal ))
  printf '{"total":%s,"internal":%s,"telegram":%s,"sheets":%s,"network":%s}' \
    "$total" "$internal" "$tg" "$sheets" "$net"
}

contour_json() { # name service appdir
  local name=$1 svc=$2 appdir=$3
  local active uptime enter_ts

  active=$(systemctl is-active "$svc" 2>/dev/null || echo unknown)
  enter_ts=$(systemctl show -p ActiveEnterTimestamp --value "$svc" 2>/dev/null || true)
  if [ "$active" = "active" ] && [ -n "$enter_ts" ] && [ "$enter_ts" != "n/a" ]; then
    uptime=$(( $(date +%s) - $(date -d "$enter_ts" +%s 2>/dev/null || echo 0) ))
  else
    uptime=0
  fi

  printf ',"%s":{"service":"%s","uptime_sec":%s,"errors_1h":%s,"errors_24h":%s}' \
    "$name" "$active" "$uptime" "$(errors_json "$svc" "$LOGS_SINCE_1H")" "$(errors_json "$svc" "$LOGS_SINCE_24H")"
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
