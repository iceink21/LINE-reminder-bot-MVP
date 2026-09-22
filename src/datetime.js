'use strict';

const { config } = require('./config');

const TZ = config.timezone;

/** Pull calendar parts of `date` as seen in the bot's timezone. */
function tzParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out = {};
  for (const part of fmt.formatToParts(date)) out[part.type] = part.value;
  // Intl renders midnight as "24" in some ICU builds.
  if (out.hour === '24') out.hour = '00';
  return out;
}

/** Local wall-clock timestamp with explicit offset, e.g. 2026-08-23T22:50:00+07:00 */
function nowLocalIso(date = new Date()) {
  const p = tzParts(date);
  return (
    p.year + '-' + p.month + '-' + p.day +
    'T' + p.hour + ':' + p.minute + ':' + p.second + config.tzOffset
  );
}

/**
 * Calendar month as seen in the bot's timezone, e.g. "2026-08".
 * The LINE push quota resets on the Thai calendar month, not on UTC's, so the
 * key has to come from tzParts rather than from `Date#toISOString().slice(0,7)`.
 */
function monthKey(date = new Date()) {
  const p = tzParts(date);
  return p.year + '-' + p.month;
}

/** Thai weekday name for prompt grounding ("วันอาทิตย์" etc.). */
function thaiWeekday(date = new Date()) {
  return new Intl.DateTimeFormat('th-TH', { timeZone: TZ, weekday: 'long' }).format(date);
}

/**
 * Human-friendly Thai rendering of a stored UTC ISO deadline.
 * Example: "ศ. 28 ส.ค. 2569 15:00 น."
 */
function formatThai(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const datePart = new Intl.DateTimeFormat('th-TH', {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
  const timePart = new Intl.DateTimeFormat('th-TH', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return datePart + ' ' + timePart + ' น.';
}

/** "อีก 3 วัน" / "อีก 2 ชม." / "เลยกำหนดแล้ว" — relative countdown for list output. */
function relativeThai(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMin = Math.round((d.getTime() - now.getTime()) / 60000);
  if (diffMin < 0) return 'เลยกำหนดแล้ว';
  if (diffMin < 60) return 'อีก ' + diffMin + ' นาที';
  if (diffMin < 60 * 24) return 'อีก ' + Math.floor(diffMin / 60) + ' ชม.';
  return 'อีก ' + Math.floor(diffMin / (60 * 24)) + ' วัน';
}

/**
 * Weekday name -> ECMAScript day index (Sunday = 0).
 * Both the bare form ("จันทร์") and the "วัน"-prefixed form ("วันจันทร์") are
 * accepted because the model emits both; "พฤหัส" is the common short form of
 * "พฤหัสบดี" and is accepted for the same reason.
 *
 * The English names are here because the prompt asks for a bare Thai day name
 * but nothing enforces that on the primary (schema-less) leg, and an
 * unrecognised name costs the user their whole reminder: the slot resolves to
 * null, the model was told not to send deadline_iso, finalizeResult throws
 * 'no_deadline', and webhook.js answers with chit-chat instead of recording the
 * task. Seven extra keys are cheap insurance against that silent drop.
 */
const WEEKDAY_INDEX = {
  'อาทิตย์': 0,
  'จันทร์': 1,
  'อังคาร': 2,
  'พุธ': 3,
  'พฤหัสบดี': 4,
  'พฤหัส': 4,
  'ศุกร์': 5,
  'เสาร์': 6,
  // Lowercase — the lookup lowercases its key, which is a no-op for Thai.
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Trailing qualifiers the model sometimes leaves attached to the day name when
 * it echoes the user's own wording ("ศุกร์นี้", "วันศุกร์หน้า").
 *
 * "ที่แล้ว" means LAST (past) and stripping it still resolves to the next
 * occurrence, which is a week-plus off. That is deliberate: a slightly wrong
 * date the user can see and fix with /edit beats the alternative, which is the
 * reminder never being recorded at all.
 */
const WEEKDAY_QUALIFIER_SUFFIX_RE = /(?:นี้|หน้า|ที่จะถึง|ที่แล้ว)$/;

const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2})$/;

/** Zero-pad to two digits. */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Resolve a symbolic relative weekday reference into a `YYYY-MM-DD` date.
 *
 * This exists because the parsing model is unreliable at weekday arithmetic:
 * it emits the weekday NAME and we do the date math here, deterministically.
 *
 * Semantics (pinned — do not "fix"): "this", "next" and a null qualifier all
 * resolve to the NEXT occurrence strictly after today, i.e. an offset of 1..7
 * days; if today already is that weekday we skip a full week rather than
 * returning today. Thai "จันทร์นี้" and "จันทร์หน้า" are used interchangeably in
 * practice for the upcoming Monday, so treating "next" as +7 would produce a
 * date a week later than the user means. The qualifier is carried in the JSON
 * contract only so a future change of heart does not need a schema change.
 *
 * The weekday of "today" is read through tzParts, not Date#getDay(): between
 * 00:00 and 07:00 ICT the UTC date is still the previous calendar day and a
 * raw getDay() would be one weekday behind.
 *
 * @returns {string|null} `YYYY-MM-DD`, or null if the name is unrecognised.
 */
function resolveWeekday(now, weekdayName, _qualifier) {
  if (typeof weekdayName !== 'string') return null;
  const key = weekdayName
    .trim()
    .replace(/^วัน/, '')
    .replace(WEEKDAY_QUALIFIER_SUFFIX_RE, '')
    .trim()
    .toLowerCase();
  // Own-property check: "constructor"/"toString" etc. must not resolve.
  const target = Object.prototype.hasOwnProperty.call(WEEKDAY_INDEX, key)
    ? WEEKDAY_INDEX[key]
    : undefined;
  if (target === undefined) return null;

  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  const p = tzParts(date);
  // Anchor the local calendar date at UTC midnight so day arithmetic is plain
  // integer arithmetic with no DST/offset drift.
  const anchor = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));

  const current = new Date(anchor).getUTCDay();
  // 1..7, never 0 — see the semantics note above.
  const offset = ((target - current + 7) % 7) || 7;
  const resolved = new Date(anchor + offset * 86400000);
  return (
    resolved.getUTCFullYear() +
    '-' + pad2(resolved.getUTCMonth() + 1) +
    '-' + pad2(resolved.getUTCDate())
  );
}

