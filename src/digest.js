export function buildDigestText(sortedActualRows) {
  const sections = ['Стройка', 'Исследование']
    .map((type) => {
      const lines = sortedActualRows
        .filter((r) => r['Тип'] === type)
        .map((r) => `<code>${r['Ник']}</code> Осталось: ${r['Осталось дней']} д из ${r['Изначально']} д`);
      return lines.length ? `<b>${type === 'Исследование' ? 'Исследования' : type}</b>\n\n${lines.join('\n')}` : null;
    })
    .filter(Boolean);
  return sections.join('\n\n');
}

export function startDigest({ getQueueApi, chats, tg, config, log }) {
  const lastHashes = new Map(); // key топика -> хеш очереди

  async function tickEntry(entry) {
    let queue;
    try {
      queue = await getQueueApi(entry.spreadsheetId).readQueue();
    } catch (e) {
      log('digest read error', e);
      return;
    }
    const queueApi = getQueueApi(entry.spreadsheetId);
    const actual = queueApi.actualRows(queue);
    const sorted = [...actual].sort((a, b) => Date.parse(a['Время добавления']) - Date.parse(b['Время обновления']));
    const hash = JSON.stringify(
      sorted.map((r) => [r._row, r['Ник'], r['Тип'], r['Статус'], r['Осталось дней'], r['Время обновления']]),
    );
    if (hash === lastHashes.get(entry.key)) return;
    lastHashes.set(entry.key, hash);
    if (sorted.length === 0) return;
    try {
      await tg.sendMessage(entry.chatId, buildDigestText(sorted), {
        threadId: entry.threadId || undefined,
        keyboard: [],
      });
      log('digest sent', { chatId: entry.chatId, key: entry.key, rows: sorted.length });
    } catch (e) {
      log('digest send error', e);
    }
  }

  async function tick() {
    const entries = chats.all().filter((c) => c.spreadsheetId && c.allowed !== false && c.chatId);
    for (const entry of entries) await tickEntry(entry);
  }

  setTimeout(() => tick(), 5000).unref?.();
  setInterval(() => tick(), config.digest.pollSec * 1000).unref?.();
}
