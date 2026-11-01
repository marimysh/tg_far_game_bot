// Реестр привязок: топик (chatId_threadId) -> { spreadsheetId, title, allowed,
// thresholds: { Стройка, Исследование } }.
// Хранится в JSON-файле с атомарной записью. Интерфейс сменный: при переходе на
// Redis заменяется только эта реализация (намеренное отклонение от Redis пока).

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export function createChatsStore(file) {
  let chats = new Map();
  let dirty = false;

  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) chats.set(k, v);
    } catch {
      chats = new Map();
    }
  }

  const key = (chatId, threadId) => `${chatId}_${threadId || 'none'}`;

  return {
    key,
    get(chatId, threadId) {
      return chats.get(key(chatId, threadId));
    },
    set(chatId, threadId, rec) {
      chats.set(key(chatId, threadId), { ...rec });
      dirty = true;
    },
    remove(chatId, threadId) {
      chats.delete(key(chatId, threadId));
      dirty = true;
    },
    all() {
      return [...chats.entries()].map(([k, v]) => ({ key: k, ...v }));
    },
    size() {
      return chats.size;
    },
    // Заполняет реестр начальными записями, только если он пуст
    seedIfEmpty(entries) {
      if (chats.size > 0) return false;
      for (const e of entries) chats.set(e.key, { ...e });
      dirty = true;
      return true;
    },
    flush() {
      if (!dirty) return;
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(chats), null, 2));
      renameSync(tmp, file);
      dirty = false;
    },
    close() {
      this.flush();
    },
  };
}
