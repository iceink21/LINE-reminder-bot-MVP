'use strict';

const store = require('./db');
const msg = require('./messages');
const { reply } = require('./line');
const {
  parseReminder,
  chatReply,
  ParseError,
  isProviderFailure,
  newEventDeadline,
} = require('./gemini');

// How many past turns ride along in the chat prompt. Enough to hold a thread
// across a few exchanges without letting the prompt grow unbounded.
const CHAT_HISTORY_TURNS = 12;

/** Match "/done 12" / "/edit 12 ..." / "/list" — tolerant of extra spaces. */
// The `s` flag matters for `/edit`: without it `(.*)$` stops at the first
// newline, the whole match fails, and a multi-line edit falls through to
// handleFreeText — which creates a duplicate reminder instead of editing.
const COMMAND_RE = /^\/(list|done|delete|edit|help)\b\s*(.*)$/is;

function parseIdArg(arg) {
  const m = String(arg || '').trim().match(/^#?(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Split "12 ส่งรายงานพรุ่งนี้บ่าย 2" into its id and the rest.
 * `/edit` is the only command whose argument is more than an id, so the id has
 * to come off the front before `parseIdArg` (which anchors end-of-string) can be
 * used. The `s` flag lets a multi-line new message through intact.
 */
function parseIdAndRest(arg) {
  const m = String(arg || '').trim().match(/^#?(\d+)\s+(.+)$/s);
  if (!m) return null;
  const id = parseIdArg(m[1]);
  return id === null ? null : { id, rest: m[2].trim() };
}

async function handleCommand(cmd, arg, userId, replyToken, deadline) {
  switch (cmd) {
    case 'list':
      return reply(replyToken, msg.listText(store.listPending(userId)));

    case 'help':
      return reply(replyToken, msg.helpText());

    case 'edit': {
      const parts = parseIdAndRest(arg);
      if (!parts) {
        return reply(
          replyToken,
          msg.text(
            'ใส่เลขที่รายการแล้วตามด้วยข้อความใหม่ด้วยนะ เช่น /edit 3 ส่งรายงานพรุ่งนี้บ่าย 2\n' +
              'ดูเลขที่ได้จาก /list'
          )
        );
      }
      const { id, rest } = parts;

      // Ownership check and the update itself are both scoped by userId.
      const row = store.getReminder(id, userId);
      if (!row) return reply(replyToken, msg.notFoundText(id));
      if (row.status === 'done') {
        return reply(
          replyToken,
          msg.text('รายการ #' + id + ' ปิดไปแล้ว แก้ไม่ได้นะ 😉\nถ้าจะทำใหม่ พิมพ์เป็นงานใหม่มาได้เลย')
        );
      }

      let parsed;
      try {
        // One argument on purpose: the reference time for "พรุ่งนี้" in an edit is
        // now, not whenever the original message was sent.
        parsed = await parseReminder(rest, new Date(), { deadline });
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        // Unlike free text, a failed parse here must NOT fall through to chat —
        // the user explicitly asked to edit, so say what went wrong instead.
        return reply(
          replyToken,
          msg.text(
            'ข้อความใหม่นี้ผมอ่านเป็นงานไม่ออกนะ 🤔\n' +
              'ลองพิมพ์ให้ชัดขึ้น พร้อมวันเวลา เช่น /edit ' + id + ' ส่งรายงานพรุ่งนี้บ่าย 2'
          )
        );
      }

      const ok = store.updateReminder({
        id,
        lineUserId: userId,
        title: parsed.title,
        deadlineIso: parsed.deadlineIso,
        category: parsed.category,
        repeat: parsed.recurring ? 'daily' : null,
      });
      if (!ok) return reply(replyToken, msg.notFoundText(id));

      return reply(
        replyToken,
        msg.editedText({
          id,
          title: parsed.title,
          deadline_iso: parsed.deadlineIso,
          category: parsed.category,
          repeat: parsed.recurring ? 'daily' : null,
        })
      );
    }

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
 * and the nightly recap it mentions genuinely still runs. Reached only for a
 * verdict about the user's text — handleFreeText sends provider failures
 * straight to the same ack without spending a second chain on them.
 */
async function replyAsChat(text, userId, replyToken, deadline) {
  const history = store.getRecentChatHistory(userId, CHAT_HISTORY_TURNS);

  let chatText;
  try {
    chatText = await chatReply(text, history, new Date(), { deadline });
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
async function handleFreeText(text, userId, replyToken, deadline) {
  store.saveInboxMessage({
    lineUserId: userId,
    text,
    createdAt: new Date().toISOString(),
  });

  let parsed;
  try {
    parsed = await parseReminder(text, new Date(), { deadline });
  } catch (err) {
    // Two very different failures arrive here and they must NOT be treated
    // alike. The earlier comment claimed any ParseError "just means this was
    // not a task"; that is only true of a VERDICT about the user's text
    // ('low_confidence', 'no_title', 'no_deadline'). A PROVIDER failure
    // ('network' — which is what an AbortSignal timeout looks like — plus
    // 'http_402', 'http_503' and the rest) means the model never read the
    // message at all, and starting a second full LLM chain on the same,
    // already-partly-spent reply token cannot help: the provider is down or
    // hanging either way, and the second chain is exactly what doubled this
    // event's timeout budget. So provider failures go straight to the inbox
    // ack, which now says plainly that nothing was scheduled.
    if (!(err instanceof ParseError)) throw err;
    if (isProviderFailure(err)) {
      console.warn('[webhook] parse failed provider-side (' + err.code + ') — skipping the chat chain');
      return reply(replyToken, msg.inboxAckText());
    }
    return replyAsChat(text, userId, replyToken, deadline);
  }

  // A recurring parse has no deadline at all: it is stored with repeat='daily'
  // and rides the 06:00 digest instead of the day/hour/due sweep, so it costs no
  // extra push quota. `/done` and `/delete` stop it, same as any other row.
  const id = store.createPendingReminder({
    lineUserId: userId,
    title: parsed.title,
    deadlineIso: parsed.deadlineIso,
    category: parsed.category,
    repeat: parsed.recurring ? 'daily' : null,
  });
  return reply(
    replyToken,
    msg.reminderAddedText({
      id,
      title: parsed.title,
      deadlineIso: parsed.deadlineIso,
      category: parsed.category,
      recurring: parsed.recurring,
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
  // ONE deadline for every LLM call this event makes, fixed here at receipt.
  // The reply token started ageing before this line, so it is deliberately
  // pessimistic; see the budget note at the top of src/gemini.js.
  const deadline = newEventDeadline();

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
      return await handleCommand(
        command[1].toLowerCase(),
        command[2],
        userId,
        replyToken,
        deadline
      );
    }

    return await handleFreeText(text, userId, replyToken, deadline);
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
