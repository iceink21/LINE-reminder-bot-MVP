'use strict';

const { messagingApi } = require('@line/bot-sdk');
const { config } = require('./config');
const store = require('./db');

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

const toMessages = (messages) => (Array.isArray(messages) ? messages : [messages]);

/**
 * Replies are free and unlimited on every LINE plan, so they are deliberately
 * kept out of the quota counter.
 */
const reply = (replyToken, messages) =>
  client.replyMessage({ replyToken, messages: toMessages(messages) });

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
