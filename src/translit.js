// Транслитерация названий групп для имён таблиц: «FAR Помощь» -> «far_pomoshch».
// Пробелы -> _, остальное не [a-z0-9_] выбрасывается, нижний регистр.

const MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

export function translit(title) {
  const out = [];
  for (const ch of String(title ?? '').toLowerCase()) {
    if (ch === ' ') out.push('_');
    else if (/[a-z0-9]/.test(ch)) out.push(ch);
    else if (MAP[ch] !== undefined) out.push(MAP[ch]);
    // прочие символы выбрасываем
  }
  return out.join('').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

export function sheetNameForChat(title, chatId) {
  const base = translit(title) || `chat_${String(chatId).replace('-', 'm')}`;
  return `far_${base}`.slice(0, 100);
}
