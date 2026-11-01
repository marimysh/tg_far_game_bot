import { StateStore } from '../src/state.js';
import { createQueue } from '../src/queue.js';
import { createBot } from '../src/bot.js';
import { buildDigestText } from '../src/digest.js';
import { createLogBuffer, createAlerter } from '../src/alerting.js';
import { createChatsStore } from '../src/chats.js';
import { translit, sheetNameForChat } from '../src/translit.js';

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
  async getChatMember(chatId, userId) {
    this.record('getChatMember', { chatId, userId });
    return this.memberStatus ?? 'administrator';
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

function makeCtx({ sheets, store, tg, allowedTopics = ['-100_70'], chats, thresholds, createChatSheet }) {
  const queueApi = createQueue({ sheets, sheetName: 'Полный список', typeThresholds: { Стройка: 7, Исследование: 1 } });
  const chatsStore =
    chats ??
    (() => {
      const c = createChatsStore(`/tmp/far-bot-chats-${Date.now()}-${Math.random()}.json`);
      c.seedIfEmpty([
        { key: c.key('-100', 70), chatId: '-100', threadId: 70, spreadsheetId: 'default', title: 'test', allowed: true, thresholds: { Стройка: 7, Исследование: 1 } },
      ]);
      c.flush();
      return c;
    })();
  if (thresholds) {
    chatsStore.set('-100', 70, { spreadsheetId: 'default', title: 'test', allowed: true, thresholds });
  }
  const config = {
    allowedTopics,
    spreadsheetId: 'default',
    typeThresholds: { Стройка: 7, Исследование: 1 },
    adminChatId: '-5',
    adminChatThreadId: '3',
  };
  const sheetCalls = [];
  const createSheetFn =
    createChatSheet ??
    (async (name) => {
      sheetCalls.push(name);
      return { spreadsheetId: `new-sheet-${sheetCalls.length}`, url: `https://docs.google.com/${name}` };
    });
  const bot = createBot({
    tg,
    getQueueApi: () => queueApi,
    chats: chatsStore,
    store,
    config,
    log: () => {},
    createChatSheet: createSheetFn,
  });
  return { bot, queueApi, chats: chatsStore, sheetCalls };
}

const msg = (text, threadId = 70, chatId = -100, title) => ({
  message: {
    message_id: 1,
    chat: { id: chatId, ...(title ? { title } : {}) },
    message_thread_id: threadId,
    text,
    from: { id: 42 },
  },
});
const cbq = (data, messageId = 50) => ({
  callback_query: { id: 'q1', data, from: { id: 42 }, message: { message_id: messageId, chat: { id: -100 }, message_thread_id: 70 } },
});
// callback из админ-чата (не входит в allowedTopics — гейтинг обходится для админ-чата)
const adminCbq = (data, messageId = 99) => ({
  callback_query: { id: 'a1', data, from: { id: 7 }, message: { message_id: messageId, chat: { id: -5 }, message_thread_id: 3 } },
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
    const helpText = tg.texts().find((t) => t.includes('маяками')) ?? '';
    check('help sent', helpText.includes('/farcreate'));
    check('help lists all commands', ['/farcreate', '/farupdate', '/farready', '/farcancel', '/toptop'].every((c) => helpText.includes(c)));
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
    check('below threshold rejected', tg.last().body.text === 'Для «Стройка» принимаются заявки от 7 дн. и больше. Введите число заново');
    check('below threshold keeps state', store.get('-100', 70).state === 'except_create_count');
    check('below threshold no append', sheets.rows.length === SEED.length);

    await bot.handleUpdate(msg('8'));
    const appended = sheets.rows.at(-1);
    check('row appended', appended[2] === 'MyNick1' && appended[3] === 'Стройка' && appended[7] === 'В очереди');
    check('row values', appended[5] === 8 && appended[6] === 7 && appended[4] === 8);
    check('row id is row number', appended[0] === sheets.rows.length + 1);
    check('added confirmation', tg.last().body.text === 'Ваш запрос добавлен. Ожидайте обновления и помощи');
  }

  {
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot } = makeCtx({ sheets, store, tg });

    await bot.handleUpdate(msg('/farupdate'));
    const kb = JSON.stringify(tg.last().body.keyboard);
    check(
      'update keyboard',
      kb.includes('{"text":"Alice - Стройка","callback_data":"update_2"}') &&
        kb.includes('{"text":"Bob - Исследование","callback_data":"update_3"}') &&
        !kb.includes('Closed'),
    );

    await bot.handleUpdate(cbq('update_2'));
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

    await bot.handleUpdate(msg('/farupdate'));
    await bot.handleUpdate(cbq('update_2'));
    await bot.handleUpdate(msg('5'));
    const row = sheets.rows[0];
    check('below threshold closes', row[7] === 'Готово' && row[4] === 5);
    check('below threshold message', tg.last().body.text.includes('меньше порога') && tg.last().body.text.includes('Готово'));
  }

  {
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot } = makeCtx({ sheets, store, tg });

    await bot.handleUpdate(msg('/farready'));
    check('ready keyboard', JSON.stringify(tg.last().body.keyboard).includes('ready_2'));

    await bot.handleUpdate(cbq('ready_2'));
    check('ready closes row', sheets.rows[0][7] === 'Готово' && sheets.rows[0][9] !== '2026-10-28T10:00:00.000Z');
    check('ready message', tg.last().body.text === 'Заявка выполнена: Alice');
  }

  {
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot } = makeCtx({ sheets, store, tg });

    await bot.handleUpdate(msg('/farcancel'));
    const cancelKb = tg.last().body.keyboard;
    check('cancel keyboard', JSON.stringify(cancelKb).includes('cancel_3'));
    check('cancel callbacks within 64 bytes', cancelKb.flat().every((b) => Buffer.byteLength(String(b.callback_data)) <= 64));

    await bot.handleUpdate(cbq('cancel_3'));
    check('cancel closes row', sheets.rows[1][7] === 'Отменено' && sheets.rows[1][9] !== '2026-10-29T10:00:00.000Z');
    check('cancel message', tg.last().body.text === 'Заявка отменена: Bob');
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
    // неизвестный чат: /farhelp — отвечаем, прочие команды — тихо
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot } = makeCtx({ sheets, store, tg });
    await bot.handleUpdate(msg('/farhelp', 1, -999));
    check('unknown chat help answered', tg.texts().some((t) => t.includes('маяками')));
    await bot.handleUpdate(msg('/farupdate', 1, -999));
    check('unknown chat command ignored', tg.texts().filter((t) => t.includes('маяками')).length === 1);
    check('unknown chat help sets finish state', store.get('-999', 1).state === 'finish_command');
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
        '<b>Стройка</b>\n\n<code>Alice</code> Осталось: 8 д из 10 д\n\n<b>Исследования</b>\n\n<code>Bob</code> Осталось: 5 д из 12 д',
      JSON.stringify(text),
    );

    const buildOnly = actual.filter((r) => r['Тип'] === 'Стройка');
    const textBuildOnly = buildDigestText(buildOnly);
    check('digest skips empty lab section', textBuildOnly === '<b>Стройка</b>\n\n<code>Alice</code> Осталось: 8 д из 10 д');
    const labOnly = actual.filter((r) => r['Тип'] === 'Исследование');
    const textLabOnly = buildDigestText(labOnly);
    check('digest skips empty build section', textLabOnly === '<b>Исследования</b>\n\n<code>Bob</code> Осталось: 5 д из 12 д');
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
    await bot.handleUpdate(msg('/farcancel'));
    check('reordered header: keyboard', JSON.stringify(tg.last().body.keyboard).includes('cancel_2'));
    await bot.handleUpdate(cbq('cancel_2'));
    const closed = sheets.rows.find((r) => r[byName['Ник']] === 'Alice');
    check('reordered header: close by name', closed[byName['Статус']] === 'Отменено');
  }

  {
    // ring-buffer
    const buf = createLogBuffer(3);
    ['a', 'b', 'c', 'd', 'e'].forEach((l) => buf.add(l));
    check('log buffer keeps last N', buf.tail(10).join(',') === 'c,d,e');
    check('log buffer tail', buf.tail(2).join(',') === 'd,e');

    // алертер: шлёт ошибку + логи + топик, троттлит повторы
    const tg2 = new FakeTg();
    const logBuf = createLogBuffer();
    logBuf.add('line1');
    const alert = createAlerter({ tg: tg2, chatId: '-5', threadId: '3', logBuffer: logBuf, log: () => {} });
    alert(new Error('boom'), '{"chat":"-1"}');
    const sent = tg2.calls.filter((c) => c.method === 'sendMessage');
    check('alert sent once', sent.length === 1);
    const body = sent[0].body;
    check('alert chat+thread', body.chatId === '-5' && body.threadId === '3');
    check('alert contains error', body.text.includes('boom'));
    check('alert contains context', body.text.includes('{"chat":"-1"}'));
    check('alert contains logs', body.text.includes('line1') && body.text.includes('последние логи'));
    alert(new Error('boom2'));
    check('alert throttled', tg2.calls.filter((c) => c.method === 'sendMessage').length === 1);

    // без chatId — молчит
    const tg3 = new FakeTg();
    const silent = createAlerter({ tg: tg3, chatId: '', logBuffer: logBuf, log: () => {} });
    silent(new Error('x'));
    check('alert disabled without chatId', tg3.calls.length === 0);
  }

  {
    // Локаль листа форматирует >=1000 как "4 444" (NBSP) — парсер должен понимать
    const rows = [
      ['id', 'Дата', 'Ник', 'Тип', 'Осталось дней', 'Изначально', 'Порог в днях', 'Статус', 'Время добавления', 'Время обновления'],
      ['2', '01.11.2026', 'Big', 'Стройка', '4 444', '10 000', '7', 'В очереди', '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z'],
    ];
    const sheets = new FakeSheets(rows.slice(1), rows[0]);
    const queueApi = createQueue({ sheets, sheetName: 'Полный список', typeThresholds: { Стройка: 7, Исследование: 1 } });
    const actual = queueApi.actualRows(await queueApi.readQueue());
    check('num parsing: NBSP thousands separator', actual.length === 1 && actual[0]['Осталось дней'] === 4444 && actual[0]['Изначально'] === 10000);
  }

  {
    // /farthresh: админ может, не-админ нет
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot, chats } = makeCtx({ sheets, store, tg });

    tg.memberStatus = 'member';
    await bot.handleUpdate(msg('/farthresh'));
    check('thresh denied for non-admin', tg.last().body.text === 'Пороги может менять только администратор чата');
    check('thresh denied keeps finish state', store.get('-100', 70).state === 'finish_command');

    tg.memberStatus = 'administrator';
    await bot.handleUpdate(msg('/farthresh'));
    const kb = JSON.stringify(tg.last().body.keyboard);
    check('thresh keyboard', kb.includes('thresh_Стройка') && kb.includes('thresh_Исследование'));
    check('thresh shows current values', kb.includes('Стройка (сейчас 7 дн.)') && kb.includes('Исследование (сейчас 1 дн.)'));

    await bot.handleUpdate(cbq('thresh_Стройка'));
    check('thresh asks value', tg.last().body.text === 'Введите порог в днях для «Стройка» (целое число)');
    check('thresh state', store.get('-100', 70).state === 'expect_thresh_value');

    await bot.handleUpdate(msg('abc'));
    check('thresh non-numeric retry', tg.last().body.text === 'Надо ввести число. Попробуй еще раз');

    await bot.handleUpdate(msg('9'));
    check('thresh saved', chats.get('-100', 70).thresholds['Стройка'] === 9);
    check('thresh confirm', tg.last().body.text.includes('установлен: 9 дн.'));
  }

  {
    // per-chat thresholds: create below custom threshold rejected, row gets custom Порог
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot } = makeCtx({ sheets, store, tg, thresholds: { Стройка: 9, Исследование: 1 } });

    await bot.handleUpdate(msg('/farcreate'));
    await bot.handleUpdate(cbq('create_Стройка'));
    await bot.handleUpdate(msg('Nick9'));
    await bot.handleUpdate(msg('8'));
    check('custom threshold rejects below', tg.last().body.text === 'Для «Стройка» принимаются заявки от 9 дн. и больше. Введите число заново');

    await bot.handleUpdate(msg('10'));
    const appended = sheets.rows.at(-1);
    check('custom threshold row appended', appended[2] === 'Nick9' && appended[6] === 9 && appended[4] === 10);
  }

  {
    // реестр: seed только в пустой, персистентность через файл, нормализация ключа ('' == undefined)
    const f = `/tmp/far-bot-chats-persist-${Date.now()}.json`;
    const c1 = createChatsStore(f);
    check('key normalizes empty thread', c1.key('-1', '') === c1.key('-1', undefined) && c1.key('-1', undefined) === '-1_none');
    check('seedIfEmpty fills empty', c1.seedIfEmpty([{ key: 'k1', chatId: '-1', spreadsheetId: 's1', allowed: true }]) === true);
    check('seedIfEmpty skips non-empty', c1.seedIfEmpty([{ key: 'k2', chatId: '-2', spreadsheetId: 's2', allowed: true }]) === false);
    check('seedIfEmpty one entry', c1.all().length === 1);
    c1.set('-2', 5, { spreadsheetId: 's2', title: '', allowed: true, thresholds: { Стройка: 3, Исследование: 1 } });
    c1.flush();
    c1.close();
    const c2 = createChatsStore(f);
    check('registry persists across instances', c2.all().length === 2 && c2.get('-2', 5).spreadsheetId === 's2' && c2.get('-2', 5).thresholds['Стройка'] === 3);
  }

  {
    // транслитерация
    check('translit cyrillic', translit('FAR Помощь') === 'far_pomosch', translit('FAR Помощь'));
    check('sheet name for chat', sheetNameForChat('FAR Помощь', '-777') === 'far_far_pomosch', sheetNameForChat('FAR Помощь', '-777'));
    check('sheet name fallback', sheetNameForChat('', '-777') === 'far_chat_m777', sheetNameForChat('', '-777'));
  }

  {
    // approval-flow: /start в неизвестном чате -> заявка админу; чужие команды игнор
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot, chats, sheetCalls } = makeCtx({ sheets, store, tg });

    await bot.handleUpdate(msg('/farcreate', null, -777, 'FAR Помощь'));
    check('unknown chat ignores commands', tg.calls.length === 0);

    await bot.handleUpdate(msg('/start', null, -777, 'FAR Помощь'));
    check('start replies to requester', tg.texts().some((t) => t.includes('Отправлен запрос на добавление')));
    const adminCall = tg.calls.find((c) => c.method === 'sendMessage' && c.body.chatId === '-5');
    check('admin notified', Boolean(adminCall) && adminCall.body.threadId === '3');
    check(
      'admin keyboard allow/deny',
      JSON.stringify(adminCall.body.keyboard).includes('allow_-777_none') && JSON.stringify(adminCall.body.keyboard).includes('deny_-777_none'),
    );
    check('pending record stored', chats.get('-777', undefined)?.pending === true && chats.get('-777', undefined)?.allowed === false);

    // allow
    const before = tg.calls.length;
    await bot.handleUpdate(adminCbq('allow_-777_none'));
    check('sheet created via translit name', sheetCalls[0] === 'far_far_pomosch', JSON.stringify(sheetCalls));
    check('mapping allowed after approve', chats.get('-777', undefined)?.allowed === true && chats.get('-777', undefined)?.spreadsheetId === 'new-sheet-1');
    check('mapping has chatId for digest', chats.get('-777', undefined)?.chatId === '-777');
    const adminNotice = tg.calls.find((c) => c.method === 'sendMessage' && c.body.chatId === '-5' && c.body.text.includes('Таблица очереди'));
    check('sheet link goes to admin chat', Boolean(adminNotice) && adminNotice.body.text.includes('https://docs.google.com/') && adminNotice.body.threadId === '3');
    const requesterNotice = tg.calls.find((c) => c.method === 'sendMessage' && c.body.chatId === '-777' && c.body.text.includes('подключён'));
    check('requester gets short confirm without link', Boolean(requesterNotice) && !requesterNotice.body.text.includes('docs.google.com'));

    // после подключения чат "известный": команды работают
    await bot.handleUpdate(msg('/farhelp', null, -777));
    check('known chat after approve', tg.calls.length > before && tg.texts().some((t) => t.includes('маяками')));
  }

  {
    // deny: отказ уходит в чат, маппинг остаётся закрытым
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot, chats, sheetCalls } = makeCtx({ sheets, store, tg });

    await bot.handleUpdate(msg('/start', null, -888, 'Denied Group'));
    await bot.handleUpdate(adminCbq('deny_-888_none'));
    check('deny message to requester', tg.texts().some((t) => t === 'Вам отказано. Для более подробной информации свяжитесь с @Marimysh'));
    check('deny keeps mapping closed', chats.get('-888', undefined)?.allowed === false && chats.get('-888', undefined)?.pending === false);
    check('deny creates no sheet', sheetCalls.length === 0);
  }

  {
    // admin callback работает даже если админ-чат не в allowedTopics (обход гейтинга)
    const sheets = new FakeSheets(SEED.map((r) => [...r]));
    const tg = new FakeTg();
    const { bot, chats } = makeCtx({ sheets, store, tg, allowedTopics: ['-100_70'] });
    await bot.handleUpdate(msg('/start', 5, -999, 'Another'));
    await bot.handleUpdate(adminCbq('allow_-999_5'));
    check('admin gate bypassed', chats.get('-999', 5)?.allowed === true);
  }

  store.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
