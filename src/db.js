'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('./config');
const { monthKey } = require('./datetime');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

// --- schema (static SQL, no interpolation anywhere in this file) ---
const SCHEMA_SQL = [
  'CREATE TABLE IF NOT EXISTS reminders (',
  '  id                  INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  line_user_id        TEXT    NOT NULL,',
  '  title               TEXT    NOT NULL,',
  // UTC ISO-8601, e.g. 2026-08-24T08:00:00.000Z
  '  deadline_iso        TEXT    NOT NULL,',
  '  category            TEXT,',
  // status: pending | done — the nightly classifier writes rows straight to
  // 'pending', so there is no longer an unconfirmed/draft state.
  "  status              TEXT    NOT NULL DEFAULT 'pending',",
  '  day_before_notified  INTEGER NOT NULL DEFAULT 0,',
  '  hour_before_notified INTEGER NOT NULL DEFAULT 0,',
  '  due_notified         INTEGER NOT NULL DEFAULT 0,',
  '  created_at           TEXT    NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_reminders_user_status',
  '  ON reminders (line_user_id, status, deadline_iso);',
  'CREATE INDEX IF NOT EXISTS idx_reminders_due',
  '  ON reminders (status, deadline_iso);',
  // Raw inbound chat text, parked until the 00:00 classifier sweeps it.
  'CREATE TABLE IF NOT EXISTS inbox_messages (',
  '  id           INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  line_user_id TEXT    NOT NULL,',
  '  text         TEXT    NOT NULL,',
  // UTC ISO-8601, same convention as reminders.created_at
  '  created_at   TEXT    NOT NULL,',
  '  processed_at TEXT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_inbox_unprocessed',
  '  ON inbox_messages (processed_at, line_user_id, id);',
  // Monthly LINE push/multicast/broadcast counter. Replies are unlimited and
  // deliberately not counted here. `month` is a YYYY-MM key in Asia/Bangkok.
  'CREATE TABLE IF NOT EXISTS push_log (',
  '  month  TEXT    PRIMARY KEY,',
  '  count  INTEGER NOT NULL DEFAULT 0,',
  '  warned INTEGER NOT NULL DEFAULT 0',
  ');',
].join('\n');

db.exec(SCHEMA_SQL);

// Migration: `dev.db` may predate the hour_before_notified column, and SQLite
// has no `ADD COLUMN IF NOT EXISTS`, so check table_info before altering.
const hasHourBeforeColumn = db
  .prepare('PRAGMA table_info(reminders)')
  .all()
  .some((col) => col.name === 'hour_before_notified');
if (!hasHourBeforeColumn) {
  db.prepare('ALTER TABLE reminders ADD COLUMN hour_before_notified INTEGER NOT NULL DEFAULT 0').run();
}

