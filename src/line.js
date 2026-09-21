'use strict';

const { messagingApi } = require('@line/bot-sdk');
const { config } = require('./config');
const store = require('./db');

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

const toMessages = (messages) => (Array.isArray(messages) ? messages : [messages]);

/**
 * A reply token is single-use and lives ~60s. LINE answers a spent or expired
 * one with HTTP 400 and a body naming the token, which is indistinguishable
 * from other 400s unless we look.
 */
function isDeadReplyToken(err) {
  if (!err || err.status !== 400) return false;
  return /reply token/i.test(String(err.body || err.message || ''));
}

/**
 * Replies are free and unlimited on every LINE plan, so they are deliberately
 * kept out of the quota counter.
 *
 * The LLM budgets (see src/gemini.js) are sized to finish inside the reply
 * token's ~60s life. The bound is the per-EVENT budget (45s by default, fixed
 * at event receipt in webhook.js and shared by every LLM call that event
 * makes), NOT the per-chain primary+fallback sum — one event can run two
 * chains, and summing only the chain was the arithmetic that let 90s of LLM
 * work sit behind a 60s token. Even with the event deadline, an overrun is
 * still possible (the deadline stops new work; it cannot claw back a reply
 * call that is already slow). That failure is user-visible as the bot saying
 * NOTHING, so it gets its own loud log line instead of blending into generic
 * 400s. It is
 * deliberately NOT auto-retried as a push: push is capped at 200/month and
 * spending that quota is the user's decision, not this function's.
 */
async function reply(replyToken, messages) {
  try {
    return await client.replyMessage({ replyToken, messages: toMessages(messages) });
  } catch (err) {
    if (isDeadReplyToken(err)) {
      console.error(
        '[line] REPLY TOKEN DEAD (expired or already used) — the user received NO reply. ' +
          'Most likely the LLM work ran past the ~60s reply-token window; check the preceding ' +
          '[parseReminder]/[chatReply] lines for a primary timeout followed by a slow fallback, ' +
          'and for a deadline_exceeded code meaning the event budget was already spent. ' +
          'LINE said: HTTP ' + err.status + ' ' + (err.statusText || '')
      );
    }
    throw err;
  }
}

/** Raw push with no accounting — used by the warning path to avoid recursion. */
const rawPush = (to, messages) =>
  client.pushMessage({ to, messages: toMessages(messages) });

/**
 * Warn once per month, the first time usage crosses the ratio.
 * `markPushWarned` is the guard: it only reports a change for the transition
 * from 0 to 1, so a concurrent second push cannot send a duplicate warning.
 * The warning push itself counts normally against the quota (it goes through
 * `rawPush`, so it cannot re-enter this check and loop).
 */
async function maybeWarnQuota(row) {
  const threshold = config.pushLimit * config.pushWarnRatio;
  if (!row || row.count < threshold || row.warned !== 0) return;
  if (!store.markPushWarned(row.month)) return;

  const body =
    '⚠️ โควตา push ของเดือน ' + row.month + ' ใกล้เต็มแล้ว\n' +
    'ใช้ไป ' + row.count + ' จาก ' + config.pushLimit + ' ข้อความ';

  if (!config.line.adminUserId) {
    console.warn('[line] push quota warning (no ADMIN_LINE_USER_ID set): ' + body);
    return;
  }
  try {
    await rawPush(config.line.adminUserId, { type: 'text', text: body });
  } catch (err) {
    // A failed heads-up must never fail the push that triggered it.
    console.error('[line] quota warning push failed:', err && err.message);
  }
}

/**
 * Push a message and count it against the monthly quota.
 * Accounting happens only after LINE accepts the call, so a failed push is not
 * charged. A bookkeeping error is logged, never rethrown — the message did go
 * out, and the caller must not treat it as a delivery failure.
 */
async function push(to, messages) {
  const result = await rawPush(to, messages);
  try {
    await maybeWarnQuota(store.incrementPushCount());
  } catch (err) {
    console.error('[line] push accounting failed:', err && err.message);
  }
  return result;
}

module.exports = { client, reply, push };
