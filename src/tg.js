const API = 'https://api.telegram.org';

export class TgClient {
  constructor(token, { pollTimeoutSec = 30 } = {}) {
    this.token = token;
    this.pollTimeoutSec = pollTimeoutSec;
    this.offset = 0;
  }

  async call(method, body) {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(`Telegram ${method} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data.result;
  }

  async getUpdates() {
    return this.call('getUpdates', {
      offset: this.offset,
      timeout: this.pollTimeoutSec,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  consume(updates) {
    for (const u of updates) this.offset = Math.max(this.offset, u.update_id + 1);
  }

  sendMessage(chatId, text, { threadId, keyboard } = {}) {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard ?? [] },
    };
    if (threadId) body.message_thread_id = threadId;
    return this.call('sendMessage', body);
  }

  editMessageText(chatId, messageId, text, { threadId, keyboard } = {}) {
    const body = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard ?? [] },
    };
    if (threadId) body.message_thread_id = threadId;
    return this.call('editMessageText', body);
  }

  answerCallbackQuery(id) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text: '✅' });
  }

  async deleteWebhook() {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }
}

export async function pollLoop(tg, onUpdate, onError) {
  await tg.deleteWebhook();
  for (;;) {
    let updates;
    try {
      updates = await tg.getUpdates();
    } catch (e) {
      onError(e);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    tg.consume(updates);
    for (const u of updates) {
      try {
        await onUpdate(u);
      } catch (e) {
        onError(e);
      }
    }
  }
}
