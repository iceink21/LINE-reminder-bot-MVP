'use strict';

const store = require('./db');
const msg = require('./messages');
const { reply } = require('./line');

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
 * Park the message and answer immediately.
 * No model call happens here any more: classification is batched to 00:00, so
 * receiving a message costs one cheap (and quota-free) reply and one INSERT.
 * `created_at` is UTC ISO, matching reminders.created_at — the nightly job
 * needs it to resolve relative dates ("พรุ่งนี้") against when the message was
 * actually sent, not against midnight.
 */
async function handleFreeText(text, userId, replyToken) {
  store.saveInboxMessage({
    lineUserId: userId,
    text,
    createdAt: new Date().toISOString(),
  });
  return reply(replyToken, msg.inboxAckText());
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