/**
 * Thai "อาทิตย์" means BOTH "Sunday" and "week", and the two readings are told
 * apart by a "วัน" prefix: "วันอาทิตย์หน้า" = next Sunday, bare "อาทิตย์หน้า" =
 * next WEEK. Only the raw user text still carries that distinction — by the time
 * the model has answered, both phrasings arrive as relative_weekday="อาทิตย์".
 *
 * The prompt-layer version of this carve-out (tell the model to leave the slot
 * null and compute deadline_iso itself for the bare form) was tried and FAILED
 * live 0/3 on 2026-09-16: one rep returned both date slots null (reminder lost
 * to 'no_deadline'), two reps filled relative_weekday="อาทิตย์" anyway (reminder
 * up to six days early). Do not re-litigate it at the prompt. The decision is
 * owned here, in code, which is the same principle resolveWeekday() exists for.
 *
 * Matching rules:
 *   - "อาทิตย์หน้า" / "อาทิตย์ที่จะถึง" NOT immediately preceded by "วัน"
 *     (an optional space is tolerated: "วัน อาทิตย์หน้า" is still Sunday)
 *   - "สัปดาห์หน้า" / "สัปดาห์ที่จะถึง", which is unambiguously a week
 *
 * SCOPE: "หน้า" (next) only. "อาทิตย์นี้" / "สัปดาห์นี้" ("this week") has no
 * single obvious target date — picking one would be inventing a deadline — so it
 * is deliberately out of scope and keeps its existing behaviour.
 *
 * @returns {string|null} `YYYY-MM-DD`, exactly 7 days after the ICT calendar
 *   date of `now`, or null when the pattern does not apply.
 */
const BARE_WEEK_REFERENCE_RE =
  /(?:(?<!วัน\s?)อาทิตย์|สัปดาห์)\s?(?:หน้า|ที่จะถึง)/;

function resolveBareWeekReference(now, userText) {
  if (typeof userText !== 'string' || !userText) return null;
  if (!BARE_WEEK_REFERENCE_RE.test(userText)) return null;

  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  const p = tzParts(date);
  // Same UTC-midnight anchor as resolveWeekday: between 00:00 and 07:00 ICT the
  // UTC calendar day is still yesterday, so the local parts must come from
  // tzParts rather than from the Date's own UTC/local getters.
  const anchor = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const resolved = new Date(anchor + 7 * 86400000);
  return (
    resolved.getUTCFullYear() +
    '-' + pad2(resolved.getUTCMonth() + 1) +
    '-' + pad2(resolved.getUTCDate())
  );
}

/**
 * Join a `YYYY-MM-DD` with an optional "HH:MM" into the string toUtcIso() takes.
 * A missing or malformed time is dropped so that toUtcIso's own 09:00 ICT
 * default applies — the default lives in exactly one place.
 */
function withTimeOfDay(dateStr, timeOfDay) {
  if (typeof timeOfDay !== 'string') return dateStr;
  const m = timeOfDay.trim().match(TIME_OF_DAY_RE);
  if (!m) return dateStr;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  // The regex alone still admits "97:99", which would make an Invalid Date.
  if (hour > 23 || minute > 59) return dateStr;
  return dateStr + 'T' + pad2(hour) + ':' + pad2(minute) + ':00';
}

/**
 * Normalise whatever the model returned into a UTC ISO string.
 * A timestamp without an offset is read as Thai local time, not UTC.
 */
function toUtcIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let raw = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw = raw + 'T09:00:00'; // date only -> 09:00 ICT
  if (!hasZone) raw = raw + config.tzOffset;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = {
  nowLocalIso,
  monthKey,
  thaiWeekday,
  formatThai,
  relativeThai,
  toUtcIso,
  resolveWeekday,
  resolveBareWeekReference,
  withTimeOfDay,
};
