import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const fileEnv = loadEnvFile(process.env.FAR_BOT_ENV || resolve(process.cwd(), '.env'));

function env(name, fallback = undefined) {
  return process.env[name] ?? fileEnv[name] ?? fallback;
}

function required(name) {
  const v = env(name);
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const config = {
  botToken: required('BOT_TOKEN'),
  allowedTopics: (required('ALLOWED_TOPICS') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    refreshToken: required('GOOGLE_REFRESH_TOKEN'),
  },
  spreadsheetId: required('SPREADSHEET_ID'),
  sheetName: env('SHEET_NAME', 'Полный список'),
  digest: {
    chatId: env('DIGEST_CHAT_ID', ''),
    threadId: env('DIGEST_THREAD_ID', ''),
    pollSec: Number(env('DIGEST_POLL_SEC', '15')),
  },
  stateFile: env('STATE_FILE', resolve(process.cwd(), 'state.json')),
  chatsFile: env('CHATS_FILE', resolve(process.cwd(), 'chats.json')),
  // ADMIN_CHAT_ID может включать топик: "chatId/threadId"
  adminChatId: (env('ADMIN_CHAT_ID', '').split('/')[0] || '').trim(),
  adminChatThreadId: (env('ADMIN_CHAT_ID', '').split('/')[1] || '').trim(),
  // REQUESTS_CHAT_ID — карточки заявок на подключение и ссылки на таблицы;
  // пустой = тот же чат/топик, что ADMIN_CHAT_ID
  requestsChatId: (env('REQUESTS_CHAT_ID', '').split('/')[0] || '').trim(),
  requestsChatThreadId: (env('REQUESTS_CHAT_ID', '').split('/')[1] || '').trim(),
  pollTimeoutSec: Number(env('TG_POLL_TIMEOUT_SEC', '30')),
  queueLimitPerType: Number(env('QUEUE_LIMIT_PER_TYPE', '3')),
  typeThresholds: { Стройка: 10, Исследование: 15 },
};
