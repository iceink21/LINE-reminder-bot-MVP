'use strict';

const { config } = require('./config');
const { nowLocalIso, thaiWeekday, toUtcIso } = require('./datetime');

// Fallback provider — see parseReminder().
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
// Primary provider: OpenAI-compatible chat/completions (Ox Alpha).
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// gemini-3.6-flash is a thinking model: even a one-line parse burns a few hundred
// thinking tokens, and measured round-trips ranged 11.5-22.6s. Thinking cannot be
// switched off for this model (thinkingBudget: 0 is rejected with HTTP 400, and a
// 128-token budget did not shorten the call), so the only lever is the timeout.
// The webhook already ACKs LINE immediately and parses asynchronously, so a long
// ceiling here costs nothing but a slower failure on a genuinely stuck request.
const REQUEST_TIMEOUT_MS = 45000;
// Free-tier RPM caps on gemini-3.6-flash produce transient 429s under normal
// traffic — retry a couple times with backoff before giving up, honoring
// Retry-After when Gemini sends it.
const MAX_429_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1500;
// Daily-quota 429s can carry a Retry-After measured in hours, not seconds —
// clamp it so we never sleep past the point the LINE reply token is dead.
const MAX_RETRY_DELAY_MS = 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown when the message cannot be turned into a usable reminder. */
class ParseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ParseError';
    this.code = code || 'parse_failed';
  }
}

const SYSTEM_RULES = [
  'คุณคือระบบแยกวิเคราะห์ข้อความภาษาไทยให้เป็นข้อมูลงานที่มีกำหนดส่ง',
  'ตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นหรือ markdown code fence',
  'รูปแบบ: {"title": string, "deadline_iso": string, "category": string|null, "confident": boolean}',
  '- title: ชื่องานสั้น กระชับ ภาษาไทย ไม่ต้องใส่วันเวลาซ้ำในชื่อ',
  '- deadline_iso: ISO 8601 พร้อม offset +07:00 (เวลาไทย) เช่น 2026-08-28T15:00:00+07:00',
  '- คำนวณวันที่สัมพัทธ์ ("พรุ่งนี้", "ศุกร์นี้", "อีก 3 วัน", "สิ้นเดือน") จากเวลาปัจจุบันที่ให้ไว้',
  '- "ศุกร์นี้/ศุกร์หน้า" = วันศุกร์ถัดไปที่ยังมาไม่ถึง; "บ่าย 3 โมง" = 15:00; "ทุ่ม" = 19:00 + n',
  '- ถ้าไม่ได้ระบุเวลา ให้ใช้ 09:00 ของวันนั้น',
  '- category: หนึ่งใน "เรียน", "งาน", "ส่วนตัว", "สุขภาพ", "การเงิน" หรือ null ถ้าไม่ชัด',
  '- confident: false ถ้าข้อความไม่ใช่การสั่งงาน/ไม่มีกำหนดเวลาที่พอจะเดาได้',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    deadline_iso: { type: 'STRING' },
    category: { type: 'STRING', nullable: true },
    confident: { type: 'BOOLEAN' },
  },
  required: ['title', 'deadline_iso', 'confident'],
};

const CHITCHAT_RULES = [
  'คุณคือผู้ช่วยที่สรุปบทสนทนาภาษาไทยของผู้ใช้ในหนึ่งวัน',
  'ข้อความเหล่านี้คือข้อความที่ "ไม่ใช่" การสั่งงานหรือนัดหมาย',
  'สรุปเป็นย่อหน้าสั้น ๆ ภาษาไทย ไม่เกิน 3 ประโยค ว่าผู้ใช้พูดถึงเรื่องอะไรบ้าง',
  'ตอบเป็นข้อความล้วน ห้ามใส่ JSON, markdown, bullet หรือหัวข้อ',
  'ห้ามแต่งเติมเรื่องที่ไม่มีในข้อความ',
].join('\n');