// --- prepared statements: every user-facing query is scoped by line_user_id ---
const SQL = {
  insertPending:
    'INSERT INTO reminders (line_user_id, title, deadline_iso, category, status, created_at) ' +
    "VALUES (@line_user_id, @title, @deadline_iso, @category, 'pending', @created_at)",
  getOwned: 'SELECT * FROM reminders WHERE id = ? AND line_user_id = ?',
  markDone:
    "UPDATE reminders SET status = 'done' " +
    "WHERE id = ? AND line_user_id = ? AND status = 'pending'",
  remove: 'DELETE FROM reminders WHERE id = ? AND line_user_id = ?',
  listPending:
    "SELECT * FROM reminders WHERE line_user_id = ? AND status = 'pending' " +
    'ORDER BY deadline_iso ASC',
  pendingUserIds:
    "SELECT DISTINCT line_user_id FROM reminders WHERE status = 'pending' " +
    'ORDER BY line_user_id ASC',
  dueNow:
    "SELECT * FROM reminders WHERE status = 'pending' AND due_notified = 0 " +
    'AND deadline_iso <= ? AND deadline_iso >= ?',
  // params: upper bound (now + 24h), lower bound (now + 24h - window)
  dueDayBefore:
    "SELECT * FROM reminders WHERE status = 'pending' " +
    'AND day_before_notified = 0 AND due_notified = 0 ' +
    'AND deadline_iso <= ? AND deadline_iso > ?',
  // params: upper bound (now + 1h), lower bound (now + 1h - window)
  dueHourBefore:
    "SELECT * FROM reminders WHERE status = 'pending' " +
    'AND hour_before_notified = 0 AND due_notified = 0 ' +
    'AND deadline_iso <= ? AND deadline_iso > ?',
  flagDue: 'UPDATE reminders SET due_notified = 1 WHERE id = ?',
  flagDayBefore: 'UPDATE reminders SET day_before_notified = 1 WHERE id = ?',
  flagHourBefore: 'UPDATE reminders SET hour_before_notified = 1 WHERE id = ?',

  insertInbox:
    'INSERT INTO inbox_messages (line_user_id, text, created_at) ' +
    'VALUES (@line_user_id, @text, @created_at)',
  inboxUserIds:
    'SELECT DISTINCT line_user_id FROM inbox_messages WHERE processed_at IS NULL ' +
    'ORDER BY line_user_id ASC',
  inboxForUser:
    'SELECT * FROM inbox_messages WHERE line_user_id = ? AND processed_at IS NULL ' +
    'ORDER BY id ASC',
  markInboxDone: 'UPDATE inbox_messages SET processed_at = ? WHERE id = ?',

  bumpPush:
    'INSERT INTO push_log (month, count, warned) VALUES (?, 1, 0) ' +
    'ON CONFLICT(month) DO UPDATE SET count = count + 1',
  getPush: 'SELECT * FROM push_log WHERE month = ?',
  flagPushWarned: 'UPDATE push_log SET warned = 1 WHERE month = ? AND warned = 0',
};

const stmt = Object.fromEntries(
  Object.entries(SQL).map(([key, sql]) => [key, db.prepare(sql)])
);

/**
 * Insert a confirmed reminder; returns the new row id.
 * Called by the nightly classifier once a parked message has parsed cleanly —
 * there is no confirmation round-trip, so rows land as 'pending' immediately.
 */
function createPendingReminder({ lineUserId, title, deadlineIso, category }) {
  const info = stmt.insertPending.run({
    line_user_id: lineUserId,
    title,
    deadline_iso: deadlineIso,
    category: category || null,
    created_at: new Date().toISOString(),
  });
  return Number(info.lastInsertRowid);
}

const getReminder = (id, lineUserId) => stmt.getOwned.get(id, lineUserId) || null;
const markDone = (id, lineUserId) => stmt.markDone.run(id, lineUserId).changes > 0;
const deleteReminder = (id, lineUserId) => stmt.remove.run(id, lineUserId).changes > 0;
const listPending = (lineUserId) => stmt.listPending.all(lineUserId);

/**
 * Every user who still has at least one pending reminder.
 * The daily digest walks these ids and calls `listPending` per user, so the
 * ordering/scoping rules live in exactly one query instead of two.
 */
const listPendingUserIds = () => stmt.pendingUserIds.all().map((r) => r.line_user_id);

/**
 * Reminders whose deadline has just arrived.
 * `graceMs` bounds how far back we look, so a restart after downtime does not
 * fire a flood of long-expired reminders.
 */
