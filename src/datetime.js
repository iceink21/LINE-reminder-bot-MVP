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
 * Normalise whatever Gemini returned into a UTC ISO string.
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
};
