'use strict';

/**
 * Regression pins for the timeout-budget fix (2026-09-21).
 *
 * The bug in one line: the "primary + fallback < 60s" invariant was computed
 * for ONE LLM chain, but a free-text message can run TWO (parseReminder, then
 * chatReply on the same reply token), and the fallback leg's own ceiling was
 * per-ATTEMPT rather than per-leg. 25+20 twice is 90s, and a "20s" fallback
 * could really run ~76s, both against a ~60s reply token.
 *
 * No live calls: `globalThis.fetch` is replaced with a fake, and the webhook's
 * dependencies are injected through require.cache. Budgets are shrunk via env
 * BEFORE src/config.js is loaded, so the retry arithmetic can be exercised in
 * seconds instead of minutes. `node --test` runs each test FILE in its own
 * process, so these env writes cannot leak into the other suites.
 */

process.env.LLM_PRIMARY_TIMEOUT_MS = '2000';
process.env.LLM_FALLBACK_TIMEOUT_MS = '4000';
process.env.LLM_EVENT_BUDGET_MS = '8000';
process.env.OPENROUTER_API_KEY = 'sk-test-not-a-real-key';
process.env.GEMINI_API_KEY = 'test-not-a-real-key';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

/** Put a fake module in require.cache so the real file is never loaded. */
function stubModule(relative, exports) {
  const filename = require.resolve(path.join(SRC, relative));
  require.cache[filename] = {
    id: filename,
    filename,
    path: path.dirname(filename),
    loaded: true,
    children: [],
    paths: [],
    exports,
  };
  return filename;
}

/** Minimal fetch Response stand-in — only what callGemini/callOpenRouter read. */
function fakeResponse({ status = 200, body = {}, headers = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    json: async () => body,
    body: { cancel: async () => {} },
  };
}

const geminiJsonBody = (obj) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// B1 — a PROVIDER failure must not start a second LLM chain.
//
// This is the one that doubled the budget: the catch in handleFreeText used to
// send every ParseError to replyAsChat, and 'network' (the AbortSignal
// timeout), 'http_402' and 'http_503' all land there.
// -----------------------------------------------------------------------------
test('B1: a provider-error parse does NOT trigger a second LLM chain', async (t) => {
  const real = require('../src/gemini');
  const { ParseError } = real;

  // Stubs live in require.cache, which is process-wide — put the real modules
  // back afterwards or every later test in this file gets the fake gemini.
  const stubbed = ['db.js', 'line.js', 'gemini.js', 'webhook.js'].map((f) =>
    require.resolve(path.join(SRC, f))
  );
  const saved = stubbed.map((k) => require.cache[k]);
  t.after(() => {
    stubbed.forEach((k, i) => {
      if (saved[i]) require.cache[k] = saved[i];
      else delete require.cache[k];
    });
  });

  // Codes that mean "the provider broke" vs "the model read it and this was
  // not a task". Only the second kind may spend a second chain.
  const providerCodes = ['network', 'http_402', 'http_503', 'http_429', 'bad_json', 'timeout', 'deadline_exceeded'];
  const verdictCodes = ['low_confidence', 'no_title', 'no_deadline'];

  for (const code of [...providerCodes, ...verdictCodes]) {
    const calls = { parse: 0, chat: 0 };
    const replies = [];

    stubModule('db.js', {
      saveInboxMessage: () => {},
      saveChatMessage: () => {},
      getRecentChatHistory: () => [],
      createPendingReminder: () => 1,
    });
    stubModule('line.js', {
      reply: async (_token, messages) => {
        replies.push(messages);
      },
    });
    // The real ParseError class and the real isProviderFailure predicate — the
    // classification under test — with fake network legs in front of them.
    stubModule('gemini.js', {
      ParseError: real.ParseError,
      isProviderFailure: real.isProviderFailure,
      newEventDeadline: real.newEventDeadline,
      parseReminder: async () => {
        calls.parse += 1;
        throw new ParseError('stub failure', code);
      },
      chatReply: async () => {
        calls.chat += 1;
        return 'ตอบแชตแล้ว';
      },
    });

    delete require.cache[require.resolve('../src/webhook')];
    const { handleEvent } = require('../src/webhook');

    await handleEvent({
      type: 'message',
      source: { userId: 'U-test' },
      replyToken: 'token-' + code,
      message: { type: 'text', text: 'ส่งรายงานพรุ่งนี้บ่าย 2' },
    });

    assert.strictEqual(calls.parse, 1, code + ': the parse chain must run exactly once');
    if (providerCodes.includes(code)) {
      assert.strictEqual(
        calls.chat,
        0,
        code +
          ': a provider failure must NOT run a second LLM chain — that is what doubles the event budget'
      );
    } else {
      assert.strictEqual(
        calls.chat,
        1,
        code + ': a verdict about the user\'s text still gets a chat reply'
      );
    }
    assert.strictEqual(replies.length, 1, code + ': the user is answered exactly once');
  }

  t.diagnostic('classified ' + (providerCodes.length + verdictCodes.length) + ' ParseError codes');
});

