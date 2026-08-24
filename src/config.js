'use strict';

require('dotenv').config();

const path = require('path');

/**
 * Resolve DATABASE_URL into an absolute filesystem path.
 * Accepts the Prisma-style "file:./dev.db" form as well as a bare path.
 */
function resolveDbPath(raw) {
  const value = (raw || 'file:./dev.db').trim();
  const stripped = value.startsWith('file:') ? value.slice('file:'.length) : value;
  return path.isAbsolute(stripped)
    ? stripped
    : path.resolve(process.cwd(), stripped);
}

const config = {
  port: Number(process.env.PORT || 3000),
  line: {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || '',
    // Recipient of the "quota almost gone" heads-up. Optional: without it the
    // warning is only logged, and everything else keeps working.
    adminUserId: process.env.ADMIN_LINE_USER_ID || '',
  },
  // LINE's free Messaging API plan allows 200 push/multicast/broadcast messages
  // per calendar month. Replies via replyToken are unlimited and never counted.
  pushLimit: Number(process.env.PUSH_MONTHLY_LIMIT || 200),
  pushWarnRatio: Number(process.env.PUSH_WARN_RATIO || 0.9),
  // Fallback provider, used whenever the primary parse fails for any reason.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  },
  // Primary provider.
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'stealth/ox-alpha',
  },
  dbPath: resolveDbPath(process.env.DATABASE_URL),
  // All user-facing date handling is done in Thai local time.
  timezone: process.env.TZ_NAME || 'Asia/Bangkok',
  tzOffset: '+07:00',
};

/** Fail fast on missing secrets — never print their values. */
function assertConfig() {
  const missing = [];
  if (!config.line.channelAccessToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  if (!config.line.channelSecret) missing.push('LINE_CHANNEL_SECRET');
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
  if (!config.openrouter.apiKey || config.openrouter.apiKey.startsWith('REPLACE_ME')) {
    console.warn(
      '[config] OPENROUTER_API_KEY is not set to a real key — natural-language parsing will fail until you fill it in.'
    );
  }
  if (!config.gemini.apiKey || config.gemini.apiKey.startsWith('REPLACE_ME')) {
    console.warn(
      '[config] GEMINI_API_KEY is not set to a real key — the fallback is disabled; any Ox Alpha failure will fail the parse.'
    );
  }
}

module.exports = { config, assertConfig };
