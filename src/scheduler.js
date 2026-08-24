'use strict';

const cron = require('node-cron');
const store = require('./db');
const msg = require('./messages');
const { push } = require('./line');
const { config } = require('./config');
const { parseReminder, summarizeChitChat, ParseError } = require('./gemini');

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

let classifyRunning = false;

/**
 * Sort one user's parked messages into reminders and chit-chat.
 * Anything the parser rejects — including 'low_confidence' — is treated as
 * chatter rather than as an error: the whole point of batching is that the user
 * never had to phrase a message as a command in the first place.
 */
async function classifyUser(lineUserId) {
  const rows = store.listUnprocessedForUser(lineUserId);
  const created = [];
  const chitChat = [];

  for (const row of rows) {
    try {
      // The message's OWN timestamp, so "พรุ่งนี้" resolves against when it was
      // sent — not against the midnight the classifier happens to run at.
      const parsed = await parseReminder(row.text, new Date(row.created_at));
      const id = store.createPendingReminder({
        lineUserId,
        title: parsed.title,
        deadlineIso: parsed.deadlineIso,
        category: parsed.category,
      });
      created.push({ id, title: parsed.title, deadline_iso: parsed.deadlineIso });
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      chitChat.push(row.text);
    }
  }

  return { rows, created, chitChat };
}

/**
 * Nightly 00:00 sweep: classify everything parked since the last run, then send
 * each user ONE push with the reminders that were created and a recap of the
 * rest. One push per user per day is what keeps this inside the monthly quota.
 *
 * Rows are marked processed even when the push fails — re-parsing them the next
 * night would double-insert every reminder, which is worse than a missed digest.
 */
async function classifyTick(now = new Date()) {
  if (classifyRunning) return { skipped: true };
  classifyRunning = true;
  const result = { users: 0, reminders: 0, chitChat: 0, sent: 0, failed: 0 };

  try {
    for (const lineUserId of store.listUnprocessedByUser()) {
      result.users += 1;
      let batch;
      try {
        batch = await classifyUser(lineUserId);
      } catch (err) {
        result.failed += 1;
        console.error('[scheduler] classify failed for a user:', err && err.message);
        continue;
      }

      store.markInboxProcessed(batch.rows.map((r) => r.id));
      result.reminders += batch.created.length;
      result.chitChat += batch.chitChat.length;

      let summary = null;
      if (batch.chitChat.length) {
        try {
          summary = await summarizeChitChat(batch.chitChat, now);
        } catch (err) {
          // A missing recap is not worth losing the reminder list over.
          console.warn('[scheduler] chit-chat summary failed:', err && err.message);
        }
      }

      const message = msg.nightlyDigestPush({
        reminders: batch.created,
        chitChatSummary: summary,
      });
      if (!message) continue;

      try {
        await push(lineUserId, message);
        result.sent += 1;
      } catch (err) {
        result.failed += 1;
        console.error('[scheduler] nightly digest push failed for a user:', err && err.message);
      }
    }
  } finally {
    classifyRunning = false;
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

  // Midnight batch: turn the day's parked messages into reminders + a recap.
  const classify = cron.schedule(
    '0 0 * * *',
    () => {
      classifyTick()
        .then((r) => {
          if (r && r.users) {
            console.log(
              '[scheduler] nightly classify: ' + r.users + ' user(s), ' +
                r.reminders + ' reminder(s), ' + r.sent + ' push(es)'
            );
          }
        })
        .catch((err) => console.error('[scheduler] classify error:', err && err.message));
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
  console.log('[scheduler] nightly inbox classifier scheduled at 00:00 (' + config.timezone + ')');
  return { job, classify, digest };
}

module.exports = { start, tick, digestTick, classifyTick };