test('B1: the ack for a provider failure says no reminder was scheduled', () => {
  delete require.cache[require.resolve('../src/messages')];
  const msg = require('../src/messages');
  const body = msg.inboxAckText().text;

  // The whole point of the reword: the user must be able to tell that nothing
  // was scheduled and that they should send it again.
  assert.match(body, /ยังไม่ได้ตั้งเตือน/, 'must state that no reminder was set');
  assert.match(body, /ใหม่/, 'must ask the user to send it again');
  assert.doesNotMatch(
    body,
    /ตอบยาว ๆ ไม่ไหว/,
    'the old copy only apologised for being brief — it read as "noted, got it"'
  );
});

// -----------------------------------------------------------------------------
// B1 secondary — the fallback leg's budget must cover ALL its retries and
// sleeps, not each fetch. Before the fix, AbortSignal.timeout() was created
// inside the retry loop, so a leg documented as 20s could run 3 fetches plus 2
// clamped 8s sleeps: ~76s.
// -----------------------------------------------------------------------------
test('B1-secondary: the fallback leg respects its budget across retries', async () => {
  const { parseReminder, ParseError } = require('../src/gemini');
  const { config } = require('../src/config');
  const budget = config.llm.fallbackTimeoutMs; // 4000 in this file
  const originalFetch = globalThis.fetch;

  let geminiCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openrouter')) return fakeResponse({ status: 500 });
    geminiCalls += 1;
    // Always 429, always asking for a 1s wait — the retry path, on repeat.
    return fakeResponse({ status: 429, headers: { 'retry-after': '1' } });
  };

  const started = Date.now();
  let thrown = null;
  try {
    await parseReminder('ส่งรายงานพรุ่งนี้', new Date());
  } catch (err) {
    thrown = err;
  } finally {
    globalThis.fetch = originalFetch;
  }
  const elapsed = Date.now() - started;

  assert.ok(thrown instanceof ParseError, 'the leg still fails, it just fails in budget');
  assert.strictEqual(thrown.code, 'http_429');
  assert.ok(geminiCalls > 1, 'retries still happen while there is budget for them');
  assert.ok(
    elapsed <= budget + 1500,
    'the whole fallback leg (fetches + backoff sleeps) must fit its ' +
      budget +
      'ms budget, took ' +
      elapsed +
      'ms'
  );
});

test('B1-secondary: a retry is abandoned when the remaining budget cannot cover the sleep', async () => {
  const { parseReminder } = require('../src/gemini');
  const originalFetch = globalThis.fetch;

  let geminiCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openrouter')) return fakeResponse({ status: 500 });
    geminiCalls += 1;
    // Daily-quota style Retry-After: an hour. Clamped to MAX_RETRY_DELAY_MS
    // (8s), which is still more than this file's 4s leg budget, so the retry
    // must be abandoned outright rather than slept through.
    return fakeResponse({ status: 429, headers: { 'retry-after': '3600' } });
  };

  const started = Date.now();
  await assert.rejects(() => parseReminder('ส่งรายงานพรุ่งนี้', new Date()), /HTTP 429/);
  const elapsed = Date.now() - started;
  globalThis.fetch = originalFetch;

  assert.strictEqual(geminiCalls, 1, 'no second attempt when the budget cannot cover the wait');
  assert.ok(elapsed < 2000, 'it must give up immediately, not sleep first; took ' + elapsed + 'ms');
});