function findDueNow(now = new Date(), graceMs = 6 * 60 * 60 * 1000) {
  return stmt.dueNow.all(
    now.toISOString(),
    new Date(now.getTime() - graceMs).toISOString()
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reminders that are genuinely ~1 day out, i.e. sitting inside the band
 * (now + 24h - windowMs, now + 24h]. The lower bound is what makes the message
 * honest: without it a task due in 3 hours also falls under "<= now + 24h" and
 * gets pushed the "เตือนล่วงหน้า 1 วัน" text.
 *
 * The band is swept every minute by the cron job, so a 1h window gives plenty
 * of slack for a restart or a missed tick while staying well clear of
 * `findDueNow`'s at-due window (now - 6h .. now]. The two never overlap.
 */
function findDueDayBefore(now = new Date(), windowMs = 60 * 60 * 1000) {
  const upper = now.getTime() + DAY_MS;
  return stmt.dueDayBefore.all(
    new Date(upper).toISOString(),
    new Date(upper - windowMs).toISOString()
  );
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Reminders that are genuinely ~1 hour out, i.e. sitting inside the band
 * (now + 1h - windowMs, now + 1h]. Unlike `findDueDayBefore`, the target
 * precision here IS the window (1 hour), so a generous 1h band would make the
 * notification arrive anywhere from "due now" to "2 hours out" — a tight
 * 10-minute band keeps it honestly "about 1 hour before" while still giving
 * enough slack for a restart or a missed cron tick.
 */
function findDueHourBefore(now = new Date(), windowMs = 10 * 60 * 1000) {
  const upper = now.getTime() + HOUR_MS;
  return stmt.dueHourBefore.all(
    new Date(upper).toISOString(),
    new Date(upper - windowMs).toISOString()
  );
}

const flagDueNotified = (id) => stmt.flagDue.run(id);
const flagDayBeforeNotified = (id) => stmt.flagDayBefore.run(id);
const flagHourBeforeNotified = (id) => stmt.flagHourBefore.run(id);

// --- inbox: raw chat text waiting for the nightly classifier ---

/** Park one inbound message; `createdAt` is a UTC ISO string. */
function saveInboxMessage({ lineUserId, text, createdAt }) {
  const info = stmt.insertInbox.run({
    line_user_id: lineUserId,
    text,
    created_at: createdAt || new Date().toISOString(),
  });
  return Number(info.lastInsertRowid);
}

/** Every user holding at least one unprocessed inbox row. */
const listUnprocessedByUser = () =>
  stmt.inboxUserIds.all().map((r) => r.line_user_id);

/** That user's unprocessed rows, oldest first — scoped by line_user_id. */
const listUnprocessedForUser = (lineUserId) => stmt.inboxForUser.all(lineUserId);

/**
 * Stamp `processed_at` on a batch of rows.
 * better-sqlite3 cannot bind a variable-length IN list to a prepared statement
 * and this file interpolates no SQL, so the batch runs as one transaction over
 * a single-id statement instead.
 */
const markInboxProcessed = db.transaction((ids) => {
  const stampedAt = new Date().toISOString();
  for (const id of ids) stmt.markInboxDone.run(stampedAt, id);
  return ids.length;
});

// --- push quota: LINE's free plan caps push/multicast/broadcast per month ---

/** Count one outbound push; returns the resulting { month, count, warned }. */
function incrementPushCount(now = new Date()) {
  const month = monthKey(now);
  stmt.bumpPush.run(month);
  return stmt.getPush.get(month);
}

/** Flip the one-time warning flag; false if it was already set. */
const markPushWarned = (month) => stmt.flagPushWarned.run(month).changes > 0;

/** Current usage for the given month; zeroed row if nothing was sent yet. */
function getPushUsage(now = new Date()) {
  const month = monthKey(now);
  return stmt.getPush.get(month) || { month, count: 0, warned: 0 };
}

module.exports = {
  db,
  createPendingReminder,
  getReminder,
  markDone,
  deleteReminder,
  listPending,
  listPendingUserIds,
  findDueNow,
  findDueDayBefore,
  findDueHourBefore,
  flagDueNotified,
  flagDayBeforeNotified,
  flagHourBeforeNotified,
  saveInboxMessage,
  listUnprocessedByUser,
  listUnprocessedForUser,
  markInboxProcessed,
  incrementPushCount,
  markPushWarned,
  getPushUsage,
};
