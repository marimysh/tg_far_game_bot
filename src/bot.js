// Числа в правилах — актуальные пороги чата (resolveChat), а не константы
function helpText(thresholds) {
  return (
    'Это бот помощник \n\nСейчас он помогает в событии с маяками. Используйте функции:\n' +
    '• /farcreate - Добавить заявку\n' +
    '• /farupdate - Изменить оставшееся время\n' +
    '• /farready - Отметить заявку выполненной\n' +
    '• /farcancel - Отменить заявку\n' +
    '• /farthresh - Настроить пороги показа заявок для этого чата (админам)\n' +
    '• /toptop - Кто первый в очереди по стройке и исследованиям\n\n' +
    'Правила:\nОтветственность будет полностью на Вас. Все в порядке живой очереди!\n' +
    '❌По просьбам и желанию самих игроков Мы просим говорить когда\n' +
    `• СТРОЙКА сократилась до ${thresholds['Стройка']} дн., \n• ИССЛЕДОВАНИЕ - до ${thresholds['Исследование']} дн.\n` +
    'Будем удалять из списка чтобы могли пользоваться следующие\n\nВсем хорошей Игры 💘'
  );
}

const RETRY_COUNT_TEXT = 'Надо ввести число. Попробуй еще раз';

import { localISO } from './queue.js';
import { sheetNameForChat } from './translit.js';

function isNumeric(text) {
  return /^-?\d+(\.\d+)?$/.test(String(text ?? '').trim());
}

