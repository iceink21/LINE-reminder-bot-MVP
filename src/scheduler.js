'use strict';

const cron = require('node-cron');
const store = require('./db');
const msg = require('./messages');
const { push } = require('./line');
const { config } = require('./config');

let running = false;

/**
 * One sweep: fire day-before pings, then due pings.
 * Each row is flagged only after its push succeeds, so a transient LINE error
 * retries on the next tick instead of silently dropping the reminder.
 */
async function tick(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  const result = { dayBefore: 0, due: 0, failed: 0 };

  try {
    for (const row of store.findDueDayBefore(now)) {
      try {
        await push(row.line_user_id, msg.dayBeforePush(row));
        store.flagDayBeforeNotified(row.id);
        result.dayBefore += 1;
      } catch (err) {
        result.failed += 1;
        console.error('[scheduler] day-before push failed for #' + row.id + ':', err && err.message);
      }
    }

    for (const row of store.findDueNow(now)) {
      try {
        await push(row.line_user_id, msg.duePush(row));
        store.flagDueNotified(row.id);
        result.due += 1;
      } catch (err) {
        result.failed += 1;
        console.error('[scheduler] due push failed for #' + row.id + ':', err && err.message);
      }
    }
  } finally {
    running = false;
  }

  return result;
}

let digestRunning = false;

/**
 * Daily 06:00 digest: one consolidated message per user who still has pending
 * work, soonest deadline first. Users with nothing pending are skipped outright.
 *
 * Nothing is flagged in the DB here — the digest is a snapshot of the current
 * backlog, not a per-row notification, so a failed push is simply logged and the
 * sweep moves on to the next user rather than blocking anyone else's digest.
 */
async function digestTick() {
  if (digestRunning) return { skipped: true };
  digestRunning = true;
  const result = { sent: 0, skipped: 0, failed: 0 };

  try {
    for (const lineUserId of store.listPendingUserIds()) {
      const rows = store.listPending(lineUserId);
      const message = msg.digestPush(rows);
      if (!message) {
        result.skipped += 1;
        continue;
      }
      try {
        await push(lineUserId, message);
        result.sent += 1;
      } catch (err) {
        result.failed += 1;
        console.error('[scheduler] digest push failed for a user:', err && err.message);
      }
    }
  } finally {
    digestRunning = false;
  }

  return result;
}

function start() {
  const job = cron.schedule(
    '* * * * *',
    () => {
      tick().catch((err) => console.error('[scheduler] tick error:', err && err.message));
    },
    { timezone: config.timezone }
  );

  // Housekeeping: drop confirmation drafts the user never answered.
  const cleanup = cron.schedule(
    '15 3 * * *',
    () => {
      const removed = store.purgeStaleDrafts();
      if (removed) console.log('[scheduler] purged ' + removed + ' stale draft(s)');
    },
    { timezone: config.timezone }
  );

  // One consolidated "what's on your plate today" push each morning.
  const digest = cron.schedule(
    '0 6 * * *',
    () => {
      digestTick()
        .then((r) => {
          if (r && r.sent) console.log('[scheduler] daily digest sent to ' + r.sent + ' user(s)');
        })
        .catch((err) => console.error('[scheduler] digest error:', err && err.message));
    },
    { timezone: config.timezone }
  );

  console.log('[scheduler] reminder sweep running every minute (' + config.timezone + ')');
  console.log('[scheduler] daily digest scheduled at 06:00 (' + config.timezone + ')');
  return { job, cleanup, digest };
}

module.exports = { start, tick, digestTick };
