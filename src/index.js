import { config } from './config.js';
import { TgClient, pollLoop } from './tg.js';
import { SheetsClient } from './sheets.js';
import { StateStore } from './state.js';
import { createQueue } from './queue.js';
import { createBot } from './bot.js';
import { startDigest } from './digest.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

const tg = new TgClient(config.botToken, { pollTimeoutSec: config.pollTimeoutSec });
const sheets = new SheetsClient(config.google, config.spreadsheetId);
const store = new StateStore(config.stateFile);
const queueApi = createQueue({
  sheets,
  sheetName: config.sheetName,
  typeThresholds: config.typeThresholds,
});
const bot = createBot({ tg, queueApi, store, config, log });

let lastAlert = 0;
function alertAdmin(err) {
  log('ERROR', err);
  if (!config.adminChatId) return;
  const now = Date.now();
  if (now - lastAlert < 5 * 60 * 1000) return;
  lastAlert = now;
  tg.sendMessage(config.adminChatId, `⚠️ far-bot ошибка: ${String(err).slice(0, 300)}`).catch(() => {});
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
function shutdown(code) {
  store.close();
  process.exit(code);
}

const digestLog = (msg, err) => {
  if (msg.endsWith('error')) alertAdmin(`${msg}: ${err}`);
  else log(msg, err ?? '');
};
if (config.digest.chatId) startDigest({ queueApi, tg, config, log: digestLog });
log('far-bot started', {
  allowedTopics: config.allowedTopics,
  sheet: `${config.spreadsheetId}/${config.sheetName}`,
  digest: config.digest.chatId
    ? `${config.digest.chatId}/${config.digest.threadId} every ${config.digest.pollSec}s`
    : 'disabled',
});
pollLoop(
  tg,
  (u) => {
    const msg = u.message ?? u.callback_query?.message;
    const text = u.message?.text ?? u.callback_query?.data;
    log('update', JSON.stringify({ chat: msg?.chat?.id, thread: msg?.message_thread_id, text }));
    return bot.handleUpdate(u);
  },
  alertAdmin,
);