export function createBot({ tg, getQueueApi, chats, store, config, log, createChatSheet }) {
  function topicKey(chatId, threadId) {
    return `${chatId}_${threadId ?? 'none'}`;
  }

  function isAllowed(chatId, threadId) {
    if (config.allowedTopics.includes('*')) return true;
    if (config.allowedTopics.includes(topicKey(chatId, threadId))) return true;
    // Чат, прошедший согласование (allow из админ-чата), живёт в реестре с
    // allowed: true. Без этой ветки каждый новый чат «полуработал»: сообщения
    // доходили, а кнопки молча отбрасывались до ручной правки .env и рестарта.
    return chats.get(chatId, threadId)?.allowed === true;
  }

  function isAdminChat(chatId) {
    return config.adminChatId && String(chatId) === String(config.adminChatId);
  }

  // Карточки заявок и ссылки на таблицы: в REQUESTS_CHAT_ID, по умолчанию — в ADMIN_CHAT_ID
  function requestsTarget() {
    return {
      chatId: config.requestsChatId || config.adminChatId,
      threadId: config.requestsChatThreadId || config.adminChatThreadId || undefined,
    };
  }

  function isKnownChat(chatId, threadId) {
    const rec = chats.get(chatId, threadId);
    return Boolean(rec && rec.allowed !== false && rec.spreadsheetId);
  }

  // Привязка топика к таблице: из реестра, иначе legacy-таблица из env.
  // Пороги чата применяются при создании заявки; для уже созданных строк
  // авторитетен «Порог в днях» самой строки.
  function resolveChat(chatId, threadId) {
    const rec = chats.get(chatId, threadId);
    return {
      spreadsheetId: rec?.spreadsheetId ?? config.spreadsheetId,
      thresholds: rec?.thresholds ?? config.typeThresholds,
    };
  }

  async function queueFor(ctx) {
    const { spreadsheetId, thresholds } = resolveChat(ctx.chatId, ctx.threadId);
    return { api: getQueueApi(spreadsheetId), thresholds };
  }

  async function isChatAdmin(ctx) {
    if (!ctx.userId) return false;
    try {
      const status = await tg.getChatMember(ctx.chatId, ctx.userId);
      return status === 'creator' || status === 'administrator';
    } catch {
      return false;
    }
  }

  // callback_data ограничен Telegram 64 байтами — в кнопках кодируем id строки, а не «Ник - Тип»
  function usersKeyboard(rows, prefix) {
    return rows.map((r) => [
      { text: `${r['Ник']} - ${r['Тип']}`, callback_data: `${prefix}_${r['id']}` },
    ]);
  }

  async function onFarUpdate(ctx) {
    const { api } = await queueFor(ctx);
    const queue = await api.readQueue();
    const rows = api.actualRows(queue);
    await tg.sendMessage(ctx.chatId, 'У кого обновить оставшееся время?', {
      threadId: ctx.threadId,
      keyboard: usersKeyboard(rows, 'update'),
    });
    store.set(ctx.chatId, ctx.threadId, 'expect_command', {});
  }

  async function onFarReady(ctx) {
    const { api } = await queueFor(ctx);
    const queue = await api.readQueue();
    const rows = api.actualRows(queue);
    await tg.sendMessage(ctx.chatId, '/farready - Отметить заявку выполненной', {
      threadId: ctx.threadId,
      keyboard: usersKeyboard(rows, 'ready'),
    });
    store.set(ctx.chatId, ctx.threadId, 'expect_command_ready', {});
  }

  async function onFarCancel(ctx) {
    const { api } = await queueFor(ctx);
    const queue = await api.readQueue();
    const rows = api.actualRows(queue);
    await tg.sendMessage(ctx.chatId, '/farcancel - Отменить заявку', {
      threadId: ctx.threadId,
      keyboard: usersKeyboard(rows, 'cancel'),
    });
    store.set(ctx.chatId, ctx.threadId, 'expect_command_cancel', {});
  }

  async function onFarCreate(ctx) {
    const { api } = await queueFor(ctx);
    const queue = await api.readQueue();
    const rows = api.actualRows(queue);
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
    const { api } = await queueFor(ctx);
    const queue = await api.readQueue();
    const rows = api.actualRows(queue);
    const topBuild = rows.find((r) => r['Тип'] === 'Стройка')?.['Ник'] ?? '—';
    const topLab = rows.find((r) => r['Тип'] === 'Исследование')?.['Ник'] ?? '—';
    await tg.sendMessage(ctx.chatId, `<code>Стройка: ${topBuild} ------ Исследования: ${topLab}</code>`, {
      threadId: ctx.threadId,
    });
    store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
  }

  async function onHelp(ctx) {
    const { thresholds } = resolveChat(ctx.chatId, ctx.threadId);
    await tg.sendMessage(ctx.chatId, helpText(thresholds), { threadId: ctx.threadId });
    store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
  }

  async function onFarThresh(ctx) {
    if (!(await isChatAdmin(ctx))) {
      await tg.sendMessage(ctx.chatId, 'Пороги может менять только администратор чата', { threadId: ctx.threadId });
      store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
      return;
    }
    const { thresholds } = resolveChat(ctx.chatId, ctx.threadId);
    const btn = (type) => [{ text: `${type} (сейчас ${thresholds[type]} дн.)`, callback_data: `thresh_${type}` }];
    await tg.sendMessage(ctx.chatId, 'Выбери тип, чтобы задать порог показа заявок для этого чата:', {
      threadId: ctx.threadId,
      keyboard: [btn('Стройка'), btn('Исследование')],
    });
    store.set(ctx.chatId, ctx.threadId, 'expect_thresh_type', {});
  }

  async function onStart(ctx) {
    const existing = chats.get(ctx.chatId, ctx.threadId);
    chats.set(ctx.chatId, ctx.threadId, {
      chatId: ctx.chatId,
      threadId: ctx.threadId ?? '',
      spreadsheetId: existing?.spreadsheetId,
      title: ctx.title ?? existing?.title ?? '',
      allowed: false,
      pending: true,
      thresholds: existing?.thresholds ?? config.typeThresholds,
    });
    await tg.sendMessage(
      ctx.chatId,
      'Отправлен запрос на добавление. При необходимости, связаться с @Marimysh',
      { threadId: ctx.threadId },
    );
    store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
    if (!existing?.pending && config.adminChatId) {
      const name = ctx.title ? `«${ctx.title}»` : `chat ${ctx.chatId}`;
      const target = requestsTarget();
      await tg.sendMessage(
        target.chatId,
        `Новый запрос на подключение: ${name} (chat ${ctx.chatId}, thread ${ctx.threadId ?? '—'})`,
        {
          threadId: target.threadId,
          keyboard: [
            [{ text: '✅ Разрешить', callback_data: `allow_${ctx.chatId}_${ctx.threadId ?? 'none'}` }],
            [{ text: '❌ Отказать', callback_data: `deny_${ctx.chatId}_${ctx.threadId ?? 'none'}` }],
          ],
        },
      );
    }
  }

  async function onThreshValue(ctx, st) {
    const text = String(ctx.text).trim();
    if (!isNumeric(text) || Number(text) < 0) {
      await tg.sendMessage(ctx.chatId, RETRY_COUNT_TEXT, { threadId: ctx.threadId });
      store.set(ctx.chatId, ctx.threadId, 'expect_thresh_value', st.data);
      return;
    }
    const rec = chats.get(ctx.chatId, ctx.threadId);
    const thresholds = { ...config.typeThresholds, ...(rec?.thresholds ?? {}) };
    thresholds[st.data.type] = Math.floor(Number(text.replace(',', '.')));
    chats.set(ctx.chatId, ctx.threadId, {
      chatId: ctx.chatId,
      threadId: ctx.threadId ?? '',
      spreadsheetId: rec?.spreadsheetId ?? config.spreadsheetId,
      title: rec?.title ?? '',
      allowed: rec?.allowed ?? true,
      thresholds,
    });
    await tg.sendMessage(
      ctx.chatId,
      `Порог для «${st.data.type}» в этом чате установлен: ${thresholds[st.data.type]} дн. Новые заявки ниже порога приниматься не будут.`,
      { threadId: ctx.threadId },
    );
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
    const { api } = await queueFor(ctx);
    const queue = await api.readQueue();
    const row = api.findByNickType(api.actualRows(queue), st.data.nick, st.data.type);
    if (row) {
      const patch = { 'Осталось дней': days, 'Время обновления': localISO(new Date()) };
      let reply = 'Оставшееся время обновлено';
      if (days < Number(row['Порог в днях'])) {
        patch['Статус'] = 'Готово';
        reply = `Осталось ${days} дн. — меньше порога (${row['Порог в днях']} дн.). Заявка закрыта со статусом «Готово»`;
      }
      await api.updateRow(row, patch);
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
    const { thresholds } = resolveChat(ctx.chatId, ctx.threadId);
    const minDays = Number(thresholds[st.data.type] ?? 1);
    if (days < minDays) {
      await tg.sendMessage(
        ctx.chatId,
        `Для «${st.data.type}» принимаются заявки от ${minDays} дн. и больше. Введите число заново`,
        { threadId: ctx.threadId },
      );
      store.set(ctx.chatId, ctx.threadId, 'except_create_count', st.data);
      return;
    }
    const { api } = await queueFor(ctx);
    await api.appendRequest({ nick: st.data.nick, type: st.data.type, days, thresholds });
    await tg.sendMessage(ctx.chatId, 'Ваш запрос добавлен. Ожидайте обновления и помощи', { threadId: ctx.threadId });
    store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
  }

  async function handleMessage(ctx) {
    const st = store.get(ctx.chatId, ctx.threadId);
    if (st.state === 'expect_new_time') return onNewTime(ctx, st);
    if (st.state === 'except_create_nick') return onNick(ctx, st);
    if (st.state === 'except_create_count') return onCount(ctx, st);
    if (st.state === 'expect_thresh_value') return onThreshValue(ctx, st);

    // Неизвестный/неподключённый чат: реагируем только на /start и /farhelp (тихо в остальном)
    if (!isKnownChat(ctx.chatId, ctx.threadId)) {
      const text = String(ctx.text ?? '').trim();
      if (text.startsWith('/start')) return onStart(ctx);
      if (text.startsWith('/farhelp')) return onHelp(ctx);
      return;
    }

    const text = String(ctx.text ?? '').trim();
    if (text.startsWith('/farupdate')) return onFarUpdate(ctx);
    if (text.startsWith('/farready')) return onFarReady(ctx);
    if (text.startsWith('/farcancel')) return onFarCancel(ctx);
    if (text.startsWith('/farthresh')) return onFarThresh(ctx);
    if (text.startsWith('/farcreate')) return onFarCreate(ctx);
    if (text.startsWith('/toptop')) return onTopTop(ctx);
    if (text.startsWith('/farhelp')) return onHelp(ctx);
  }

  async function handleCallback(ctx) {
    const st = store.get(ctx.chatId, ctx.threadId);
    const data = ctx.data ?? '';

    if (data.split('_')[0] === 'update') {
      const rowId = data.substring('update_'.length);
      const { api } = await queueFor(ctx);
      const queue = await api.readQueue();
      const row = api.findById(api.actualRows(queue), rowId);
      if (!row) {
        await tg.editMessageText(ctx.chatId, ctx.messageId, 'Запись не найдена или уже закрыта');
        store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
        return;
      }
      const actionId = `${row['Ник']} - ${row['Тип']}`;
      store.set(ctx.chatId, ctx.threadId, 'expect_new_time', { actionId, nick: row['Ник'], type: row['Тип'] });
      await tg.editMessageText(ctx.chatId, ctx.messageId, `Введите новое значение в днях для ${actionId}`);
      return;
    }

    if (data.split('_')[0] === 'ready') {
      const rowId = data.substring('ready_'.length);
      const { api } = await queueFor(ctx);
      const queue = await api.readQueue();
      const row = api.findById(api.actualRows(queue), rowId);
      if (row) {
        await api.updateRow(row, { 'Статус': 'Готово', 'Время обновления': localISO(new Date()) });
        await tg.editMessageText(ctx.chatId, ctx.messageId, `Заявка выполнена: ${row['Ник']}`);
      } else {
        await tg.editMessageText(ctx.chatId, ctx.messageId, 'Запись не найдена или уже закрыта');
      }
      store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
      return;
    }

    if (data.split('_')[0] === 'cancel') {
      const rowId = data.substring('cancel_'.length);
      const { api } = await queueFor(ctx);
      const queue = await api.readQueue();
      const row = api.findById(api.actualRows(queue), rowId);
      if (row) {
        await api.updateRow(row, { 'Статус': 'Отменено', 'Время обновления': localISO(new Date()) });
        await tg.editMessageText(ctx.chatId, ctx.messageId, `Заявка отменена: ${row['Ник']}`);
      } else {
        await tg.editMessageText(ctx.chatId, ctx.messageId, 'Запись не найдена или уже закрыта');
      }
      store.set(ctx.chatId, ctx.threadId, 'finish_command', {});
      return;
    }

    if (data.split('_')[0] === 'allow' || data.split('_')[0] === 'deny') {
      const [, targetChat, targetThr] = data.split('_');
      const targetThread = targetThr === 'none' ? undefined : targetThr;
      const rec = chats.get(targetChat, targetThread);
      const name = rec?.title ? `«${rec.title}»` : `chat ${targetChat}`;
      if (data.split('_')[0] === 'deny') {
        chats.set(targetChat, targetThread, {
          chatId: targetChat,
          threadId: targetThread ?? '',
          spreadsheetId: rec?.spreadsheetId,
          title: rec?.title ?? '',
          allowed: false,
          pending: false,
          thresholds: rec?.thresholds ?? config.typeThresholds,
        });
        await tg.editMessageText(ctx.chatId, ctx.messageId, `Отказано: ${name}`);
        await tg.sendMessage(targetChat, 'Вам отказано. Для более подробной информации свяжитесь с @Marimysh', {
          threadId: targetThread,
        });
        return;
      }
      try {
        const sheetName = sheetNameForChat(rec?.title, targetChat);
        const { spreadsheetId, url } = await createChatSheet(sheetName);
        chats.set(targetChat, targetThread, {
          chatId: targetChat,
          threadId: targetThread ?? '',
          spreadsheetId,
          title: rec?.title ?? '',
          allowed: true,
          pending: false,
          thresholds: rec?.thresholds ?? config.typeThresholds,
        });
        await tg.editMessageText(ctx.chatId, ctx.messageId, `Разрешено: ${name}. Таблица «${sheetName}»`);
        const target = requestsTarget();
        await tg.sendMessage(
          target.chatId,
          `Таблица очереди для ${name}: «${sheetName}»\n${url}`,
          { threadId: target.threadId },
        );
        await tg.sendMessage(targetChat, '✅ Ваш чат подключён к FAR Помощь. Справка: /farhelp', { threadId: targetThread });
      } catch (e) {
        log('create sheet error', e);
        await tg.editMessageText(ctx.chatId, ctx.messageId, `Ошибка создания таблицы для ${name}: ${String(e).slice(0, 200)}`);
      }
      return;
    }

    if (data.split('_')[0] === 'thresh') {
      if (st.state !== 'expect_thresh_type') {
        log('callback dropped', { chat: ctx.chatId, thread: ctx.threadId, data, reason: 'state_mismatch' });
        return;
      }
      const type = data.split('_')[1];
      store.set(ctx.chatId, ctx.threadId, 'expect_thresh_value', { type });
      await tg.editMessageText(ctx.chatId, ctx.messageId, `Введите порог в днях для «${type}» (целое число)`);
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
        return;
      }
      log('callback dropped', { chat: ctx.chatId, thread: ctx.threadId, data, reason: 'state_mismatch' });
      return;
    }

    // Неизвестный callback (старая клавиатура от прошлой версии и т.п.)
    log('callback dropped', { chat: ctx.chatId, thread: ctx.threadId, data, reason: 'unknown' });
  }

  async function handleUpdate(update) {
    const message = update.message;
    const cb = update.callback_query;

    if (cb) {
      const chatId = String(cb.message?.chat?.id);
      const threadId = cb.message?.message_thread_id;
      if (!isAllowed(chatId, threadId) && !isAdminChat(chatId)) {
        // Формат 'callback dropped' парсится скриптом scripts/far-bot-metrics.sh
        log('callback dropped', { chat: chatId, thread: threadId, data: cb.data, reason: 'not_allowed' });
        return;
      }
      const ctx = {
        chatId,
        threadId,
        data: cb.data,
        callbackQueryId: cb.id,
        messageId: cb.message?.message_id,
        userId: cb.from?.id != null ? String(cb.from.id) : undefined,
      };
      tg.answerCallbackQuery(ctx.callbackQueryId).catch((e) => log('answerCallbackQuery error', e));
      return handleCallback(ctx);
    }

    if (message) {
      // Гейтинга здесь нет намеренно: неизвестный чат должен дойти до
      // handleMessage, чтобы ответить на /start и /farhelp (заявка на доступ).
      const chatId = String(message.chat?.id);
      const threadId = message.message_thread_id;
      const ctx = {
        chatId,
        threadId,
        text: message.text,
        messageId: message.message_id,
        from: message.from,
        userId: message.from?.id != null ? String(message.from.id) : undefined,
        title: message.chat?.title,
      };
      return handleMessage(ctx);
    }
  }

  return { handleUpdate };
}
