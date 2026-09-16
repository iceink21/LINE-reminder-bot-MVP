'use strict';

/**
 * Pure unit tests — no network, no LLM call, no database.
 * Run with: npm test — which runs node --test over the quoted glob
 * "test/<star><star>/<star>.test.js" (written out because the literal glob would
 * close this comment). The bare `node --test test/` form does NOT work on this
 * Node build: it resolves `test/` as a module and fails with MODULE_NOT_FOUND.
 *
 * Thailand has observed no DST since 1976 and ICT is a fixed +07:00, so there
 * is no DST transition for the date arithmetic below to be tested against.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  resolveWeekday,
  resolveBareWeekReference,
  withTimeOfDay,
  toUtcIso,
} = require('../src/datetime');
const { finalizeResult, ParseError } = require('../src/gemini');

// -----------------------------------------------------------------------------
// The pin.
//
// 2026-09-15T18:30:00Z is deliberately chosen: in UTC it is Tuesday 15 Sep, but
// in ICT (+07:00) it is already 01:30 on Wednesday 16 Sep. A naive
// `new Date(now).getDay()` therefore reports the WRONG weekday here, and every
// expected value below is derived from the ICT day (Wednesday 2026-09-16).
// This is the case that proves resolveWeekday goes through tzParts.
// -----------------------------------------------------------------------------
const NOW_ICT_WED = new Date('2026-09-15T18:30:00Z'); // = 2026-09-16 01:30 ICT, Wednesday

// Hand-computed calendar, NOT re-derived with the logic under test.
//   Sep 2026:  Wed 16 | Thu 17 | Fri 18 | Sat 19 | Sun 20 | Mon 21 | Tue 22 | Wed 23
// "today" is Wed 16, and every answer is the next occurrence strictly after it.
const EXPECTED_FROM_WED_16 = {
  'อาทิตย์': '2026-09-20',
  'จันทร์': '2026-09-21',
  'อังคาร': '2026-09-22',
  'พุธ': '2026-09-23', // today is Wednesday -> skips a full week, never returns 09-16
  'พฤหัสบดี': '2026-09-17',
  'ศุกร์': '2026-09-18',
  'เสาร์': '2026-09-19',
};

const QUALIFIERS = ['this', 'next', null];

test('resolveWeekday: all 7 weekdays x {this, next, null} against a pinned now', () => {
  for (const [name, expected] of Object.entries(EXPECTED_FROM_WED_16)) {
    for (const qualifier of QUALIFIERS) {
      assert.strictEqual(
        resolveWeekday(NOW_ICT_WED, name, qualifier),
        expected,
        name + ' + ' + String(qualifier)
      );
    }
  }
});

test('resolveWeekday: "this" and "next" are intentionally identical', () => {
  for (const name of Object.keys(EXPECTED_FROM_WED_16)) {
    assert.strictEqual(
      resolveWeekday(NOW_ICT_WED, name, 'this'),
      resolveWeekday(NOW_ICT_WED, name, 'next'),
      name + ': this and next must agree'
    );
  }
});

test('resolveWeekday: today is that weekday -> skips a week, never returns today', () => {
  // ICT date at the pin is Wednesday 2026-09-16.
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'พุธ', 'this'), '2026-09-23');
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'พุธ', 'next'), '2026-09-23');
  assert.notStrictEqual(resolveWeekday(NOW_ICT_WED, 'พุธ', null), '2026-09-16');
});

test('resolveWeekday: uses the ICT calendar day, not the UTC one', () => {
  // At the pin, UTC still says Tuesday 2026-09-15. If the implementation used
  // Date#getDay() it would treat "today" as Tuesday and answer:
  //   พุธ -> 2026-09-16 (wrong; correct is 2026-09-23)
  //   อังคาร -> 2026-09-22 via the skip-a-week rule (same by luck, so not asserted)
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'พุธ', 'next'), '2026-09-23');
  assert.notStrictEqual(resolveWeekday(NOW_ICT_WED, 'พุธ', 'next'), '2026-09-16');
  // Thursday is +1 from the ICT day but +2 from the UTC day.
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'พฤหัสบดี', null), '2026-09-17');
});

test('resolveWeekday: regression — Tue 2026-09-15 + "จันทร์"/next -> 2026-09-21', () => {
  // 10:00 ICT on Tuesday 2026-09-15; the one case verified working in production.
  const tuesday = new Date('2026-09-15T03:00:00Z');
  assert.strictEqual(resolveWeekday(tuesday, 'จันทร์', 'next'), '2026-09-21');
  assert.strictEqual(resolveWeekday(tuesday, 'วันจันทร์', 'next'), '2026-09-21');
  assert.strictEqual(resolveWeekday(tuesday, 'จันทร์', 'this'), '2026-09-21');
});

test('resolveWeekday: accepts the "วัน"-prefixed form and the พฤหัส short form', () => {
  for (const [name, expected] of Object.entries(EXPECTED_FROM_WED_16)) {
    assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'วัน' + name, null), expected, 'วัน' + name);
  }
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'พฤหัส', null), '2026-09-17');
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, '  ศุกร์  ', null), '2026-09-18');
});

test('resolveWeekday: unrecognised or non-string names return null', () => {
  // Genuinely unrecognisable input must still fall through, because that is what
  // lets finalizeResult throw 'no_deadline' and webhook.js answer chit-chat with
  // chit-chat instead of inventing a reminder for it.
  const bad = [
    'Monday1',
    'จันทร',
    '',
    '   ',
    'วัน',
    'นี้',
    'วันนี้', // "today" is not a weekday name — handled by the deadline_iso path
    'constructor', // prototype key, must not resolve
    'toString',
    null,
    undefined,
    42,
    {},
    [],
    true,
  ];
  for (const value of bad) {
    assert.strictEqual(resolveWeekday(NOW_ICT_WED, value, 'next'), null, JSON.stringify(value));
  }
});

test('resolveWeekday: a trailing qualifier on the name is stripped (blocker-2 fix)', () => {
  // The single most likely model deviation: echoing the user's own wording.
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'ศุกร์นี้', null), '2026-09-18');
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'วันศุกร์หน้า', null), '2026-09-18');
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'วันศุกร์ที่จะถึง', null), '2026-09-18');
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'จันทร์นี้', 'this'), '2026-09-21');
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'พฤหัสหน้า', 'next'), '2026-09-17');
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, '  วันพุธนี้  ', null), '2026-09-23');
  // "ที่แล้ว" means LAST week. Resolving it forward is knowingly wrong-ish and
  // knowingly preferred over dropping the task — see the note in datetime.js.
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'ศุกร์ที่แล้ว', null), '2026-09-18');
});

test('resolveWeekday: bare "อาทิตย์หน้า" still resolves to Sunday (deliberate fallback)', () => {
  // Thai "อาทิตย์" means BOTH "Sunday" and "week", and bare "อาทิตย์หน้า" in
  // normal speech means "next WEEK", not "next Sunday" — so resolving it to
  // Sunday can fire a reminder up to six days early.
  //
  // That collision is NOT resolveWeekday's job: by the time a name reaches it,
  // the user's "วัน" prefix is long gone. It is handled one layer up, in
  // finalizeResult, via resolveBareWeekReference() reading the RAW USER TEXT —
  // which overrides this function's answer for the bare form. (The earlier
  // prompt-layer attempt failed live 0/3 on 2026-09-16; see gemini.js.)
  //
  // resolveWeekday keeps mapping a bare "อาทิตย์หน้า" NAME to Sunday on purpose:
  // it is the right fallback for a slot filled with that name when the user text
  // did not actually contain the bare-week phrasing.
  //
  // This test pins that fallback so any future change to it is deliberate, not
  // an accident. If you intend to change it, change this test too — and check
  // the finalizeResult precedence tests below.
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'อาทิตย์หน้า', 'next'), '2026-09-20');
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'อาทิตย์นี้', 'this'), '2026-09-20');
  // The unambiguous "วัน"-prefixed form genuinely means Sunday and must agree.
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'วันอาทิตย์หน้า', 'next'), '2026-09-20');
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, 'วันอาทิตย์นี้', 'this'), '2026-09-20');
});

test('resolveWeekday: English weekday names, case-insensitive (blocker-2 fix)', () => {
  const english = {
    Sunday: '2026-09-20',
    Monday: '2026-09-21',
    Tuesday: '2026-09-22',
    Wednesday: '2026-09-23',
    Thursday: '2026-09-17',
    Friday: '2026-09-18',
    Saturday: '2026-09-19',
  };
  for (const [name, expected] of Object.entries(english)) {
    assert.strictEqual(resolveWeekday(NOW_ICT_WED, name, null), expected, name);
    assert.strictEqual(resolveWeekday(NOW_ICT_WED, name.toLowerCase(), null), expected, name);
    assert.strictEqual(resolveWeekday(NOW_ICT_WED, name.toUpperCase(), null), expected, name);
  }
  assert.strictEqual(resolveWeekday(NOW_ICT_WED, '  friday ', 'next'), '2026-09-18');
});

// -----------------------------------------------------------------------------
// Calendar rollover. Every expected value below is hand-computed from a printed
// calendar, never re-derived with resolveWeekday itself.
// -----------------------------------------------------------------------------

test('resolveWeekday: crosses a month boundary', () => {
  // 2026-09-28 is a Monday (Sep 2026: 21 Mon, 28 Mon). 10:00 ICT.
  const monSep28 = new Date('2026-09-28T03:00:00Z');
  assert.strictEqual(resolveWeekday(monSep28, 'พฤหัสบดี', null), '2026-10-01'); // Thu 1 Oct
  assert.strictEqual(resolveWeekday(monSep28, 'ศุกร์', null), '2026-10-02'); // Fri 2 Oct
  assert.strictEqual(resolveWeekday(monSep28, 'จันทร์', null), '2026-10-05'); // skips a week
  assert.strictEqual(resolveWeekday(monSep28, 'อังคาร', null), '2026-09-29'); // still Sep
});

test('resolveWeekday: crosses a year boundary', () => {
  // 2026-12-31 is a Thursday. 10:00 ICT.
  const thuDec31 = new Date('2026-12-31T03:00:00Z');
  assert.strictEqual(resolveWeekday(thuDec31, 'ศุกร์', null), '2027-01-01'); // Fri 1 Jan 2027
  assert.strictEqual(resolveWeekday(thuDec31, 'อาทิตย์', null), '2027-01-03');
  assert.strictEqual(resolveWeekday(thuDec31, 'พฤหัสบดี', null), '2027-01-07'); // skips a week
});

test('resolveWeekday: non-leap February rolls to 1 March', () => {
  // 2027 is not a leap year; 2027-02-28 is a Sunday and the last day of Feb.
  const sunFeb28 = new Date('2027-02-28T03:00:00Z');
  assert.strictEqual(resolveWeekday(sunFeb28, 'จันทร์', null), '2027-03-01');
  assert.strictEqual(resolveWeekday(sunFeb28, 'เสาร์', null), '2027-03-06');
  assert.strictEqual(resolveWeekday(sunFeb28, 'อาทิตย์', null), '2027-03-07'); // skips a week
});

test('resolveWeekday: leap year — 2028-02-29 exists and is reachable', () => {
  // 2028 is a leap year. 2028-02-28 is a Monday, so 29 Feb is a Tuesday.
  const monFeb28 = new Date('2028-02-28T03:00:00Z');
  assert.strictEqual(resolveWeekday(monFeb28, 'อังคาร', null), '2028-02-29');
  assert.strictEqual(resolveWeekday(monFeb28, 'พุธ', null), '2028-03-01');
  // And from 29 Feb itself (a Tuesday), forward into March.
  const tueFeb29 = new Date('2028-02-29T03:00:00Z');
  assert.strictEqual(resolveWeekday(tueFeb29, 'พุธ', null), '2028-03-01');
  assert.strictEqual(resolveWeekday(tueFeb29, 'อังคาร', null), '2028-03-07'); // skips a week
});

test('resolveWeekday: the ICT day boundary still holds at a month rollover', () => {
  // 2026-09-30T18:30:00Z = 2026-10-01 01:30 ICT, a Thursday.
  // A naive getDay() would read Wednesday 30 Sep and answer 2026-10-01 for ศุกร์
  // minus a day. Expected values come from the ICT day, Thu 1 Oct.
  const ictOct1 = new Date('2026-09-30T18:30:00Z');
  assert.strictEqual(resolveWeekday(ictOct1, 'ศุกร์', null), '2026-10-02');
  assert.strictEqual(resolveWeekday(ictOct1, 'พฤหัสบดี', null), '2026-10-08'); // today -> +7
});

test('resolveWeekday: an invalid or non-Date `now` returns null', () => {
  assert.strictEqual(resolveWeekday(new Date('nonsense'), 'ศุกร์', null), null);
  assert.strictEqual(resolveWeekday('not a date', 'ศุกร์', null), null);
  // A numeric epoch is accepted (new Date(ms)) — 2026-09-15T18:30:00Z.
  assert.strictEqual(resolveWeekday(NOW_ICT_WED.getTime(), 'ศุกร์', null), '2026-09-18');
});

test('withTimeOfDay: valid times are appended, junk falls through to the 09:00 default', () => {
  assert.strictEqual(withTimeOfDay('2026-09-21', '10:00'), '2026-09-21T10:00:00');
  assert.strictEqual(withTimeOfDay('2026-09-21', '9:30'), '2026-09-21T09:30:00');
  assert.strictEqual(withTimeOfDay('2026-09-21', '23:59'), '2026-09-21T23:59:00');
  // Malformed -> bare date, so toUtcIso supplies 09:00 ICT.
  for (const bad of ['บ่าย 3', '10', '10:0', '25:00', '10:61', '', null, undefined, 1000]) {
    assert.strictEqual(withTimeOfDay('2026-09-21', bad), '2026-09-21', JSON.stringify(bad));
  }
});

// -----------------------------------------------------------------------------
// finalizeResult precedence. Raw JSON strings by hand — nothing hits the network.
// -----------------------------------------------------------------------------

const raw = (obj) => JSON.stringify(obj);
const base = { title: 'ส่งงาน', recurring: false, confident: true };

/** 09:00 ICT on the given date, as the UTC ISO string the bot stores. */
const at0900 = (date) => toUtcIso(date);

