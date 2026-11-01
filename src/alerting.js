// Ring-buffer логов и алертер в админ-группу.
// Алерт = заголовок + текст ошибки + контекст + последние строки лога.
// Троттлинг: чаще throttleMs не шлём, но копим число пропущенных ошибок и
// показываем его в следующем алерте.

export function createLogBuffer(size = 200) {
  const lines = [];
  return {
    add(line) {
      lines.push(String(line));
      if (lines.length > size) lines.shift();
    },
    tail(n = 30) {
      return lines.slice(-n);
    },
  };
}

export function createAlerter({ tg, chatId, threadId, logBuffer, throttleMs = 5 * 60 * 1000, log }) {
  let lastAlert = 0;
  let suppressed = 0;

  return function alert(err, context = '') {
    log?.('ERROR', err);
    if (!chatId) return;
    const now = Date.now();
    if (now - lastAlert < throttleMs) {
      suppressed++;
      return;
    }
    lastAlert = now;
    const header = suppressed > 0 ? `⚠️ far-bot: ошибок с прошлого алерта — ${suppressed + 1}. Последняя:` : '⚠️ far-bot ошибка:';
    suppressed = 0;
    const text = [
      header,
      `<code>${String(err?.stack ?? err).slice(0, 500)}</code>`,
      context ? `<code>${String(context).slice(0, 200)}</code>` : '',
      '',
      '<b>последние логи:</b>',
      ...logBuffer.tail(30).map((l) => `<code>${l.slice(0, 400)}</code>`),
    ]
      .filter(Boolean)
      .join('\n');
    tg.sendMessage(chatId, text, { threadId: threadId || undefined }).catch(() => {});
  };
}
