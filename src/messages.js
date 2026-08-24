'use strict';

const { formatThai, relativeThai } = require('./datetime');

const text = (t) => ({ type: 'text', text: t });

/**
 * Reply to a parked free-text message.
 * Deliberately cheap: no model call happens at receive time any more, so this
 * has to be a fixed string.
 */
const inboxAckText = () =>
  text('รับทราบ จดไว้ให้แล้ว 📝\nเดี๋ยวสรุปให้ตอนเที่ยงคืนนะ');

/** Text list of pending reminders, soonest first. */
function listText(rows) {
  if (!rows.length) {
    return text('ตอนนี้ยังไม่มีงานค้างนะ ว่าง ๆ เลย 🎉\nพิมพ์งานพร้อมกำหนดส่งมาได้เลย เดี๋ยวจดให้');
  }
  const lines = rows.map((r) => {
    const head = '#' + r.id + ' ' + r.title;
    const meta = '   ' + formatThai(r.deadline_iso) + ' (' + relativeThai(r.deadline_iso) + ')';
    const cat = r.category ? '   หมวด: ' + r.category : null;
    return [head, meta, cat].filter(Boolean).join('\n');
  });
  return text(
    'งานที่ค้างอยู่ ' + rows.length + ' รายการ\n\n' +
      lines.join('\n\n') +
      '\n\nเสร็จแล้วพิมพ์ /done <เลขที่> ได้เลย'
  );
}

const notFoundText = (id) =>
  text('ไม่เจอรายการ #' + id + ' นะ อาจจะถูกลบไปแล้ว\nลองดูรายการที่ค้างด้วย /list');

const doneText = (r) => text('เยี่ยม! ปิดงาน #' + r.id + ' "' + r.title + '" เรียบร้อย 🎯');

const deletedText = (r) => text('ลบรายการ #' + r.id + ' "' + r.title + '" ออกให้แล้ว 🗑️');

const helpText = () =>
  text(
    [
      'ใช้งานยังไงดี 👇',
      '',
      '• พิมพ์อะไรมาก็ได้ เช่น "ส่งรายงาน JS วันศุกร์นี้บ่าย 3 โมง" — เที่ยงคืนจะสรุปกลับไปให้ว่าอันไหนเป็นงาน อันไหนเป็นเรื่องคุยเล่น',
      '• /list — ดูงานที่ยังค้าง',
      '• /done <เลขที่> — ปิดงานที่ทำเสร็จแล้ว',
      '• /delete <เลขที่> — ลบงานทิ้ง',
    ].join('\n')
  );

const errorText = () =>
  text('ขออภัย ระบบสะดุดไปนิดนึง 🙏 ลองส่งใหม่อีกครั้งนะ');

const dayBeforePush = (r) =>
  text('⏰ เตือนล่วงหน้า 1 วัน\n#' + r.id + ' ' + r.title + '\nถึงกำหนด ' + formatThai(r.deadline_iso));

const hourBeforePush = (r) =>
  text('⏰ เตือนล่วงหน้า 1 ชั่วโมง\n#' + r.id + ' ' + r.title + '\nถึงกำหนด ' + formatThai(r.deadline_iso));

// A morning digest is a courtesy, not an inbox dump — past this many items the
// list stops being readable on a phone, so we point at /list instead.
const DIGEST_MAX_ITEMS = 15;

/**
 * Morning digest: one message summarising everything still pending, soonest first.
 * Returns null for an empty list — a 6am "you have nothing" ping is just noise,
 * and the scheduler skips those users before ever getting here.
 */
function digestPush(rows) {
  if (!rows.length) return null;

  const shown = rows.slice(0, DIGEST_MAX_ITEMS);
  const lines = shown.map(
    (r) =>
      '• #' + r.id + ' ' + r.title + '\n' +
      '   ' + formatThai(r.deadline_iso) + ' (' + relativeThai(r.deadline_iso) + ')'
  );
  const rest = rows.length - shown.length;
  if (rest > 0) lines.push('• …และอีก ' + rest + ' รายการ พิมพ์ /list ดูทั้งหมดได้');

  return text(
    'สวัสดีตอนเช้า ☀️\nวันนี้มีงานค้างอยู่ ' + rows.length + ' อย่างนะ\n\n' +
      lines.join('\n') +
      '\n\nอันไหนเสร็จแล้วพิมพ์ /done <เลขที่> ได้เลย สู้ ๆ 💪'
  );
}

/**
 * Midnight batch result for one user: what got turned into a reminder, plus a
 * one-paragraph recap of everything that was just chatter.
 * Returns null when both halves are empty — there is nothing worth spending a
 * push on, and the caller skips the user.
 */
function nightlyDigestPush({ reminders = [], chitChatSummary = null }) {
  if (!reminders.length && !chitChatSummary) return null;

  const parts = ['สรุปประจำวัน 🌙'];

  if (reminders.length) {
    const lines = reminders.map(
      (r) => '• #' + r.id + ' ' + r.title + '\n   กำหนด ' + formatThai(r.deadline_iso)
    );
    parts.push('จดเป็นงานให้ ' + reminders.length + ' รายการ\n\n' + lines.join('\n'));
  } else {
    parts.push('วันนี้ไม่มีข้อความไหนที่เป็นงานให้จดนะ');
  }

  if (chitChatSummary) parts.push('เรื่องที่คุยกันวันนี้ 💬\n' + chitChatSummary);

  if (reminders.length) parts.push('อันไหนเสร็จแล้วพิมพ์ /done <เลขที่> ได้เลย');

  return text(parts.join('\n\n'));
}

const duePush = (r) =>
  text('🔔 ถึงกำหนดแล้ว!\n#' + r.id + ' ' + r.title + '\n' + formatThai(r.deadline_iso) +
    '\nทำเสร็จแล้วพิมพ์ /done ' + r.id);

module.exports = {
  text,
  inboxAckText,
  listText,
  notFoundText,
  doneText,
  deletedText,
  helpText,
  errorText,
  dayBeforePush,
  hourBeforePush,
  duePush,
  digestPush,
  nightlyDigestPush,
};
