'use strict';

const { formatThai, relativeThai } = require('./datetime');

const text = (t) => ({ type: 'text', text: t });

/**
 * Last-resort reply when the message was not a task AND the chat call failed.
 * It must not promise a reminder later: anything that parses as one is already
 * a reminder by the time this string is reached. The midnight recap it points
 * at is real — that job runs off the inbox row, which was saved either way.
 */
const inboxAckText = () =>
  text('รับทราบ 📝\nตอนนี้ผมตอบยาว ๆ ไม่ไหวแป๊บนึง แต่เดี๋ยวสรุปบทสนทนาของวันนี้ให้ตอนเที่ยงคืนนะ');

// Marker for a standing reminder — one that repeats every day and has no
// deadline to count down to.
const STANDING_MARK = '🔁 ทุกวัน';

/**
 * Split pending rows into the two shapes that render differently.
 * The test is the deadline itself, not `repeat`: what breaks the renderers is
 * feeding a null into formatThai/relativeThai, so the guard sits on exactly
 * that. Order inside each bucket is untouched, so the scheduled bucket keeps
 * the soonest-first ordering `listPending` handed over.
 */
function splitByKind(rows) {
  const scheduled = [];
  const standing = [];
  for (const r of rows) (r.deadline_iso ? scheduled : standing).push(r);
  return { scheduled, standing };
}

/** Confirmation for a reminder created straight from the message just sent. */
function reminderAddedText({ id, title, deadlineIso, category, recurring }) {
  // No deadline means there is nothing to print on a "กำหนด ..." line, so the
  // standing case gets its own copy rather than a formatted null.
  const isStanding = recurring || !deadlineIso;
  const lines = isStanding
    ? ['จดให้แล้ว ✅', '#' + id + ' ' + title, STANDING_MARK + ' — ไม่มีกำหนดส่ง']
    : [
        'จดให้แล้ว ✅',
        '#' + id + ' ' + title,
        'กำหนด ' + formatThai(deadlineIso) + ' (' + relativeThai(deadlineIso) + ')',
      ];
  if (category) lines.push('หมวด: ' + category);
  if (isStanding) {
    lines.push(
      '',
      'เดี๋ยวเตือนให้ทุกเช้า 6 โมงนะ',
      'ไม่อยากให้เตือนแล้วพิมพ์ /done ' + id + ' หรือ /delete ' + id
    );
  } else {
    lines.push('', 'ดูงานค้างทั้งหมด /list · เสร็จแล้วพิมพ์ /done ' + id);
  }
  return text(lines.join('\n'));
}

/**
 * Confirmation for `/edit`: same two shapes as `reminderAddedText`, because the
 * re-parse can flip a dated task into a standing one (or back) and the reply has
 * to show whichever the row actually became — the id is what stayed the same.
 */
function editedText(r) {
  const isStanding = !r.deadline_iso;
  const lines = isStanding
    ? ['แก้ให้แล้ว ✏️', '#' + r.id + ' ' + r.title, STANDING_MARK + ' — ไม่มีกำหนดส่ง']
    : [
        'แก้ให้แล้ว ✏️',
        '#' + r.id + ' ' + r.title,
        'กำหนด ' + formatThai(r.deadline_iso) + ' (' + relativeThai(r.deadline_iso) + ')',
      ];
  if (r.category) lines.push('หมวด: ' + r.category);
  // An edit can turn a dated task into a standing one, and the two are nudged by
  // different jobs — so the footer has to explain whichever it just became,
  // matching what reminderAddedText promises for that same shape.
  if (isStanding) {
    lines.push(
      '',
      'เดี๋ยวเตือนให้ทุกเช้า 6 โมงนะ',
      'ไม่อยากให้เตือนแล้วพิมพ์ /done ' + r.id + ' หรือ /delete ' + r.id
    );
  } else {
    lines.push('', 'ดูงานค้างทั้งหมด /list · เสร็จแล้วพิมพ์ /done ' + r.id);
  }
  return text(lines.join('\n'));
}

/** One scheduled row: title, then its deadline and countdown. */
function scheduledLines(r) {
  const head = '#' + r.id + ' ' + r.title;
  const meta = '   ' + formatThai(r.deadline_iso) + ' (' + relativeThai(r.deadline_iso) + ')';
  const cat = r.category ? '   หมวด: ' + r.category : null;
  return [head, meta, cat].filter(Boolean).join('\n');
}

