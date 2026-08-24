'use strict';

const { formatThai, relativeThai } = require('./datetime');

const ACCENT = '#2E7D6B';

const text = (t) => ({ type: 'text', text: t });

/** Flex bubble asking the user to confirm a freshly parsed reminder. */
function confirmFlex({ id, title, deadlineIso, category }) {
  const rows = [
    { label: 'งาน', value: title },
    { label: 'กำหนด', value: formatThai(deadlineIso) },
  ];
  if (category) rows.push({ label: 'หมวด', value: category });

  return {
    type: 'flex',
    altText: 'ยืนยันเตือนความจำ: ' + title + ' — ' + formatThai(deadlineIso),
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        backgroundColor: ACCENT,
        contents: [
          {
            type: 'text',
            text: 'เช็กให้หน่อยว่าถูกไหม',
            color: '#FFFFFF',
            size: 'md',
            weight: 'bold',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: rows.map((row) => ({
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            { type: 'text', text: row.label, size: 'sm', color: '#8C8C8C', flex: 2 },
            { type: 'text', text: row.value, size: 'sm', color: '#111111', flex: 5, wrap: true },
          ],
        })),
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'ยกเลิก',
              data: 'action=cancel&id=' + id,
              displayText: 'ยกเลิก',
            },
          },
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            color: ACCENT,
            action: {
              type: 'postback',
              label: 'ยืนยัน',
              data: 'action=confirm&id=' + id,
              displayText: 'ยืนยัน',
            },
          },
        ],
      },
    },
  };
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

const savedText = (r) =>
  text('บันทึกแล้ว ✅\n#' + r.id + ' ' + r.title + '\nกำหนด ' + formatThai(r.deadline_iso) +
    '\nเดี๋ยวเตือนล่วงหน้า 1 วัน, เตือนอีกที 1 ชั่วโมงก่อนถึงกำหนด และเตือนตอนถึงกำหนดจริง');

const cancelledText = () => text('ยกเลิกให้แล้ว ไม่ได้บันทึกอะไรไว้ 👌\nลองพิมพ์ใหม่อีกทีได้เลย');

const notFoundText = (id) =>
  text('ไม่เจอรายการ #' + id + ' นะ อาจจะถูกลบไปแล้ว\nลองดูรายการที่ค้างด้วย /list');

const doneText = (r) => text('เยี่ยม! ปิดงาน #' + r.id + ' "' + r.title + '" เรียบร้อย 🎯');

const deletedText = (r) => text('ลบรายการ #' + r.id + ' "' + r.title + '" ออกให้แล้ว 🗑️');

const helpText = () =>
  text(
    [
      'ใช้งานยังไงดี 👇',
      '',
      '• พิมพ์งานพร้อมกำหนดส่งมาได้เลย เช่น "ส่งรายงาน JS วันศุกร์นี้บ่าย 3 โมง"',
      '• /list — ดูงานที่ยังค้าง',
      '• /done <เลขที่> — ปิดงานที่ทำเสร็จแล้ว',
      '• /delete <เลขที่> — ลบงานทิ้ง',
    ].join('\n')
  );

const parseFailText = (code) => {
  if (code === 'no_api_key') {
    return text('ตอนนี้ระบบอ่านข้อความยังไม่พร้อมใช้งาน (ยังไม่ได้ตั้งค่า API key) 🙏\nลองใหม่อีกทีทีหลังนะ');
  }
  // Reachable from either provider now that Ox Alpha is primary and Gemini is
  // the fallback — the wording stays deliberately provider-agnostic.
  if (code === 'http_429') {
    return text('ตอนนี้ตัวช่วยอ่านข้อความคิวแน่นไปหน่อย 🚦\nรอสักครู่แล้วส่งข้อความเดิมมาใหม่นะ');
  }
  if (code === 'network' || (code || '').startsWith('http_')) {
    return text('ตัวช่วยอ่านข้อความล่มไปแป๊บนึง 😵‍💫\nรบกวนส่งข้อความเดิมมาใหม่อีกทีนะ');
  }
  return text(
    [
      'ยังจับใจความไม่ได้ว่าจะให้เตือนอะไร ตอนไหน 🤔',
      'ลองเขียนให้มีทั้ง "งาน" กับ "เวลา" เช่น',
      '• ส่งรายงาน JS วันศุกร์นี้บ่าย 3 โมง',
      '• นัดหมอพรุ่งนี้ 10 โมงเช้า',
      '',
      'หรือพิมพ์ /help ดูคำสั่งทั้งหมด',
    ].join('\n')
  );
};

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

const duePush = (r) =>
  text('🔔 ถึงกำหนดแล้ว!\n#' + r.id + ' ' + r.title + '\n' + formatThai(r.deadline_iso) +
    '\nทำเสร็จแล้วพิมพ์ /done ' + r.id);

module.exports = {
  text,
  confirmFlex,
  listText,
  savedText,
  cancelledText,
  notFoundText,
  doneText,
  deletedText,
  helpText,
  parseFailText,
  errorText,
  dayBeforePush,
  hourBeforePush,
  duePush,
  digestPush,
};
