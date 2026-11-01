export function buildDigestText(sortedActualRows) {
  const sections = ['Стройка', 'Исследование']
    .map((type) => {
      const lines = sortedActualRows
        .filter((r) => r['Тип'] === type)
        .map((r) => `<code>${r['Ник']}</code> Осталось: ${r['Осталось дней']} д из ${r['Изначально']} д`);
      return lines.length ? `<b>${type === 'Исследование' ? 'Исследования' : type}</b>\n\n${lines.join('\n')}` : null;
    })
    .filter(Boolean);
  return sections.join('\n');
}

export function startDigest({ queueApi, tg, config, log }) {
  let lastHash = null;

  async function tick() {
    let queue;
    try {
      queue = await queueApi.readQueue();
    } catch (e) {
      log('digest read error', e);
      return;
    }
    const actual = queueApi.actualRows(queue);
    const sorted = [...actual].sort((a, b) => Date.parse(a['Время добавления']) - Date.parse(b['Время добавления']));
    const hash = JSON.stringify(
      sorted.map((r) => [r._row, r['Ник'], r['Тип'], r['Статус'], r['Осталось дней'], r['Время обновления']]),
    );
    if (hash === lastHash) return;
    lastHash = hash;
    if (sorted.length === 0) return;
    try {
      await tg.sendMessage(config.digest.chatId, buildDigestText(sorted), {
        threadId: config.digest.threadId || undefined,
        keyboard: [],
      });
      log('digest sent', { chatId: config.digest.chatId, rows: sorted.length });
    } catch (e) {
      log('digest send error', e);
    }
  }

  setTimeout(() => tick(), 5000).unref?.();
  setInterval(() => tick(), config.digest.pollSec * 1000).unref?.();
}