function buildChitChatPrompt(texts, now) {
  return [
    CHITCHAT_RULES,
    '',
    'เวลาปัจจุบัน (เขตเวลาไทย): ' + nowLocalIso(now),
    '',
    'ข้อความจากผู้ใช้:',
    texts.map((t, i) => i + 1 + '. ' + t).join('\n'),
  ].join('\n');
}

function buildPrompt(userText, now) {
  return [
    SYSTEM_RULES,
    '',
    'เวลาปัจจุบัน (เขตเวลาไทย): ' + nowLocalIso(now),
    'วันนี้คือ' + thaiWeekday(now),
    '',
    'ข้อความจากผู้ใช้:',
    userText,
  ].join('\n');
}

/** Strip a ```json fence if the model added one anyway. */
function extractJson(text) {
  const cleaned = String(text || '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (_err) {
      return null;
    }
  }
}

/**
 * Turn a raw model response string into { title, deadlineIso (UTC), category }.
 * Shared by both providers so the validation rules can never drift apart.
 */
function finalizeResult(rawText, provider) {
  const parsed = extractJson(rawText);
  if (!parsed) throw new ParseError('Model did not return JSON (' + provider + ')', 'bad_json');
  if (parsed.confident === false) throw new ParseError('Model not confident', 'low_confidence');

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const deadlineIso = toUtcIso(parsed.deadline_iso);
  if (!title) throw new ParseError('Missing title', 'no_title');
  if (!deadlineIso) throw new ParseError('Missing or invalid deadline', 'no_deadline');

  const category =
    typeof parsed.category === 'string' && parsed.category.trim()
      ? parsed.category.trim().slice(0, 30)
      : null;

  return { title: title.slice(0, 120), deadlineIso, category };
}

/**
 * Call Gemini and return the raw response text.
 * Now the fallback leg: reached only after Ox Alpha has already failed, so any
 * ParseError thrown here is terminal and surfaces to the user.
 */
async function callGemini(prompt, { json = true } = {}) {
  const url = API_BASE + encodeURIComponent(config.gemini.model) + ':generateContent';
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: json
      ? {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        }
      : { temperature: 0.3 },
  };

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Key travels in a header so it never lands in a URL or access log.
          'x-goog-api-key': config.gemini.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ParseError('Gemini request failed: ' + err.name, 'network');
    }

    if (res.status !== 429 || attempt >= MAX_429_RETRIES) break;

    const retryAfterHeader = Number(res.headers.get('retry-after'));
    const rawDelay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
    const delay = Math.min(rawDelay, MAX_RETRY_DELAY_MS);
    console.warn('[gemini] 429, retrying in ' + delay + 'ms (attempt ' + (attempt + 1) + ')');
    await res.body?.cancel();
    await sleep(delay);
  }

  if (!res.ok) {
    // Status only — the error body can echo request material.
    throw new ParseError('Gemini returned HTTP ' + res.status, 'http_' + res.status);
  }

  const payload = await res.json().catch(() => null);
  return payload &&
    payload.candidates &&
    payload.candidates[0] &&
    payload.candidates[0].content &&
    payload.candidates[0].content.parts &&
    payload.candidates[0].content.parts.map((p) => p.text || '').join('');
}

/**
 * Call OpenRouter (OpenAI-compatible) and return the raw response text.
 * This is the primary leg. Ox Alpha has no structured-output schema, so
 * JSON-ness rests on the same SYSTEM_RULES instructions plus response_format,
 * with extractJson() as a net — and, failing that, the Gemini fallback.
 */
async function callOpenRouter(prompt, { json = true } = {}) {
  const body = {
    model: config.openrouter.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: json ? 0 : 0.3,
  };
  if (json) body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.openrouter.apiKey,
        // Optional OpenRouter analytics headers.
        'HTTP-Referer': 'https://github.com/line-reminder-bot',
        'X-Title': 'line-reminder-bot',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ParseError('OpenRouter request failed: ' + err.name, 'network');
  }

  if (!res.ok) {
    // Status only — the error body can echo request material.
    throw new ParseError('OpenRouter returned HTTP ' + res.status, 'http_' + res.status);
  }

  const payload = await res.json().catch(() => null);
  const text =
    payload &&
    payload.choices &&
    payload.choices[0] &&
    payload.choices[0].message &&
    payload.choices[0].message.content;
  return typeof text === 'string' ? text : '';
}

