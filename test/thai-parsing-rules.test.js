'use strict';

/**
 * Regression pins for two live-confirmed Thai parsing bugs (2026-09-21).
 * Pure unit tests — no network, no LLM call, no database.
 * Run with: npm test
 *
 * SCOPE, stated plainly: both bugs live in SYSTEM_RULES, i.e. they are decided
 * by the MODEL at runtime, not by code in this repo. So these tests split in
 * two:
 *   1. Prompt pins — assert the corrected instruction text is still present and
 *      the wrong wording has not come back. This is what actually stops a
 *      silent regression of the rule itself.
 *   2. finalizeResult pins — assert the pure, network-free core handles the
 *      CORRECT model output correctly (no day shift on 23:00 ICT) and that the
 *      recurring flag really does destroy the deadline, which is why Bug B was
 *      severe rather than cosmetic.
 * What remains model-dependent and CANNOT be asserted here: that the model
 * actually emits 23:00 for "5 ทุ่ม", and actually emits recurring:false for
 * "สิ้นเดือนจ่ายค่าหอ". Only a live call proves that.
 */

const test = require('node:test');
const assert = require('node:assert');

const { finalizeResult, SYSTEM_RULES } = require('../src/gemini');

// -----------------------------------------------------------------------------
// Bug A — Thai "ทุ่ม" hour arithmetic (n ทุ่ม = (18+n):00)
// -----------------------------------------------------------------------------

test('prompt states n ทุ่ม = (18+n):00, not 19:00 + n', () => {
  assert.ok(
    SYSTEM_RULES.includes('(18+n):00'),
    'SYSTEM_RULES must state the ทุ่ม conversion as (18+n):00'
  );
  assert.ok(
    !SYSTEM_RULES.includes('19:00 + n'),
    'the off-by-one form "19:00 + n" must not reappear'
  );
});

test('prompt carries worked ทุ่ม examples including 5 ทุ่ม = 23:00', () => {
  for (const example of [
    '1 ทุ่ม = 19:00',
    '2 ทุ่ม = 20:00',
    '3 ทุ่ม = 21:00',
    '4 ทุ่ม = 22:00',
    '5 ทุ่ม = 23:00',
  ]) {
    assert.ok(SYSTEM_RULES.includes(example), 'missing worked example: ' + example);
  }
});

test('23:00 ICT ("5 ทุ่ม") stays on the SAME Thai day through finalizeResult', () => {
  // The live failure returned 2026-09-21T17:00Z = 00:00 ICT on Sep 22 — wrong
  // hour AND wrong day. With the corrected 23:00, the UTC instant must be
  // 16:00Z on Sep 21, which is still Sep 21 in ICT.
  const now = new Date('2026-09-21T09:00:00Z'); // 16:00 ICT, Mon 21 Sep
  const raw = JSON.stringify({
    title: 'กินยา',
    deadline_iso: '2026-09-21T23:00:00+07:00',
    relative_weekday: null,
    weekday_qualifier: null,
    time_of_day: null,
    category: 'สุขภาพ',
    recurring: false,
    confident: true,
  });

  const result = finalizeResult(raw, 'test', now, 'เตือนฉันตอน 5 ทุ่มกินยา');
  assert.strictEqual(result.deadlineIso, '2026-09-21T16:00:00.000Z');
  // Same assertion read back in Thai local terms, so the failure message is
  // about the day, not about an opaque UTC string.
  const ictDay = new Date(
    new Date(result.deadlineIso).getTime() + 7 * 3600000
  ).toISOString().slice(0, 10);
  assert.strictEqual(ictDay, '2026-09-21', '5 ทุ่ม must not roll into the next Thai day');
});

test('the old off-by-one output (00:00 next day) is a DIFFERENT instant', () => {
  // Guards the test above against being trivially true: proves the wrong answer
  // would in fact be caught.
  const now = new Date('2026-09-21T09:00:00Z');
  const wrong = finalizeResult(
    JSON.stringify({ title: 'กินยา', deadline_iso: '2026-09-22T00:00:00+07:00', recurring: false, confident: true }),
    'test',
    now,
    'เตือนฉันตอน 5 ทุ่มกินยา'
  );
  assert.notStrictEqual(wrong.deadlineIso, '2026-09-21T16:00:00.000Z');
  assert.strictEqual(wrong.deadlineIso, '2026-09-21T17:00:00.000Z'); // the observed bug
});

// -----------------------------------------------------------------------------
// Bug B — "สิ้นเดือน" must not be classified as recurring
// -----------------------------------------------------------------------------

test('prompt requires an explicit repetition token for recurring: true', () => {
  for (const token of ['"ทุกวัน"', '"ทุกสัปดาห์"', '"ทุกเดือน"', '"ทุกปี"']) {
    assert.ok(SYSTEM_RULES.includes(token), 'missing repetition token in prompt: ' + token);
  }
  assert.ok(
    SYSTEM_RULES.includes('ถ้าไม่มีคำเหล่านั้น ให้ recurring เป็น false เสมอ'),
    'prompt must state the default-false rule when no repetition token is present'
  );
});

test('prompt names สิ้นเดือน / สิ้นปี as explicit non-recurring examples', () => {
  assert.ok(SYSTEM_RULES.includes('"สิ้นเดือนจ่ายค่าหอ"'), 'missing negative example สิ้นเดือนจ่ายค่าหอ');
  assert.ok(SYSTEM_RULES.includes('"สิ้นปีส่งรายงาน"'), 'missing negative example สิ้นปีส่งรายงาน');
});

test('prompt gives concrete date resolution for สิ้นเดือน / สิ้นปี', () => {
  assert.ok(SYSTEM_RULES.includes('"สิ้นเดือน" = วันสุดท้ายของเดือนปัจจุบัน'));
  assert.ok(SYSTEM_RULES.includes('"สิ้นปี" = 31 ธันวาคม ของปีปัจจุบัน'));
});

test('"สิ้นเดือนจ่ายค่าหอ" keeps its deadline when not flagged recurring', () => {
  const now = new Date('2026-09-21T09:00:00Z');
  const raw = JSON.stringify({
    title: 'จ่ายค่าหอ',
    deadline_iso: '2026-09-30T09:00:00+07:00', // last day of September
    relative_weekday: null,
    weekday_qualifier: null,
    time_of_day: null,
    category: 'การเงิน',
    recurring: false,
    confident: true,
  });

  const result = finalizeResult(raw, 'test', now, 'สิ้นเดือนจ่ายค่าหอ');
  assert.strictEqual(result.recurring, false);
  assert.strictEqual(result.deadlineIso, '2026-09-30T02:00:00.000Z'); // 09:00 ICT
});

test('recurring: true still destroys the deadline — why Bug B was data loss', () => {
  // Documents the mechanism rather than merely the symptom: if the model
  // mislabels a dated obligation as recurring, finalizeResult drops the date and
  // the bot schedules nothing at all.
  const now = new Date('2026-09-21T09:00:00Z');
  const raw = JSON.stringify({
    title: 'จ่ายค่าหอ',
    deadline_iso: '2026-09-30T09:00:00+07:00',
    recurring: true,
    confident: true,
  });

  const result = finalizeResult(raw, 'test', now, 'สิ้นเดือนจ่ายค่าหอ');
  assert.strictEqual(result.recurring, true);
  assert.strictEqual(result.deadlineIso, null);
});