test('toUtcIso: a bare date defaults to 09:00 ICT = 02:00 UTC', () => {
  // The literals below are spelled out on purpose. Every other use of at0900()
  // calls toUtcIso() to build the expected value as well as the actual one, so
  // it agrees with whatever default the code happens to have — mutating the
  // default from 09:00 to 08:00 left the whole suite green. Hard-coding the UTC
  // instant is what actually pins the default.
  //
  // Arithmetic: ICT is a fixed +07:00 with no DST, so 09:00 ICT - 7h = 02:00 UTC
  // on the same calendar day.
  assert.strictEqual(at0900('2026-09-18'), '2026-09-18T02:00:00.000Z');
  // A second date across a year boundary: 09:00 ICT is early enough in the day
  // that subtracting 7 hours never rolls back into the previous date.
  assert.strictEqual(at0900('2027-01-01'), '2027-01-01T02:00:00.000Z');
});

test('finalizeResult: symbolic weekday slot wins over a conflicting deadline_iso', () => {
  const out = finalizeResult(
    raw({
      ...base,
      // What the model computed itself — wrong, and deliberately ignored.
      deadline_iso: '2026-09-22T09:00:00+07:00',
      relative_weekday: 'จันทร์',
      weekday_qualifier: 'next',
      time_of_day: null,
    }),
    'test',
    NOW_ICT_WED
  );
  assert.strictEqual(out.deadlineIso, at0900('2026-09-21'));
  assert.strictEqual(out.recurring, false);
  assert.strictEqual(out.title, 'ส่งงาน');
});

