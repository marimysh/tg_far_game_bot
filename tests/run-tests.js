import { StateStore } from '../src/state.js';
import { createQueue } from '../src/queue.js';
import { createBot } from '../src/bot.js';
import { buildDigestText } from '../src/digest.js';

// Реальный порядок колонок листа «Полный список»
const HEADER = ['id', 'Дата', 'Ник', 'Тип', 'Осталось дней', 'Изначально', 'Порог в днях', 'Статус', 'Время добавления', 'Время обновления'];

class FakeSheets {
  constructor(rows, header = HEADER) {
    this.header = header;
    this.rows = rows.map((r) => [...r]);
  }
  async values(range) {
    const m = range.match(/!A(?::J|(\d+):J(\d+))/);
    if (!m) throw new Error(`bad range ${range}`);
    if (m[1]) {
      const r = Number(m[1]);
      if (r === 1) return [[...this.header]];
      return this.rows[r - 2] ? [[...this.rows[r - 2]]] : [];
    }
    return [this.header, ...this.rows.map((r) => [...r])];
  }
  async appendValues(range, values) {
    const row = [...values[0]];
    if (row[0] === '=ROW()') row[0] = this.rows.length + 2;
    this.rows.push(row);
    return { updates: { updatedRows: 1 } };
  }
  async updateValues(range, values) {
    const r = Number(range.match(/!A(\d+):J/)[1]);
    this.rows[r - 2] = [...values[0]];
    return { updatedRows: 1 };
  }
}

class FakeTg {
  constructor() {
    this.calls = [];
  }
  record(method, body) {
    this.calls.push({ method, body });
  }
  async sendMessage(chatId, text, opts = {}) {
    this.record('sendMessage', { chatId, text, ...opts });
  }
  async editMessageText(chatId, messageId, text, opts = {}) {
    this.record('editMessageText', { chatId, messageId, text, ...opts });
  }
  async answerCallbackQuery(id) {
    this.record('answerCallbackQuery', { id });
  }
  last() {
    return this.calls[this.calls.length - 1];
  }
  texts() {
    return this.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.body.text);
  }
}

// Позиции в HEADER: 0 id, 1 Дата, 2 Ник, 3 Тип, 4 Осталось дней, 5 Изначально, 6 Порог в днях, 7 Статус, 8 Время добавления, 9 Время обновления
const SEED = [
  [2, '28.10.2026', 'Alice', 'Стройка', 8, 10, 7, 'В очереди', '2026-10-28T10:00:00.000Z', '2026-10-28T10:00:00.000Z'],
  [3, '29.10.2026', 'Bob', 'Исследование', 5, 12, 1, 'В очереди', '2026-10-29T10:00:00.000Z', '2026-10-29T10:00:00.000Z'],
  [4, '30.10.2026', 'Closed', 'Стройка', 9, 9, 7, 'Готово (снято)', '2026-10-30T10:00:00.000Z', '2026-10-30T10:00:00.000Z'],
];

function makeCtx({ sheets, store, tg, allowedTopics = ['-100_70'] }) {
  const queueApi = createQueue({ sheets, sheetName: 'Полный список', typeThresholds: { Стройка: 7, Исследование: 1 } });
  const bot = createBot({ tg, queueApi, store, config: { allowedTopics, typeThresholds: { Стройка: 7, Исследование: 1 } }, log: () => {} });
  return { bot, queueApi };
}