/** One standing row: title plus the repeat marker — no date formatting at all. */
function standingLines(r) {
  const head = '#' + r.id + ' ' + r.title;
  const meta = '   ' + STANDING_MARK;
  const cat = r.category ? '   หมวด: ' + r.category : null;
  return [head, meta, cat].filter(Boolean).join('\n');
}

/** Text list of pending reminders: deadlines soonest first, then standing ones. */
function listText(rows) {
  if (!rows.length) {
    return text('ตอนนี้ยังไม่มีงานค้างนะ ว่าง ๆ เลย 🎉\nพิมพ์งานพร้อมกำหนดส่งมาได้เลย เดี๋ยวจดให้');
  }
  const { scheduled, standing } = splitByKind(rows);
  const blocks = [];
  if (scheduled.length) {
    blocks.push('📌 มีกำหนดส่ง\n\n' + scheduled.map(scheduledLines).join('\n\n'));
  }
  if (standing.length) {
    blocks.push('🔁 ทำทุกวัน\n\n' + standing.map(standingLines).join('\n\n'));
  }
  return text(
    'งานที่ค้างอยู่ ' + rows.length + ' รายการ\n\n' +
      blocks.join('\n\n') +
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
      '• พิมพ์อะไรมาก็ได้ เช่น "ส่งรายงาน JS วันศุกร์นี้บ่าย 3 โมง" — ถ้าเป็นงาน จะจดให้ทันที ถ้าคุยเล่นก็ตอบคุยด้วยได้เลย',
      '• งานที่ทำทุกวัน เช่น "กินยาทุกวัน" ก็จดได้ ไม่ต้องมีกำหนดส่ง เดี๋ยวเตือนให้ทุกเช้าจนกว่าจะสั่ง /done',
      '• /list — ดูงานที่ยังค้าง',
      '• /done <เลขที่> — ปิดงานที่ทำเสร็จแล้ว',
      '• /edit <เลขที่> <ข้อความใหม่> — แก้ชื่องานหรือกำหนดส่ง โดยไม่ต้องลบแล้วพิมพ์ใหม่',
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

/** Cap one section and append a "…and N more" line when it overflows. */
function cappedSection(rows, render) {
  const shown = rows.slice(0, DIGEST_MAX_ITEMS);
  const lines = shown.map(render);
  const rest = rows.length - shown.length;
  if (rest > 0) lines.push('• …และอีก ' + rest + ' รายการ พิมพ์ /list ดูทั้งหมดได้');
  return lines.join('\n');
}

/**
 * Morning digest: one message covering everything still pending — deadlines
 * soonest first, then the standing daily reminders. This is the ONLY delivery
 * slot standing reminders get: the 06:00 cron fires exactly once a day, so
 * "nudge me every day" needs no extra job, no extra push quota and no
 * already-notified-today bookkeeping.
 *
 * Returns null only when BOTH lists are empty — a 6am "you have nothing" ping
 * is just noise, and the scheduler skips those users before ever getting here.
 */
function digestPush(rows) {
  if (!rows.length) return null;
  const { scheduled, standing } = splitByKind(rows);

  const blocks = [];
  if (scheduled.length) {
    blocks.push(
      '📌 มีกำหนดส่ง\n' +
        cappedSection(
          scheduled,
          (r) =>
            '• #' + r.id + ' ' + r.title + '\n' +
            '   ' + formatThai(r.deadline_iso) + ' (' + relativeThai(r.deadline_iso) + ')'
        )
    );
  }
  if (standing.length) {
    blocks.push(
      '🔁 ทำทุกวัน\n' +
        cappedSection(standing, (r) => '• #' + r.id + ' ' + r.title + '\n   ' + STANDING_MARK)
    );
  }

  return text(
    'สวัสดีตอนเช้า ☀️\nวันนี้มีงานค้างอยู่ ' + rows.length + ' อย่างนะ\n\n' +
      blocks.join('\n\n') +
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
  editedText,
  helpText,
  errorText,
  dayBeforePush,
  hourBeforePush,
  duePush,
  digestPush,
  reminderAddedText,
  dailyRecapPush,
};