test('finalizeResult: time_of_day is honoured (คาบ 3 = 10:00)', () => {
  const out = finalizeResult(
    raw({
      ...base,
      deadline_iso: null,
      relative_weekday: 'ศุกร์',
      weekday_qualifier: 'this',
      time_of_day: '10:00',
    }),
    'test',
    NOW_ICT_WED
  );
  assert.strictEqual(out.deadlineIso, toUtcIso('2026-09-18T10:00:00'));
});

test('finalizeResult: malformed time_of_day falls back to the 09:00 default', () => {
  for (const bad of ['บ่ายสาม', '25:00', '10:61', '8', 7]) {
    const out = finalizeResult(
      raw({
        ...base,
        deadline_iso: null,
        relative_weekday: 'ศุกร์',
        weekday_qualifier: 'this',
        time_of_day: bad,
      }),
      'test',
      NOW_ICT_WED
    );
    assert.strictEqual(out.deadlineIso, at0900('2026-09-18'), JSON.stringify(bad));
  }
});

test('finalizeResult: recurring:true nulls the deadline and ignores every date slot', () => {
  const out = finalizeResult(
    raw({
      title: 'กินยา',
      recurring: true,
      confident: true,
      deadline_iso: '2026-09-22T09:00:00+07:00',
      relative_weekday: 'จันทร์',
      weekday_qualifier: 'next',
      time_of_day: '10:00',
    }),
    'test',
    NOW_ICT_WED
  );
  assert.strictEqual(out.deadlineIso, null);
  assert.strictEqual(out.recurring, true);
});