/**
 * Parse a free-form Thai message into { title, deadlineIso (UTC), category }.
 * Ox Alpha is primary, Gemini is the fallback. Unlike the previous arrangement,
 * the fallback trigger is deliberately broad: Ox Alpha is an anonymous
 * stealth/preview model with no published rate limits or documented failure
 * modes, so we cannot assume it only fails as a 429. ANY ParseError out of the
 * Ox Alpha leg — 429, other 4xx/5xx, network, unusable JSON — re-runs the same
 * prompt through Gemini, which at least has a response schema to lean on.
 * The two exceptions:
 *   - a missing OPENROUTER_API_KEY is a config problem Gemini cannot fix, so it
 *     surfaces directly (guard clause below, outside the try);
 *   - 'low_confidence' is a verdict about the user's text, not a provider
 *     failure — a second opinion would just double the cost of every chit-chat
 *     message, so it surfaces as-is.
 * Throws ParseError on anything the caller should answer with a Thai retry message.
 */
function isKeyMissing(key) {
  return !key || key.startsWith('REPLACE_ME');
}

/**
 * Run one prompt through Ox Alpha, falling back to Gemini, and hand the raw
 * response text to `finalize`. Both callers share this so the retry/timeout,
 * fallback-trigger and key-guard rules can never drift apart between them.
 *
 * `finalize` runs inside the try on purpose: an unusable response from Ox Alpha
 * is exactly the kind of failure the fallback exists to absorb.
 */
async function runWithFallback({ label, prompt, finalize, json }) {
  if (isKeyMissing(config.openrouter.apiKey)) {
    throw new ParseError('OPENROUTER_API_KEY is not configured', 'no_api_key');
  }

  try {
    const result = finalize(await callOpenRouter(prompt, { json }), config.openrouter.model);
    console.info('[' + label + '] served by ox-alpha (primary) (' + config.openrouter.model + ')');
    return result;
  } catch (err) {
    const recoverable = err instanceof ParseError && err.code !== 'low_confidence';
    if (!recoverable) throw err;
    if (isKeyMissing(config.gemini.apiKey)) {
      console.warn(
        '[' + label + '] ox-alpha failed (' + err.code + ') and no GEMINI_API_KEY — giving up'
      );
      throw err;
    }
    console.warn(
      '[' + label + '] ox-alpha failed (' + err.code + '), falling back to ' + config.gemini.model
    );
    const result = finalize(await callGemini(prompt, { json }), config.gemini.model);
    console.debug('[' + label + '] served by gemini fallback (' + config.gemini.model + ')');
    return result;
  }
}

async function parseReminder(userText, now = new Date()) {
  return runWithFallback({
    label: 'parseReminder',
    prompt: buildPrompt(userText, now),
    finalize: finalizeResult,
    json: true,
  });
}

/** Trim a free-text summary down to something a push message can carry. */
function finalizeSummary(rawText, provider) {
  const summary = String(rawText || '')
    .replace(/```/g, '')
    .trim();
  if (!summary) throw new ParseError('Empty summary (' + provider + ')', 'empty_summary');
  return summary.slice(0, 500);
}

/**
 * Summarise a day's worth of non-schedule messages from ONE user into a short
 * Thai paragraph. Same primary/fallback path as parseReminder.
 * The caller must not pass an empty array — an empty bucket means there is
 * nothing to summarise and no call should be made at all.
 * Throws ParseError; the nightly job degrades to "no summary" rather than
 * dropping the whole digest.
 */
async function summarizeChitChat(texts, now = new Date()) {
  if (!Array.isArray(texts) || !texts.length) {
    throw new ParseError('summarizeChitChat called with no messages', 'empty_input');
  }
  return runWithFallback({
    label: 'summarizeChitChat',
    prompt: buildChitChatPrompt(texts, now),
    finalize: finalizeSummary,
    json: false,
  });
}

module.exports = { parseReminder, summarizeChitChat, ParseError };
