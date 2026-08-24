'use strict';

const { config } = require('./config');
const { nowLocalIso, thaiWeekday, toUtcIso } = require('./datetime');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
// Fallback provider: OpenAI-compatible chat/completions. Only used when Gemini
// has burned through its 429 retries — see parseReminder().
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
 * Throws ParseError('http_429') once the 429 retries are exhausted — that is the
 * one failure the caller is allowed to treat as "try the fallback provider".
 */
async function callGemini(prompt) {
  const url = API_BASE + encodeURIComponent(config.gemini.model) + ':generateContent';
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
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
 * Ox Alpha has no structured-output schema, so JSON-ness rests on the same
 * SYSTEM_RULES instructions plus response_format, with extractJson() as a net.
 */
async function callOpenRouter(prompt) {
  const body = {
    model: config.openrouter.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    response_format: { type: 'json_object' },
  };

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
 * Gemini is primary. If — and only if — Gemini is still rate-limited after its
 * retries, the same prompt is re-run through OpenRouter/Ox Alpha. Every other
 * Gemini failure (network, bad JSON, low confidence) fails exactly as before:
 * Ox Alpha is a stealth/preview model and must not become a silent default.
 * Throws ParseError on anything the caller should answer with a Thai retry message.
 */
async function parseReminder(userText, now = new Date()) {
  if (!config.gemini.apiKey || config.gemini.apiKey.startsWith('REPLACE_ME')) {
    throw new ParseError('GEMINI_API_KEY is not configured', 'no_api_key');
  }

  const prompt = buildPrompt(userText, now);

  let text;
  try {
    text = await callGemini(prompt);
  } catch (err) {
    const rateLimited = err instanceof ParseError && err.code === 'http_429';
    if (!rateLimited) throw err;
    if (!config.openrouter.apiKey) {
      console.warn('[parseReminder] gemini rate-limited and no OPENROUTER_API_KEY — giving up');
      throw err;
    }
    console.warn('[parseReminder] gemini rate-limited, falling back to ' + config.openrouter.model);
    const fallbackText = await callOpenRouter(prompt);
    const result = finalizeResult(fallbackText, config.openrouter.model);
    console.info('[parseReminder] served by ox-alpha fallback (' + config.openrouter.model + ')');
    return result;
  }

  const result = finalizeResult(text, 'gemini');
  console.debug('[parseReminder] served by gemini (' + config.gemini.model + ')');
  return result;
}

module.exports = { parseReminder, ParseError };