test('finalizeResult: absolute deadline_iso still works with the slots absent or null', () => {
  const expected = new Date('2026-08-28T15:00:00+07:00').toISOString();

  const withNulls = finalizeResult(
    raw({
      ...base,
      deadline_iso: '2026-08-28T15:00:00+07:00',
      relative_weekday: null,
      weekday_qualifier: null,
      time_of_day: null,
    }),
    'test',
    NOW_ICT_WED
  );
  assert.strictEqual(withNulls.deadlineIso, expected);

  // A model that never learned about the new slots at all (old contract).
  const withoutSlots = finalizeResult(
    raw({ ...base, deadline_iso: '2026-08-28T15:00:00+07:00' }),
    'test',
    NOW_ICT_WED
  );
  assert.strictEqual(withoutSlots.deadlineIso, expected);
});

test('finalizeResult: bare YYYY-MM-DD deadline_iso keeps its 09:00 ICT default', () => {
  const out = finalizeResult(
    raw({ ...base, deadline_iso: '2026-08-28' }),
    'test',
    NOW_ICT_WED
  );
  assert.strictEqual(out.deadlineIso, at0900('2026-08-28'));
});

test('finalizeResult: unrecognised weekday name falls back to deadline_iso', () => {
  const out = finalizeResult(
    raw({
      ...base,
      deadline_iso: '2026-08-28T15:00:00+07:00',
      // Not a weekday in either language -> does not resolve. ("Monday" used to
      // stand in here; it is a recognised name now, so it would hide the test.)
      relative_weekday: 'Monday1',
      weekday_qualifier: 'next',
      time_of_day: '10:00',
    }),
    'test',
    NOW_ICT_WED
  );
  assert.strictEqual(out.deadlineIso, new Date('2026-08-28T15:00:00+07:00').toISOString());
});

