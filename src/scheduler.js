'use strict';

const cron = require('node-cron');
const store = require('./db');
const msg = require('./messages');
const { push } = require('./line');
const { config } = require('./config');
const { summarizeDay } = require('./gemini');

let running = false;

/**
 * One sweep: fire day-before pings, then hour-before pings, then due pings.
 * Each row is flagged only after its push succeeds, so a transient LINE error
 * retries on the next tick instead of silently dropping the reminder.
 */
async function tick(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  const result = { dayBefore: 0, hourBefore: 0, due: 0, failed: 0 };

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

    for (const row of store.findDueHourBefore(now)) {
      try {
        await push(row.line_user_id, msg.hourBeforePush(row));
        store.flagHourBeforeNotified(row.id);
        result.hourBefore += 1;
      } catch (err) {
        result.failed += 1;
        console.error('[scheduler] hour-before push failed for #' + row.id + ':', err && err.message);
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

let recapRunning = false;

/**
 * Nightly 00:00 sweep: one push per user recapping everything they said today.
 * Reminders are already created live in the webhook, so this job only reads the
 * raw message log — it never writes reminders.
 *
 * Rows are marked processed even when the summary or the push fails: carrying
 * them into tomorrow would blend two days into one recap, which is worse than a
 * missed one.
 */
async function recapTick(now = new Date()) {
  if (recapRunning) return { skipped: true };
  recapRunning = true;
  const result = { users: 0, messages: 0, sent: 0, failed: 0 };

  try {
    for (const lineUserId of store.listUnprocessedByUser()) {
      result.users += 1;
      const rows = store.listUnprocessedForUser(lineUserId);
      result.messages += rows.length;

      let summary = null;
      try {
        summary = await summarizeDay(rows.map((r) => r.text), now);
      } catch (err) {
        console.warn('[scheduler] daily recap summary failed:', err && err.message);
      }

      store.markInboxProcessed(rows.map((r) => r.id));

      const message = msg.dailyRecapPush(summary);
      if (!message) continue;

      try {
        await push(lineUserId, message);
        result.sent += 1;
      } catch (err) {
        result.failed += 1;
        console.error('[scheduler] daily recap push failed for a user:', err && err.message);
      }
    }
  } finally {
    recapRunning = false;
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

  // Midnight recap of everything the user said during the day.
  const recap = cron.schedule(
    '0 0 * * *',
    () => {
      recapTick()
        .then((r) => {
          if (r && r.users) {
            console.log(
              '[scheduler] nightly recap: ' + r.users + ' user(s), ' +
                r.messages + ' message(s), ' + r.sent + ' push(es)'
            );
          }
        })
        .catch((err) => console.error('[scheduler] recap error:', err && err.message));
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
  console.log('[scheduler] nightly conversation recap scheduled at 00:00 (' + config.timezone + ')');
  return { job, recap, digest };
}

module.exports = { start, tick, digestTick, recapTick };
