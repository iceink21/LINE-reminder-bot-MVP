'use strict';

const { config } = require('./config');
const { nowLocalIso, thaiWeekday, toUtcIso } = require('./datetime');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
// gemini-3.6-flash is a thinking model: even a one-line parse burns a few hundred
// thinking tokens, and measured round-trips ranged 11.5-22.6s. Thinking cannot be
// switched off for this model (thinkingBudget: 0 is rejected with HTTP 400, and a
// 128-token budget did not shorten the call), so the only lever is the timeout.
// The webhook already ACKs LINE immediately and parses asynchronously, so a long
// ceiling here costs nothing but a slower failure on a genuinely stuck request.
const REQUEST_TIMEOUT_MS = 45000;

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
 * Parse a free-form Thai message into { title, deadlineIso (UTC), category }.
 * Throws ParseError on anything the caller should answer with a Thai retry message.
 */
async function parseReminder(userText, now = new Date()) {
  if (!config.gemini.apiKey || config.gemini.apiKey.startsWith('REPLACE_ME')) {
    throw new ParseError('GEMINI_API_KEY is not configured', 'no_api_key');
  }

  const url = API_BASE + encodeURIComponent(config.gemini.model) + ':generateContent';
  const body = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(userText, now) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  let res;
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

  if (!res.ok) {
    // Status only — the error body can echo request material.
    throw new ParseError('Gemini returned HTTP ' + res.status, 'http_' + res.status);
  }

  const payload = await res.json().catch(() => null);
  const text = payload &&
    payload.candidates &&
    payload.candidates[0] &&
    payload.candidates[0].content &&
    payload.candidates[0].content.parts &&
    payload.candidates[0].content.parts.map((p) => p.text || '').join('');

  const parsed = extractJson(text);
  if (!parsed) throw new ParseError('Model did not return JSON', 'bad_json');
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

module.exports = { parseReminder, ParseError };