test('finalizeResult: unrecognised weekday AND no deadline_iso -> no_deadline', () => {
  assert.throws(
    () =>
      finalizeResult(
        raw({
          ...base,
          deadline_iso: null,
          relative_weekday: 'Monday1',
          weekday_qualifier: 'next',
          time_of_day: '10:00',
        }),
        'test',
        NOW_ICT_WED
      ),
    (err) => err instanceof ParseError && err.code === 'no_deadline'
  );
});

test('finalizeResult: an echoed "ศุกร์นี้" is recorded, not dropped (blocker-2 fix)', () => {
  // The exact failure QC blocked on: the model echoes the user's wording, the
  // slot fails to resolve, and — because the prompt told it not to send
  // deadline_iso — the reminder is silently lost to the chat fallback.
  for (const name of ['ศุกร์นี้', 'วันศุกร์หน้า', 'Friday', 'friday']) {
    const out = finalizeResult(
      raw({
        ...base,
        deadline_iso: null,
        relative_weekday: name,
        weekday_qualifier: 'this',
        time_of_day: null,
      }),
      'test',
      NOW_ICT_WED
    );
    assert.strictEqual(out.deadlineIso, at0900('2026-09-18'), name);
  }
});

test('finalizeResult: recurring is a strict === true opt-in', () => {
  // A truthy-but-not-true value must NOT turn the task into a standing reminder
  // and silently discard its deadline.
  for (const truthy of ['true', 1, 'yes', {}, []]) {
    const out = finalizeResult(
      raw({ ...base, recurring: truthy, deadline_iso: '2026-08-28T15:00:00+07:00' }),
      'test',
      NOW_ICT_WED
    );
    assert.strictEqual(out.recurring, false, JSON.stringify(truthy));
    assert.strictEqual(
      out.deadlineIso,
      new Date('2026-08-28T15:00:00+07:00').toISOString(),
      JSON.stringify(truthy)
    );
  }

  // ...and with no deadline it must still be rejected rather than accepted as a
  // deadline-less standing reminder.
  assert.throws(
    () => finalizeResult(raw({ ...base, recurring: 'true', deadline_iso: null }), 'test', NOW_ICT_WED),
    (err) => err instanceof ParseError && err.code === 'no_deadline'
  );
});

