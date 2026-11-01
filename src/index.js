import { config } from './config.js';
import { TgClient, pollLoop } from './tg.js';
import { SheetsClient } from './sheets.js';
import { StateStore } from './state.js';
import { createQueue, COLUMNS, localISO, formatDateDDMMYYYY } from './queue.js';
import { createBot } from './bot.js';
import { startDigest } from './digest.js';
import { createLogBuffer, createAlerter } from './alerting.js';
import { createChatsStore } from './chats.js';

const logBuffer = createLogBuffer();
const fmt = (a) =>
  typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? String(a)) : JSON.stringify(a);
const log = (...args) => {
  const line = [new Date().toISOString(), ...args.map(fmt)].join(' ');
  console.log(line);
  logBuffer.add(line);
};

const tg = new TgClient(config.botToken, { pollTimeoutSec: config.pollTimeoutSec });
const store = new StateStore(config.stateFile);
const chats = createChatsStore(config.chatsFile);

// Клиенты/очереди кешируются по spreadsheetId: топик -> таблица
const sheetsCache = new Map();
function getSheets(spreadsheetId) {
  if (!sheetsCache.has(spreadsheetId)) sheetsCache.set(spreadsheetId, new SheetsClient(config.google, spreadsheetId));
  return sheetsCache.get(spreadsheetId);
}
const queueCache = new Map();
function getQueueApi(spreadsheetId) {
  if (!queueCache.has(spreadsheetId)) {
    queueCache.set(
      spreadsheetId,
      createQueue({ sheets: getSheets(spreadsheetId), sheetName: config.sheetName, typeThresholds: config.typeThresholds }),
    );
  }
  return queueCache.get(spreadsheetId);
}

// Legacy: одиночный контур из env становится первой записью реестра
chats.seedIfEmpty(
  config.digest.chatId
    ? [
        {
          key: chats.key(config.digest.chatId, config.digest.threadId),
          chatId: config.digest.chatId,
          threadId: config.digest.threadId,
          spreadsheetId: config.spreadsheetId,
          title: 'legacy',
          allowed: true,
          thresholds: config.typeThresholds,
        },
      ]
    : [],
);
chats.flush();

// Создание таблицы для нового чата: файл + переименованный лист + шапка и 2 тестовые строки
async function createChatSheet(name) {
  const { spreadsheetId, url } = await SheetsClient.create(config.google, name);
  const sheets = getSheets(spreadsheetId);
  await sheets.renameFirstSheet(config.sheetName);
  const now = localISO(new Date());
  const today = formatDateDDMMYYYY(new Date());
  const header = COLUMNS;
  const rows = [
    ['=ROW()', today, 'Тест Стройка', 'Стройка', 10, 10, config.typeThresholds['Стройка'] ?? 7, 'В очереди', now, now],
    ['=ROW()', today, 'Тест Исследование', 'Исследование', 5, 5, config.typeThresholds['Исследование'] ?? 1, 'В очереди', now, now],
  ];
  await sheets.updateValues(`'${config.sheetName}'!A1:J${1 + rows.length}`, [header, ...rows]);
  return { spreadsheetId, url };
}

const bot = createBot({ tg, getQueueApi, chats, store, config, log, createChatSheet });

const alertAdmin = createAlerter({
  tg,
  chatId: config.adminChatId,
  threadId: config.adminChatThreadId,
  logBuffer,
  log,
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
function shutdown(code) {
  store.close();
  chats.close();
  process.exit(code);
}

const digestLog = (msg, err) => {
  if (msg.endsWith('error')) alertAdmin(`${msg}: ${err}`);
  else log(msg, err ?? '');
};
if (config.digest.chatId) startDigest({ getQueueApi, chats, tg, config, log: digestLog });
log('far-bot started', {
  allowedTopics: config.allowedTopics,
  sheet: `${config.spreadsheetId}/${config.sheetName}`,
  digest: config.digest.chatId
    ? `${config.digest.chatId}/${config.digest.threadId} every ${config.digest.pollSec}s`
    : 'disabled',
});
pollLoop(
  tg,
  async (u) => {
    const msg = u.message ?? u.callback_query?.message;
    const text = u.message?.text ?? u.callback_query?.data;
    const context = JSON.stringify({ chat: msg?.chat?.id, thread: msg?.message_thread_id, text });
    log('update', context);
    try {
      await bot.handleUpdate(u);
    } catch (e) {
      e.context = context;
      throw e;
    }
  },
  (err) => alertAdmin(err, err?.context),
);