const msg = (text, threadId = 70) => ({ message: { message_id: 1, chat: { id: -100 }, message_thread_id: threadId, text } });
const cbq = (data, messageId = 50) => ({
  callback_query: { id: 'q1', data, message: { message_id: messageId, chat: { id: -100 }, message_thread_id: 70 } },
});

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name} ${extra}`);
  }
}

async function main() {
  const tmpState = `/tmp/far-bot-test-state-${Date.now()}.json`;
  const store = new StateStore(tmpState);

  {
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot } = makeCtx({ sheets, store, tg });

    await bot.handleUpdate(msg('/farhelp'));
    check('help sent', tg.texts().some((t) => t.includes('/farcreate') && t.includes('маяками')));
    check('help state=finish', store.get('-100', 70).state === 'finish_command');

    await bot.handleUpdate(msg('/farcreate'));
    const createMsg = tg.last();
    check('farcreate prompt', createMsg.body.text.includes('на стройку 1') && createMsg.body.text.includes('на исследования 1'));
    check('farcreate keyboard', JSON.stringify(createMsg.body.keyboard).includes('create_Стройка') && JSON.stringify(createMsg.body.keyboard).includes('create_cancel'));

    await bot.handleUpdate(cbq('create_Стройка'));
    check('create: ask nick', tg.last().body.text === 'Введи ник' && tg.last().method === 'editMessageText');
    check('create: state except_create_nick', store.get('-100', 70).state === 'except_create_nick');

    await bot.handleUpdate(msg('My Nick_1'));
    check('nick sanitized', tg.last().body.text === 'Сколько дней осталось? Введи число');
    check('nick stored', store.get('-100', 70).data.nick === 'MyNick1');

    await bot.handleUpdate(msg('abc'));
    check('non-numeric retry', tg.last().body.text === 'Надо ввести число. Попробуй еще раз');
    check('retry keeps state', store.get('-100', 70).state === 'except_create_count');

    await bot.handleUpdate(msg('5'));
    const appended = sheets.rows.at(-1);
    check('row appended', appended[2] === 'MyNick1' && appended[3] === 'Стройка' && appended[7] === 'В очереди');
    check('row values', appended[5] === 5 && appended[6] === 7 && appended[4] === 5);
    check('row id is row number', appended[0] === sheets.rows.length + 1);
    check('added confirmation', tg.last().body.text === 'Ваш запрос добавлен. Ожидайте обновления и помощи');
  }

  {
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot } = makeCtx({ sheets, store, tg });

    await bot.handleUpdate(msg('/farupdate'));
    const kb = JSON.stringify(tg.last().body.keyboard);
    check('update keyboard', kb.includes('update_Alice - Стройка') && kb.includes('update_Bob - Исследование') && !kb.includes('Closed'));

    await bot.handleUpdate(cbq('update_Alice - Стройка'));
    check('update ask value', tg.last().body.text === 'Введите новое значение в днях для Alice - Стройка');
    check('update state', store.get('-100', 70).state === 'expect_new_time');

    await bot.handleUpdate(msg('KJ'));
    check('update non-numeric retry', tg.last().body.text === 'Надо ввести число. Попробуй еще раз');
    check('update retry keeps state', store.get('-100', 70).state === 'expect_new_time');
    check('update retry no write', sheets.rows[0][4] === 8);

    await bot.handleUpdate(msg('9'));
    const row = sheets.rows[0];
    check('days updated', row[4] === 9 && row[9] !== '2026-10-28T10:00:00.000Z');
    check('update finish', tg.last().body.text === 'Оставшееся время обновлено');
  }

  {
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot } = makeCtx({ sheets, store, tg });

    await bot.handleUpdate(msg('/fardelete'));
    check('delete keyboard', JSON.stringify(tg.last().body.keyboard).includes('delete_Alice - Стройка'));

    await bot.handleUpdate(cbq('delete_Alice - Стройка'));
    check('delete closes row', sheets.rows[0][7] === 'Готово (снято)' && sheets.rows[0][9] !== '2026-10-28T10:00:00.000Z');
    check('delete message', tg.last().body.text === 'Статус сменен на "готово" у Alice');
  }

  {
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot } = makeCtx({ sheets, store, tg });

    await bot.handleUpdate(msg('/toptop'));
    check('toptop text', tg.last().body.text === '<code>Стройка: Alice ------ Исследования: Bob</code>');

    await bot.handleUpdate(cbq('create_cancel'));
    check('cancel text', tg.last().body.text === 'Ваш запрос отменен, можно начать заново');
  }

  {
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot } = makeCtx({ sheets, store, tg });
    await bot.handleUpdate({ message: { message_id: 1, chat: { id: -999 }, message_thread_id: 1, text: '/farhelp' } });
    check('foreign chat ignored', tg.calls.length === 0);
    check('foreign chat no state', store.get('-999', 1).state === 'expect_command');
  }

  {
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const queueApi = createQueue({ sheets, sheetName: 'Полный список', typeThresholds: { Стройка: 7, Исследование: 1 } });
    const actual = queueApi.actualRows(await queueApi.readQueue());
    const sorted = [...actual].sort((a, b) => String(a['Время добавления']).localeCompare(String(b['Время добавления'])));
    const text = buildDigestText(sorted);
    check(
      'digest text',
      text ===
        '<b>Стройка</b>\n\n<code>Alice</code> Осталось: 8 д из 10 д\n<b>Исследования</b>\n\n<code>Bob</code> Осталось: 5 д из 12 д',
      JSON.stringify(text),
    );
  }

  {
    // Переставленный заголовок — маппинг по именам должен выдержать
    const reordered = ['Статус', 'Ник', 'id', 'Тип', 'Время обновления', 'Изначально', 'Дата', 'Порог в днях', 'Осталось дней', 'Время добавления'];
    const byName = Object.fromEntries(reordered.map((h, i) => [h, i]));
    const seedReordered = SEED.map((r) => reordered.map((h) => r[HEADER.indexOf(h)]));
    const sheets = new FakeSheets(seedReordered, reordered);
    const tg = new FakeTg();
    const { bot, queueApi } = makeCtx({ sheets, store, tg });
    const actual = queueApi.actualRows(await queueApi.readQueue());
    check('reordered header: actual rows', actual.length === 2, JSON.stringify(actual.map((r) => r['Ник'])));
    await bot.handleUpdate(msg('/fardelete'));
    check('reordered header: keyboard', JSON.stringify(tg.last().body.keyboard).includes('delete_Alice - Стройка'));
    await bot.handleUpdate(cbq('delete_Alice - Стройка'));
    const closed = sheets.rows.find((r) => r[byName['Ник']] === 'Alice');
    check('reordered header: close by name', closed[byName['Статус']] === 'Готово (снято)');
  }

  store.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