test('B1-secondary: the fallback still retries and succeeds when the budget allows', async () => {
  const { parseReminder } = require('../src/gemini');
  const originalFetch = globalThis.fetch;

  let geminiCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openrouter')) return fakeResponse({ status: 500 });
    geminiCalls += 1;
    if (geminiCalls === 1) return fakeResponse({ status: 429, headers: { 'retry-after': '1' } });
    return fakeResponse({
      status: 200,
      body: geminiJsonBody({
        title: 'ส่งรายงาน',
        deadline_iso: '2026-09-22T15:00:00+07:00',
        recurring: false,
        confident: true,
      }),
    });
  };

  const result = await parseReminder('ส่งรายงานพรุ่งนี้บ่าย 2', new Date());
  globalThis.fetch = originalFetch;

  assert.strictEqual(geminiCalls, 2, 'the 429 retry must still happen — the fix bounds it, not removes it');
  assert.strictEqual(result.title, 'ส่งรายงาน');
});

// -----------------------------------------------------------------------------
// The event-level deadline: defence in depth. Even with the provider-failure
// fix, a fast low-confidence parse followed by a slow chat chain could reach
// ~50s, so one deadline covers every chain the event runs.
// -----------------------------------------------------------------------------
test('event deadline: an already-spent budget refuses to start any leg', async () => {
  const { parseReminder, chatReply, ParseError } = require('../src/gemini');
  const originalFetch = globalThis.fetch;

  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return fakeResponse({ status: 200, body: geminiJsonBody({}) });
  };

  const spent = Date.now() - 1000; // a deadline that passed a second ago
  for (const call of [
    () => parseReminder('ส่งรายงานพรุ่งนี้', new Date(), { deadline: spent }),
    () => chatReply('สวัสดี', [], new Date(), { deadline: spent }),
  ]) {
    const err = await call().then(
      () => null,
      (e) => e
    );
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.code, 'deadline_exceeded');
  }
  globalThis.fetch = originalFetch;

  assert.strictEqual(fetches, 0, 'no HTTP call may be made once the event budget is spent');
});

test('event deadline: the fallback leg is skipped when only the primary fits', async () => {
  const { parseReminder, ParseError } = require('../src/gemini');
  const originalFetch = globalThis.fetch;

  let geminiCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openrouter')) {
      // Spend most of the event budget in the primary leg before failing.
      await delay(400);
      return fakeResponse({ status: 500 });
    }
    geminiCalls += 1;
    return fakeResponse({ status: 200, body: geminiJsonBody({}) });
  };

  // Enough budget to start the primary (needs >= MIN_ATTEMPT_MS) but not
  // enough left for the fallback leg once the primary has burned 400ms.
  const err = await parseReminder('ส่งรายงานพรุ่งนี้', new Date(), {
    deadline: Date.now() + 1300,
  }).then(
    () => null,
    (e) => e
  );
  globalThis.fetch = originalFetch;

  assert.ok(err instanceof ParseError);
  assert.strictEqual(err.code, 'deadline_exceeded');
  assert.strictEqual(geminiCalls, 0, 'the fallback must not start outside the event budget');
});

// -----------------------------------------------------------------------------
// The invariant itself: assertConfig must guard the EVENT expression, not the
// single-chain sum. Under the old check, 25000 + 20000 + 10000 = 55000 passed
// silently while the real two-chain worst case was 90s.
// -----------------------------------------------------------------------------
test('config: the guarded invariant is the event budget, not one chain', () => {
  const { config } = require('../src/config');

  assert.ok(
    typeof config.llm.eventBudgetMs === 'number' && config.llm.eventBudgetMs > 0,
    'an explicit per-event budget must exist'
  );
  assert.ok(
    config.llm.eventBudgetMs + config.llm.replyReserveMs < config.llm.replyTokenTtlMs,
    'event budget + reply reserve must fit inside the reply token'
  );
});
