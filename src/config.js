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

/** Parse a positive-integer env var, falling back when unset or unusable. */
function envMs(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Parse a "1/true/yes/on" style env flag. Anything else (including unset) is false. */
function envFlag(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
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
    model: process.env.OPENROUTER_MODEL || 'inception/mercury-2.5',
    // Whether to send `reasoning: { enabled: false }` with each request.
    // OFF by default, because the flag is not universally accepted: several
    // endpoints (glm-5.3-flash among them) reject it outright with
    // HTTP 400 "Reasoning is mandatory for this endpoint and cannot be
    // disabled", which would fail every primary call. Turn it ON only for a
    // model that both accepts the flag AND reasons so long by default that it
    // blows llm.primaryTimeoutMs — that was the case for
    // nvidia/nemotron-3.5-lightning:free. Env flag rather than a code edit so
    // swapping models stays a config change. See callOpenRouter() in gemini.js.
    disableReasoning: envFlag(process.env.OPENROUTER_DISABLE_REASONING, false),
  },
  // ---------------------------------------------------------------------
  // LLM request budgets. The hard ceiling is the LINE REPLY TOKEN, which is
  // valid for ~60s and single-use; the webhook's own 1s ack is already
  // decoupled (src/index.js replies 200 before handleEvent runs) and is NOT
  // what constrains these.
  //
  // THREE numbers, and only the third one is the actual invariant.
  //
  // `primaryTimeoutMs` + `fallbackTimeoutMs` bound ONE chain (one
  // runWithFallback call: primary times out, THEN the fallback runs). Summing
  // just those two was the old invariant and it was WRONG, because a single
  // LINE event can run TWO chains back to back: handleFreeText calls
  // parseReminder, and a not-a-task verdict then calls chatReply. 25+20 twice
  // is 90s against a 60s token — a configuration that only looked safe while
  // both legs shared a single 12s ceiling (12x4 = 48s).
  //
  // `eventBudgetMs` is therefore the real bound: ONE deadline per LINE event,
  // threaded from webhook.js through every LLM call that event makes. Each leg
  // gets min(its own budget, time left on the event deadline), so no
  // combination of chains, legs or retries can outlive it. The invariant that
  // matters — and the one assertConfig() checks — is
  //     eventBudgetMs + replyReserveMs < 60000
  // The default 45000 is deliberately equal to primary + fallback, so a single
  // chain is never clipped while two chains now SHARE the budget instead of
  // doubling it.
  llm: {
    primaryTimeoutMs: envMs(process.env.LLM_PRIMARY_TIMEOUT_MS, 25000),
    fallbackTimeoutMs: envMs(process.env.LLM_FALLBACK_TIMEOUT_MS, 20000),
    // Whole-event ceiling for all LLM work triggered by one webhook event.
    eventBudgetMs: envMs(process.env.LLM_EVENT_BUDGET_MS, 45000),
    // Documented ceiling, used only by the startup sanity check below.
    replyTokenTtlMs: 60000,
    // Reserve for the LINE reply API call itself plus scheduling slop.
    replyReserveMs: 10000,
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
  // The EVENT budget — not the single-chain sum — is what has to fit inside the
  // reply token's ~60s life, because one event can run more than one chain.
  // Warn rather than throw: an over-budget bot still works for every
  // non-worst-case message.
  const worstCaseMs = config.llm.eventBudgetMs + config.llm.replyReserveMs;
  if (worstCaseMs >= config.llm.replyTokenTtlMs) {
    console.warn(
      '[config] LLM event budget is over the LINE reply-token ceiling: ' +
        config.llm.eventBudgetMs +
        'ms event budget + ' +
        config.llm.replyReserveMs +
        'ms reply reserve = ' +
        worstCaseMs +
        'ms >= ' +
        config.llm.replyTokenTtlMs +
        'ms. All LLM work for one event, plus the reply call, can outlive the reply token.'
    );
  }
  // A single chain larger than the whole event budget is not unsafe — the
  // deadline clips it — but it means the documented per-leg numbers are not
  // what actually runs, which is worth saying out loud.
  const chainMs = config.llm.primaryTimeoutMs + config.llm.fallbackTimeoutMs;
  if (chainMs > config.llm.eventBudgetMs) {
    console.warn(
      '[config] one LLM chain (' +
        config.llm.primaryTimeoutMs +
        'ms primary + ' +
        config.llm.fallbackTimeoutMs +
        'ms fallback = ' +
        chainMs +
        'ms) exceeds the ' +
        config.llm.eventBudgetMs +
        'ms event budget, so it will be clipped by the event deadline.'
    );
  }
  if (!config.gemini.apiKey || config.gemini.apiKey.startsWith('REPLACE_ME')) {
    console.warn(
      '[config] GEMINI_API_KEY is not set to a real key — the fallback is disabled; any OpenRouter failure will fail the parse.'
    );
  }
}

module.exports = { config, assertConfig };
