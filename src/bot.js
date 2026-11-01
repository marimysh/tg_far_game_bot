const HELP_TEXT =
  'Это бот помощник \n\nСейчас он помогает в событии с маяками. Используйте функции:\n' +
  '• /farcreate - Добавить заявку\n' +
  '• /farupdate - Изменить оставшееся время\n' +
  '• /farready - Отметить заявку выполненной\n' +
  '• /farcancel - Отменить заявку\n' +
  '• /toptop - Кто первый в очереди по стройке и исследованиям\n\n' +
  'Правила:\nОтветственность будет полностью на Вас. Все в порядке живой очереди!\n' +
  '❌По просьбам и желанию самих игроков Мы просим говорить когда\n' +
  '• СТРОЙКА сократилась до 10 дней, \n• ИССЛЕДОВАНИЕ - до 15ти.\n' +
  'Будем удалять из списка чтобы могли пользоваться следующие\n\nВсем хорошей Игры 💘';

const RETRY_COUNT_TEXT = 'Надо ввести число. Попробуй еще раз';

import { localISO } from './queue.js';

function isNumeric(text) {
  return /^-?\d+(\.\d+)?$/.test(String(text ?? '').trim());
}

export function createBot({ tg, queueApi, store, config, log }) {
  function topicKey(chatId, threadId) {
    return `${chatId}_${threadId ?? 'none'}`;
  }

  function isAllowed(chatId, threadId) {
    if (config.allowedTopics.includes('*')) return true;
    return config.allowedTopics.includes(topicKey(chatId, threadId));
  }

  function usersKeyboard(rows, prefix) {
    return rows.map((r) => [
      { text: `${r['Ник']} - ${r['Тип']}`, callback_data: `${prefix}_${r['Ник']} - ${r['Тип']}` },
    ]);
  }

  async function onFarUpdate(ctx) {
    const queue = await queueApi.readQueue();
    const rows = queueApi.actualRows(queue);
    await tg.sendMessage(ctx.chatId, 'У кого обновить оставшееся время?', {
      threadId: ctx.threadId,
      keyboard: usersKeyboard(rows, 'update'),
    });
    store.set(ctx.chatId, ctx.threadId, 'expect_command', {});
  }

  async function onFarReady(ctx) {
    const queue = await queueApi.readQueue();
    const rows = queueApi.actualRows(queue);
    await tg.sendMessage(ctx.chatId, '/farready - Отметить заявку выполненной', {
      threadId: ctx.threadId,
      keyboard: usersKeyboard(rows, 'ready'),
    });
    store.set(ctx.chatId, ctx.threadId, 'expect_command_ready', {});
  }

  async function onFarCancel(ctx) {
    const queue = await queueApi.readQueue();
    const rows = queueApi.actualRows(queue);
    await tg.sendMessage(ctx.chatId, '/farcancel - Отменить заявку', {
      threadId: ctx.threadId,
      keyboard: usersKeyboard(rows, 'cancel'),
    });
    store.set(ctx.chatId, ctx.threadId, 'expect_command_cancel', {});
  }

  async function onFarCreate(ctx) {
    const queue = await queueApi.readQueue();
    const rows = queueApi.actualRows(queue);
    const countBuild = rows.filter((r) => r['Тип'] === 'Стройка').length;
    const countLab = rows.filter((r) => r['Тип'] === 'Исследование').length;
    const text =
      'Добавь новый запрос помощи.\n🚨<b>В очереди должно быть не больше 3х человек по каждому типу. Если ты 4й, то надо дождаться свободного места.</b>\n' +
      `Сейчас: на стройку ${countBuild}\nна исследования ${countLab}\n\nВыбери тип или отмену`;
    await tg.sendMessage(ctx.chatId, text, {
      threadId: ctx.threadId,
      keyboard: [
        [{ text: 'Стройка', callback_data: 'create_Стройка' }],
        [{ text: 'Исследование', callback_data: 'create_Исследование' }],
        [{ text: 'Отмена, зайду позже', callback_data: 'create_cancel' }],
      ],
    });
    store.set(ctx.chatId, ctx.threadId, 'expect_command_create_type', {});
  }

  async function onTopTop(ctx) {
    const queue = await queueApi.readQueue();
    const rows = queueApi.actualRows(queue);
    const topBuild = rows.find((r) => r['Тип'] === 'Стройка')?.['Ник'] ?? '—';
    const topLab = rows.find((r) => r['Тип'] === 'Исследование')?.['Ник'] ?? '—';
    await tg.sendMessage(ctx.chatId, `<code>Стройка: ${topBuild} ------ Исследования: ${topLab}</code>`, {
      threadId: ctx.threadId,
    });
    store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
  }

  async function onHelp(ctx) {
    await tg.sendMessage(ctx.chatId, HELP_TEXT, { threadId: ctx.threadId });
    store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
  }

  async function onNewTime(ctx, st) {
    const text = String(ctx.text).trim();
    if (!isNumeric(text)) {
      await tg.sendMessage(ctx.chatId, RETRY_COUNT_TEXT, { threadId: ctx.threadId });
      store.set(ctx.chatId, ctx.threadId, 'expect_new_time', st.data);
      return;
    }
    const days = Number(text);
    const queue = await queueApi.readQueue();
    const row = queueApi.findByNickType(queueApi.actualRows(queue), st.data.nick, st.data.type);
    if (row) {
      const patch = { 'Осталось дней': days, 'Время обновления': localISO(new Date()) };
      let reply = 'Оставшееся время обновлено';
      if (days < Number(row['Порог в днях'])) {
        patch['Статус'] = 'Готово';
        reply = `Осталось ${days} дн. — меньше порога (${row['Порог в днях']} дн.). Заявка закрыта со статусом «Готово»`;
      }
      await queueApi.updateRow(row, patch);
      await tg.sendMessage(ctx.chatId, reply, { threadId: ctx.threadId });
    } else {
      await tg.sendMessage(ctx.chatId, 'Запись не найдена или уже закрыта', { threadId: ctx.threadId });
    }
    store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
  }

  async function onNick(ctx, st) {
    const nick = String(ctx.text ?? '').replaceAll(' ', '').replaceAll('_', '');
    await tg.sendMessage(ctx.chatId, 'Сколько дней осталось? Введи число', { threadId: ctx.threadId });
    store.set(ctx.chatId, ctx.threadId, 'except_create_count', { ...st.data, nick });
  }

  async function onCount(ctx, st) {
    const text = String(ctx.text ?? '').trim();
    if (!isNumeric(text)) {
      await tg.sendMessage(ctx.chatId, RETRY_COUNT_TEXT, { threadId: ctx.threadId });
      store.set(ctx.chatId, ctx.threadId, 'except_create_count', st.data);
      return;
    }
    const days = Number(text.replace(',', '.'));
    const minDays = Number(config.typeThresholds[st.data.type] ?? 1);
    if (days < minDays) {
      await tg.sendMessage(
        ctx.chatId,
        `Для «${st.data.type}» принимаются заявки от ${minDays} дн. и больше. Введите число заново`,
        { threadId: ctx.threadId },
      );
      store.set(ctx.chatId, ctx.threadId, 'except_create_count', st.data);
      return;
    }
    await queueApi.appendRequest({ nick: st.data.nick, type: st.data.type, days });
    await tg.sendMessage(ctx.chatId, 'Ваш запрос добавлен. Ожидайте обновления и помощи', { threadId: ctx.threadId });
    store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
  }

  async function handleMessage(ctx) {
    const st = store.get(ctx.chatId, ctx.threadId);
    if (st.state === 'expect_new_time') return onNewTime(ctx, st);
    if (st.state === 'except_create_nick') return onNick(ctx, st);
    if (st.state === 'except_create_count') return onCount(ctx, st);

    const text = String(ctx.text ?? '').trim();
    if (text.startsWith('/farupdate')) return onFarUpdate(ctx);
    if (text.startsWith('/farready')) return onFarReady(ctx);
    if (text.startsWith('/farcancel')) return onFarCancel(ctx);
    if (text.startsWith('/farcreate')) return onFarCreate(ctx);
    if (text.startsWith('/toptop')) return onTopTop(ctx);
    if (text.startsWith('/farhelp')) return onHelp(ctx);
  }

  async function handleCallback(ctx) {
    const st = store.get(ctx.chatId, ctx.threadId);
    const data = ctx.data ?? '';

    if (data.split('_')[0] === 'update') {
      const actionId = data.substring('update_'.length);
      const [nick, , type] = actionId.split(' ');
      store.set(ctx.chatId, ctx.threadId, 'expect_new_time', { actionId, nick, type });
      await tg.editMessageText(ctx.chatId, ctx.messageId, `Введите новое значение в днях для ${actionId}`);
      return;
    }

    if (data.split('_')[0] === 'ready') {
      const actionId = data.substring('ready_'.length);
      const [nick, , type] = actionId.split(' ');
      const queue = await queueApi.readQueue();
      const row = queueApi.findByNickType(queueApi.actualRows(queue), nick, type);
      if (row) {
        await queueApi.updateRow(row, { 'Статус': 'Готово', 'Время обновления': localISO(new Date()) });
      }
      await tg.editMessageText(ctx.chatId, ctx.messageId, `Заявка выполнена: ${nick}`);
      store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
      return;
    }

    if (data.split('_')[0] === 'cancel') {
      const actionId = data.substring('cancel_'.length);
      const [nick, , type] = actionId.split(' ');
      const queue = await queueApi.readQueue();
      const row = queueApi.findByNickType(queueApi.actualRows(queue), nick, type);
      if (row) {
        await queueApi.updateRow(row, { 'Статус': 'Отменено', 'Время обновления': localISO(new Date()) });
      }
      await tg.editMessageText(ctx.chatId, ctx.messageId, `Заявка отменена: ${nick}`);
      store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
      return;
    }

    if (data.split('_')[0] === 'create') {
      if (data === 'create_cancel') {
        await tg.editMessageText(ctx.chatId, ctx.messageId, 'Ваш запрос отменен, можно начать заново');
        store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
        return;
      }
      if (st.state === 'expect_command_create_type') {
        const type = data.split('_')[1];
        store.set(ctx.chatId, ctx.threadId, 'except_create_nick', { type });
        await tg.editMessageText(ctx.chatId, ctx.messageId, 'Введи ник');
      }
    }
  }

  async function handleUpdate(update) {
    const message = update.message;
    const cb = update.callback_query;

    if (cb) {
      const chatId = String(cb.message?.chat?.id);
      const threadId = cb.message?.message_thread_id;
      if (!isAllowed(chatId, threadId)) return;
      const ctx = {
        chatId,
        threadId,
        data: cb.data,
        callbackQueryId: cb.id,
        messageId: cb.message?.message_id,
      };
      tg.answerCallbackQuery(ctx.callbackQueryId).catch((e) => log('answerCallbackQuery error', e));
      return handleCallback(ctx);
    }

    if (message) {
      const chatId = String(message.chat?.id);
      const threadId = message.message_thread_id;
      if (!isAllowed(chatId, threadId)) return;
      const ctx = {
        chatId,
        threadId,
        text: message.text,
        messageId: message.message_id,
        from: message.from,
      };
      return handleMessage(ctx);
    }
  }

  return { handleUpdate };
}
