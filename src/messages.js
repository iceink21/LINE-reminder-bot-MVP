'use strict';

const { formatThai, relativeThai } = require('./datetime');

const text = (t) => ({ type: 'text', text: t });

/**
 * Reply for a message the parser rejected — i.e. genuinely not a task.
 * It must not promise a reminder later: anything that parses as one is already
 * a reminder by the time this string is reached.
 */
const inboxAckText = () =>
  text('รับทราบ 📝\nเดี๋ยวสรุปบทสนทนาของวันนี้ให้ตอนเที่ยงคืนนะ');

/** Confirmation for a reminder created straight from the message just sent. */
function reminderAddedText({ id, title, deadlineIso, category }) {
  const lines = [
    'จดให้แล้ว ✅',
    '#' + id + ' ' + title,
    'กำหนด ' + formatThai(deadlineIso) + ' (' + relativeThai(deadlineIso) + ')',
  ];
  if (category) lines.push('หมวด: ' + category);
  lines.push('', 'ดูงานค้างทั้งหมด /list · เสร็จแล้วพิมพ์ /done ' + id);
  return text(lines.join('\n'));
}

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
      '• พิมพ์อะไรมาก็ได้ เช่น "ส่งรายงาน JS วันศุกร์นี้บ่าย 3 โมง" — ถ้าเป็นงาน จะจดให้ทันที ส่วนเรื่องคุยเล่นจะสรุปให้ตอนเที่ยงคืน',
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
 * Midnight recap of the whole day's conversation for one user.
 * Returns null when there is no summary — a "nothing happened" ping is not
 * worth a push, and the caller skips the user.
 */
function dailyRecapPush(summary) {
  if (!summary) return null;
  return text('สรุปบทสนทนาวันนี้ 🌙\n\n' + summary);
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
  reminderAddedText,
  dailyRecapPush,
};