test('finalizeResult: the other ParseError codes are unchanged', () => {
  const codeOf = (fn) => {
    try {
      fn();
    } catch (err) {
      return err.code;
    }
    return null;
  };

  assert.strictEqual(codeOf(() => finalizeResult('not json at all', 'test', NOW_ICT_WED)), 'bad_json');
  assert.strictEqual(
    codeOf(() => finalizeResult(raw({ ...base, confident: false }), 'test', NOW_ICT_WED)),
    'low_confidence'
  );
  assert.strictEqual(
    codeOf(() =>
      finalizeResult(raw({ ...base, title: '  ', deadline_iso: '2026-08-28' }), 'test', NOW_ICT_WED)
    ),
    'no_title'
  );
});

test('finalizeResult: defaults `now` to the current time when not threaded', () => {
  // Guards the signature change: the third argument is optional, and a weekday
  // slot still resolves to a real future date without it.
  const out = finalizeResult(
    raw({ ...base, deadline_iso: null, relative_weekday: 'จันทร์', weekday_qualifier: 'next', time_of_day: null }),
    'test'
  );
  assert.match(out.deadlineIso, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(new Date(out.deadlineIso).getTime() > Date.now());
});

// -----------------------------------------------------------------------------
// Bare "next week" reference ("อาทิตย์หน้า" / "สัปดาห์หน้า").
//
// Regression cover for the live failure of 2026-09-16, where the carve-out lived
// in the prompt and scored 0/3 against nvidia/nemotron-3.5-lightning:free:
//   rep 1  -> relative_weekday=null, deadline_iso=null  -> 'no_deadline' throw
//   rep 2,3-> relative_weekday="อาทิตย์"                 -> Sunday, up to 6d early
// Both reps are reproduced below as model output, with `now` pinned to the same
// Wednesday the rest of this file uses (2026-09-16 ICT). Correct answer for both
// is +7 days = 2026-09-23.
// -----------------------------------------------------------------------------

test('resolveBareWeekReference: bare forms resolve to +7 days from the ICT day', () => {
  // The pin is 01:30 ICT on Wed 2026-09-16 while UTC still reads Tue 15 Sep —
  // so a +7 built from the UTC date would answer 2026-09-22, one day short.
  assert.strictEqual(resolveBareWeekReference(NOW_ICT_WED, 'ส่งงานอาทิตย์หน้า'), '2026-09-23');
  assert.strictEqual(resolveBareWeekReference(NOW_ICT_WED, 'ส่งงานอาทิตย์ที่จะถึง'), '2026-09-23');
  assert.strictEqual(resolveBareWeekReference(NOW_ICT_WED, 'ส่งงานสัปดาห์หน้า'), '2026-09-23');
  assert.strictEqual(resolveBareWeekReference(NOW_ICT_WED, 'ส่งงานสัปดาห์ที่จะถึง'), '2026-09-23');
  // Tolerated spacing.
  assert.strictEqual(resolveBareWeekReference(NOW_ICT_WED, 'ส่งงาน อาทิตย์ หน้า'), '2026-09-23');
});

test('resolveBareWeekReference: a "วัน" prefix means Sunday, so it must NOT match', () => {
  for (const text of [
    'ส่งงานวันอาทิตย์หน้า',
    'ส่งงานวัน อาทิตย์หน้า', // tolerated space between "วัน" and the day name
    'ส่งงานวันอาทิตย์ที่จะถึง',
  ]) {
    assert.strictEqual(resolveBareWeekReference(NOW_ICT_WED, text), null, text);
  }
});

test('resolveBareWeekReference: "นี้" (this week) is deliberately out of scope', () => {
  // "อาทิตย์นี้" has no single obvious target date, so no date is invented for
  // it — existing behaviour is left alone. See the note in datetime.js.
  assert.strictEqual(resolveBareWeekReference(NOW_ICT_WED, 'ส่งงานอาทิตย์นี้'), null);
  assert.strictEqual(resolveBareWeekReference(NOW_ICT_WED, 'ส่งงานสัปดาห์นี้'), null);
});

test('resolveBareWeekReference: unrelated text and bad input return null', () => {
  for (const text of [
    'ส่งงานวันศุกร์นี้',
    'ส่งงานพรุ่งนี้',
    'กินยาทุกวัน',
    '',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.strictEqual(resolveBareWeekReference(NOW_ICT_WED, text), null, JSON.stringify(text));
  }
  assert.strictEqual(resolveBareWeekReference(new Date('nonsense'), 'อาทิตย์หน้า'), null);
});

test('resolveBareWeekReference: the 00:00-07:00 ICT boundary uses the ICT calendar day', () => {
  // 2026-09-15T17:00:00Z = 2026-09-16 00:00 ICT exactly. +7d = 2026-09-23.
  assert.strictEqual(
    resolveBareWeekReference(new Date('2026-09-15T17:00:00Z'), 'อาทิตย์หน้า'),
    '2026-09-23'
  );
  // 2026-09-15T23:59:00Z = 2026-09-16 06:59 ICT, still inside the window.
  assert.strictEqual(
    resolveBareWeekReference(new Date('2026-09-15T23:59:00Z'), 'อาทิตย์หน้า'),
    '2026-09-23'
  );
  // 2026-09-16T00:01:00Z = 07:01 ICT the same day — outside the window, and the
  // answer must be identical. If it differs, the UTC date leaked in.
  assert.strictEqual(
    resolveBareWeekReference(new Date('2026-09-16T00:01:00Z'), 'อาทิตย์หน้า'),
    '2026-09-23'
  );
  // And a month rollover through the same window: 2026-09-30T18:30:00Z is
  // 2026-10-01 01:30 ICT, so +7d is 2026-10-08.
  assert.strictEqual(
    resolveBareWeekReference(new Date('2026-09-30T18:30:00Z'), 'สัปดาห์หน้า'),
    '2026-10-08'
  );
});

test('finalizeResult: rep-1 regression — both model date slots null -> +7d, not a throw', () => {
  const out = finalizeResult(
    raw({ ...base, deadline_iso: null, relative_weekday: null, weekday_qualifier: null, time_of_day: null }),
    'test',
    NOW_ICT_WED,
    'ส่งงานอาทิตย์หน้า'
  );
  assert.strictEqual(out.deadlineIso, at0900('2026-09-23'));
});

test('finalizeResult: rep-2/3 regression — relative_weekday="อาทิตย์" is overridden by +7d', () => {
  const out = finalizeResult(
    raw({
      ...base,
      deadline_iso: null,
      relative_weekday: 'อาทิตย์',
      weekday_qualifier: 'next',
      time_of_day: null,
    }),
    'test',
    NOW_ICT_WED,
    'ส่งงานอาทิตย์หน้า'
  );
  assert.strictEqual(out.deadlineIso, at0900('2026-09-23'));
  assert.notStrictEqual(out.deadlineIso, at0900('2026-09-20')); // NOT Sunday
});

test('finalizeResult: the bare-week rule also overrides a model-computed deadline_iso', () => {
  const out = finalizeResult(
    raw({
      ...base,
      // The model doing date arithmetic — exactly what this design stopped trusting.
      deadline_iso: '2026-09-20T09:00:00+07:00',
      relative_weekday: 'อาทิตย์',
      weekday_qualifier: 'next',
      time_of_day: null,
    }),
    'test',
    NOW_ICT_WED,
    'ส่งงานสัปดาห์หน้า'
  );
  assert.strictEqual(out.deadlineIso, at0900('2026-09-23'));
});

test('finalizeResult: carve-out must not over-fire on "วันอาทิตย์หน้า" -> Sunday 2026-09-20', () => {
  const out = finalizeResult(
    raw({
      ...base,
      deadline_iso: null,
      relative_weekday: 'อาทิตย์',
      weekday_qualifier: 'next',
      time_of_day: null,
    }),
    'test',
    NOW_ICT_WED,
    'ส่งงานวันอาทิตย์หน้า'
  );
  assert.strictEqual(out.deadlineIso, at0900('2026-09-20'));
});

test('finalizeResult: a bare-week phrase with a time keeps that time', () => {
  const out = finalizeResult(
    raw({
      ...base,
      deadline_iso: null,
      relative_weekday: 'อาทิตย์',
      weekday_qualifier: 'next',
      time_of_day: '15:00',
    }),
    'test',
    NOW_ICT_WED,
    'ส่งงานอาทิตย์หน้าบ่าย 3 โมง'
  );
  assert.strictEqual(out.deadlineIso, toUtcIso('2026-09-23T15:00:00'));
});

test('finalizeResult: an ordinary weekday phrase is untouched by the carve-out', () => {
  // "ส่งรายงานศุกร์นี้บ่าย 3 โมง" -> Fri 2026-09-18 15:00 ICT.
  const out = finalizeResult(
    raw({
      ...base,
      title: 'ส่งรายงาน',
      deadline_iso: null,
      relative_weekday: 'ศุกร์',
      weekday_qualifier: 'this',
      time_of_day: '15:00',
    }),
    'test',
    NOW_ICT_WED,
    'ส่งรายงานศุกร์นี้บ่าย 3 โมง'
  );
  assert.strictEqual(out.deadlineIso, toUtcIso('2026-09-18T15:00:00'));
  assert.strictEqual(out.deadlineIso, '2026-09-18T08:00:00.000Z'); // 15:00 ICT - 7h
});

test('finalizeResult: recurring still outranks the bare-week rule', () => {
  const out = finalizeResult(
    raw({ title: 'กินยา', recurring: true, confident: true, deadline_iso: null }),
    'test',
    NOW_ICT_WED,
    'กินยาทุกวัน เริ่มอาทิตย์หน้า'
  );
  assert.strictEqual(out.deadlineIso, null);
  assert.strictEqual(out.recurring, true);
});

test('finalizeResult: omitting userText leaves the old behaviour exactly as it was', () => {
  // Signature compatibility: the 3-arg call sites in this file and in the live
  // harness must keep resolving through relative_weekday.
  const out = finalizeResult(
    raw({ ...base, deadline_iso: null, relative_weekday: 'อาทิตย์', weekday_qualifier: 'next', time_of_day: null }),
    'test',
    NOW_ICT_WED
  );
  assert.strictEqual(out.deadlineIso, at0900('2026-09-20'));
});
