'use strict';

const store = require('./db');
const msg = require('./messages');
const { reply } = require('./line');
const { parseReminder, chatReply, ParseError } = require('./gemini');

// How many past turns ride along in the chat prompt. Enough to hold a thread
// across a few exchanges without letting the prompt grow unbounded.
const CHAT_HISTORY_TURNS = 12;

/** Match "/done 12" / "/delete 12" / "/list" — tolerant of extra spaces. */
const COMMAND_RE = /^\/(list|done|delete|help)\b\s*(.*)$/i;

function parseIdArg(arg) {
  const m = String(arg || '').trim().match(/^#?(\d+)$/);
  return m ? Number(m[1]) : null;
}

async function handleCommand(cmd, arg, userId, replyToken) {
  switch (cmd) {
    case 'list':
      return reply(replyToken, msg.listText(store.listPending(userId)));

    case 'help':
      return reply(replyToken, msg.helpText());

    case 'done':
    case 'delete': {
      const id = parseIdArg(arg);
      if (id === null) {
        return reply(
          replyToken,
          msg.text('ใส่เลขที่รายการด้วยนะ เช่น /' + cmd + ' 3\nดูเลขที่ได้จาก /list')
        );
      }
      // Ownership check and mutation are both scoped by userId — no cross-user access.
      const row = store.getReminder(id, userId);
      if (!row) return reply(replyToken, msg.notFoundText(id));

      if (cmd === 'done') {
        if (row.status === 'done') {
          return reply(replyToken, msg.text('รายการ #' + id + ' ปิดไปแล้วนะ 😉'));
        }
        if (!store.markDone(id, userId)) return reply(replyToken, msg.notFoundText(id));
        return reply(replyToken, msg.doneText(row));
      }

      if (!store.deleteReminder(id, userId)) return reply(replyToken, msg.notFoundText(id));
      return reply(replyToken, msg.deletedText(row));
    }

    default:
      return reply(replyToken, msg.helpText());
  }
}

/**
 * Answer a message that was not a task, in conversation.
 * Only the chat turns are stored here — the raw inbox row was already written
 * by the caller, and the two logs serve different jobs.
 * A ParseError means the chat call itself failed; a canned ack beats silence,
 * and the nightly recap it mentions genuinely still runs.
 */
async function replyAsChat(text, userId, replyToken) {
  const history = store.getRecentChatHistory(userId, CHAT_HISTORY_TURNS);

  let chatText;
  try {
    chatText = await chatReply(text, history, new Date());
  } catch (err) {
    if (!(err instanceof ParseError)) throw err;
    return reply(replyToken, msg.inboxAckText());
  }

  const now = new Date().toISOString();
  store.saveChatMessage({ lineUserId: userId, role: 'user', content: text, createdAt: now });
  store.saveChatMessage({
    lineUserId: userId,
    role: 'assistant',
    content: chatText,
    createdAt: now,
  });
  return reply(replyToken, msg.text(chatText));
}

/**
 * Log the message, then parse it right away so a reminder shows up in /list the
 * moment it is sent. The inbox row is kept regardless of the parse outcome — it
 * is the raw record the midnight job recaps the whole day's conversation from.
 * There is no draft/confirm step: a successful parse goes straight to 'pending'.
 */
async function handleFreeText(text, userId, replyToken) {
  store.saveInboxMessage({
    lineUserId: userId,
    text,
    createdAt: new Date().toISOString(),
  });

  let parsed;
  try {
    parsed = await parseReminder(text);
  } catch (err) {
    // A ParseError — including 'low_confidence' — just means this was not a
    // task. Anything else is a real failure and belongs to handleEvent's catch.
    if (!(err instanceof ParseError)) throw err;
    return replyAsChat(text, userId, replyToken);
  }

  const id = store.createPendingReminder({
    lineUserId: userId,
    title: parsed.title,
    deadlineIso: parsed.deadlineIso,
    category: parsed.category,
  });
  return reply(
    replyToken,
    msg.reminderAddedText({
      id,
      title: parsed.title,
      deadlineIso: parsed.deadlineIso,
      category: parsed.category,
    })
  );
}

/**
 * Route one LINE webhook event. Never throws — a failure here must not
 * make the whole webhook request 500 and trigger LINE-side retries.
 */
async function handleEvent(event) {
  const userId = event.source && event.source.userId;
  const replyToken = event.replyToken;

  try {
    if (!userId || !replyToken) return; // e.g. group event without a user id

    if (event.type === 'follow') {
      return await reply(replyToken, [
        msg.text('ยินดีที่ได้รู้จัก! ผมเป็นตัวช่วยจดงานและเตือนก่อนถึงกำหนดให้ 🙌'),
        msg.helpText(),
      ]);
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
      if (event.type === 'message') {
        return await reply(
          replyToken,
          msg.text('ตอนนี้ผมอ่านได้แค่ข้อความตัวอักษรนะ ลองพิมพ์งานพร้อมกำหนดส่งมาได้เลย')
        );
      }
      return;
    }

    const text = (event.message.text || '').trim();
    if (!text) return;

    const command = text.match(COMMAND_RE);
    if (command) {
      return await handleCommand(command[1].toLowerCase(), command[2], userId, replyToken);
    }

    return await handleFreeText(text, userId, replyToken);
  } catch (err) {
    console.error('[webhook] event handling error:', err && err.message);
    if (replyToken) {
      // Best effort — the reply token may already be spent or expired.
      try {
        await reply(replyToken, msg.errorText());
      } catch (replyErr) {
        console.error('[webhook] failed to send error reply:', replyErr && replyErr.message);
      }
    }
  }
}

module.exports = { handleEvent };
