'use strict';

const { config } = require('./config');
const {
  nowLocalIso,
  thaiWeekday,
  toUtcIso,
  resolveWeekday,
  withTimeOfDay,
} = require('./datetime');

// Fallback provider — see parseReminder().
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
// Primary provider: OpenAI-compatible chat/completions (NVIDIA Nemotron 3.5
// Lightning, free tier, via OpenRouter).
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// The webhook now parses inline before replying, so this ceiling sits on the
// critical path of a LINE reply token: a stuck request can outlive the token
// and the user gets silence instead of a reply. Kept short for that reason,
// even though gemini-3.6-flash (the fallback, a thinking model that cannot
// have thinking switched off) has measured round-trips of 11.5-22.6s on its
// own — a call that lands past this ceiling reports as a timeout rather than
// completing, which is the accepted trade-off for keeping the reply prompt.
const REQUEST_TIMEOUT_MS = 12000;
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
  'รูปแบบ: {"title": string, "deadline_iso": string|null, "relative_weekday": string|null, "weekday_qualifier": "this"|"next"|null, "time_of_day": string|null, "category": string|null, "recurring": boolean, "confident": boolean}',
  '- title: ชื่องานสั้น กระชับ ภาษาไทย ไม่ต้องใส่วันเวลาซ้ำในชื่อ',
  '- recurring: true เมื่อเป็นสิ่งที่ต้องทำ "ทุกวัน" เป็นประจำ ไม่มีวันกำหนดส่งตายตัว',
  '  เช่น "กินยาทุกวัน", "เตือนดื่มน้ำให้ครบทุกวัน", "ออกกำลังกายทุกเช้า" → recurring: true',
  '  ถ้า recurring เป็น true ให้ใส่ deadline_iso เป็น null และห้ามเดาวันกำหนดส่งขึ้นมาเอง',
  '- recurring: false (ค่าปกติ) สำหรับงานครั้งเดียวที่มีกำหนดส่ง — ต้องมี deadline_iso เสมอ',
  '  ยกเว้นกรณีที่ผู้ใช้อ้างถึงชื่อวันในสัปดาห์ ให้เว้น deadline_iso เป็น null แล้วใช้ relative_weekday แทน (ดูกฎด้านล่าง)',
  '- deadline_iso: ISO 8601 พร้อม offset +07:00 (เวลาไทย) เช่น 2026-08-28T15:00:00+07:00',
  '- คำนวณวันที่สัมพัทธ์ ("พรุ่งนี้", "วันนี้", "อีก 3 วัน", "สิ้นเดือน") จากเวลาปัจจุบันที่ให้ไว้',
  '  และวันที่ระบุตรง ๆ (เช่น "28 ส.ค.", "2026-08-28") ก็ใส่ deadline_iso ตามปกติ',
  // The model is unreliable at weekday arithmetic, so it is taken out of the
  // loop entirely: it names the weekday, resolveWeekday() does the math.
  '- ถ้าผู้ใช้อ้างถึง "ชื่อวันในสัปดาห์" ("จันทร์นี้", "วันจันทร์หน้า", "ศุกร์หน้า", "พุธนี้")',
  '  ให้ถือว่ากฎนี้เหนือกว่ากฎ "ต้องมี deadline_iso เสมอ" ข้างบนเสมอ',
  '  ห้ามคำนวณวันที่เอง ให้ deadline_iso เป็น null — แล้วระบุเป็นสัญลักษณ์แทน:',
  '  relative_weekday = ชื่อวันล้วน ๆ หนึ่งใน "จันทร์","อังคาร","พุธ","พฤหัสบดี","ศุกร์","เสาร์","อาทิตย์"',
  '  weekday_qualifier = "this" ถ้าผู้ใช้พูดว่า "...นี้", "next" ถ้าพูดว่า "...หน้า", ไม่ชัดให้ null',
  '  time_of_day = เวลาในรูป "HH:MM" แบบ 24 ชั่วโมง ถ้าผู้ใช้ระบุเวลา ไม่ระบุให้ null',
  '  ระบบจะคำนวณวันที่จริงให้เอง ไม่ต้องคิดแทน',
  // "อาทิตย์" is both "Sunday" and "week". Bare "อาทิตย์หน้า" almost always
  // means NEXT WEEK, and letting it fill the symbolic slot would fire the
  // reminder on Sunday — up to six days early. Disambiguated here, at the
  // prompt, because only the prompt still sees the user's original wording.
  '- คำว่า "อาทิตย์" ภาษาไทยหมายได้ทั้ง "วันอาทิตย์" และ "สัปดาห์" ให้แยกตามการมี "วัน" นำหน้า',
  '  ถ้าผู้ใช้พูดว่า "อาทิตย์หน้า"/"อาทิตย์นี้" โดยไม่มี "วัน" นำหน้า ให้ถือว่าหมายถึงสัปดาห์ ไม่ใช่วันอาทิตย์',
  '  กรณีนี้ห้ามใส่ relative_weekday (ให้เป็น null) แต่ให้คำนวณวันที่แล้วใส่ deadline_iso ตามปกติ',
  '  ส่วน "วันอาทิตย์หน้า"/"วันอาทิตย์นี้" (มี "วัน" นำหน้า) หมายถึงวันอาทิตย์จริง ๆ',
  '  ให้ใช้ relative_weekday = "อาทิตย์" และ deadline_iso = null ตามกฎชื่อวันข้างบน',
  '- ถ้าไม่ได้อ้างชื่อวันในสัปดาห์ ให้ relative_weekday, weekday_qualifier, time_of_day เป็น null ทั้งหมด',
  '- "บ่าย 3 โมง" = 15:00; "ทุ่ม" = 19:00 + n',
  '- "คาบ N" (คาบเรียนที่ N) = เวลาเริ่มคาบนั้น คิดจาก 08:00 แล้วบวก (N-1) ชั่วโมง',
  '  เช่น คาบ 1 = 08:00, คาบ 2 = 09:00, คาบ 3 = 10:00, คาบ 4 = 11:00, คาบ 5 = 12:00',
  '  เมื่อระบุคาบมาแล้ว ถือว่าระบุเวลาแล้ว ห้ามใช้ 09:00 เป็นค่าเริ่มต้น',
  '  ถ้า "คาบ N" มากับชื่อวันในสัปดาห์ ให้ใส่เวลานั้นใน time_of_day (เช่น คาบ 3 → "10:00")',
  '  ถ้า "คาบ N" มากับวันที่ระบุตรง ๆ ให้ใส่เวลานั้นใน deadline_iso ตามปกติ',
  '- ถ้าไม่ได้ระบุเวลา ให้ใช้ 09:00 ของวันนั้น',
  '- category: หนึ่งใน "เรียน", "งาน", "ส่วนตัว", "สุขภาพ", "การเงิน" หรือ null ถ้าไม่ชัด',
  '- confident: false ถ้าข้อความไม่ใช่การสั่งงาน หรือเป็นงานครั้งเดียวที่ไม่มีกำหนดเวลาที่พอจะเดาได้',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    // Nullable and no longer required: a standing ("ทุกวัน") reminder has no
    // deadline at all. finalizeResult still rejects a missing deadline on the
    // non-recurring path, so the default behaviour is unchanged.
    deadline_iso: { type: 'STRING', nullable: true },
    // Symbolic weekday slot. The model names the day, finalizeResult resolves
    // the actual date via resolveWeekday() — nullable and NOT required, so a
    // message with no weekday reference is unaffected.
    relative_weekday: { type: 'STRING', nullable: true },
    weekday_qualifier: { type: 'STRING', nullable: true },
    time_of_day: { type: 'STRING', nullable: true },
    category: { type: 'STRING', nullable: true },
    recurring: { type: 'BOOLEAN' },
    confident: { type: 'BOOLEAN' },
  },
  required: ['title', 'recurring', 'confident'],
};

const DAY_RULES = [
  'คุณคือผู้ช่วยที่สรุปบทสนทนาภาษาไทยของผู้ใช้ในหนึ่งวัน',
  'ข้อความเหล่านี้คือข้อความทั้งหมดที่ผู้ใช้ส่งมาในวันนี้ ทั้งเรื่องงานและเรื่องทั่วไป',
  'สรุปสิ่งที่ผู้ใช้พูดคุย/ทำในวันนี้ทั้งหมด เป็นย่อหน้าสั้น ๆ ภาษาไทย ไม่เกิน 3 ประโยค',
  'ตอบเป็นข้อความล้วน ห้ามใส่ JSON, markdown, bullet หรือหัวข้อ',
  'ห้ามแต่งเติมเรื่องที่ไม่มีในข้อความ',
].join('\n');

const CHAT_RULES = [
  'คุณคือผู้ช่วยส่วนตัวใน LINE ของผู้ใช้ พูดแทนตัวเองว่า "ผม"',
  'ตอบสั้น กระชับ เป็นกันเอง ใช้ภาษาไทยเป็นหลัก ใส่อีโมจิได้บ้างแต่อย่าเยอะ',
  'นอกจากคุยเล่น คุณยังทำหน้าที่จดงานและเตือนก่อนถึงกำหนดให้ด้วย',
  'ถ้าผู้ใช้ถามว่าทำอะไรได้บ้าง ให้บอกว่าพิมพ์งานพร้อมกำหนดส่งมาได้เลย เดี๋ยวจดและเตือนให้ และมีคำสั่ง /list /done /delete',
  // The task path already ran and declined this message, so re-parsing it here
  // would only produce a second, conflicting verdict.
  'ข้อความนี้ไม่ใช่การสั่งงาน ให้คุยตอบตามปกติ ห้ามพยายามแปลงเป็นรายการงานหรือถามหากำหนดส่ง',
  'ตอบเป็นข้อความล้วน ห้ามใส่ JSON, markdown หรือ code fence',
  'ห้ามแต่งเรื่องที่ไม่รู้ ถ้าไม่รู้ให้บอกตรง ๆ',
].join('\n');

function buildChatPrompt(userText, history, now) {
  const turns = (history || []).map(
    (h) => (h.role === 'assistant' ? 'คุณ: ' : 'ผู้ใช้: ') + h.content
  );
  return [
    CHAT_RULES,
    '',
    'เวลาปัจจุบัน (เขตเวลาไทย): ' + nowLocalIso(now),
    '',
    'บทสนทนาก่อนหน้า:',
    turns.length ? turns.join('\n') : '(ยังไม่มี)',
    '',
    'ข้อความใหม่จากผู้ใช้:',
    userText,
  ].join('\n');
}

function buildDayPrompt(texts, now) {
  return [
    DAY_RULES,
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
 * Turn a raw model response string into
 * { title, deadlineIso (UTC | null), category, recurring }.
 * Shared by both providers so the validation rules can never drift apart.
 *
 * `recurring` is opt-in and defaults to false: anything the model does not
 * explicitly flag as a daily standing reminder keeps the original contract,
 * deadline included, and still throws 'no_deadline' without one.
 *
 * Deadline precedence:
 *   1. recurring === true            -> no deadline at all, every date slot ignored
 *   2. a resolvable `relative_weekday` -> date computed HERE from `now`, and it
 *      overrides any `deadline_iso` the model emitted alongside it (the model
 *      often sends both, and only the symbolic slot is trustworthy — see the
 *      note on resolveWeekday)
 *   3. otherwise                     -> `deadline_iso` as before
 *
 * `now` is what the weekday resolution is measured against; it is threaded in
 * from parseReminder so tests can pin it.
 */
function finalizeResult(rawText, provider, now = new Date()) {
  const parsed = extractJson(rawText);
  if (!parsed) throw new ParseError('Model did not return JSON (' + provider + ')', 'bad_json');
  if (parsed.confident === false) throw new ParseError('Model not confident', 'low_confidence');

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const recurring = parsed.recurring === true;
  const weekdayDate = recurring
    ? null
    : resolveWeekday(now, parsed.relative_weekday, parsed.weekday_qualifier);
  const deadlineIso = weekdayDate
    ? toUtcIso(withTimeOfDay(weekdayDate, parsed.time_of_day))
    : toUtcIso(parsed.deadline_iso);
  if (!title) throw new ParseError('Missing title', 'no_title');
  // A standing reminder is defined by having no deadline, so a stray one the
  // model invented anyway is dropped rather than half-honoured.
  if (!deadlineIso && !recurring) {
    throw new ParseError('Missing or invalid deadline', 'no_deadline');
  }

  const category =
    typeof parsed.category === 'string' && parsed.category.trim()
      ? parsed.category.trim().slice(0, 30)
      : null;

  return {
    title: title.slice(0, 120),
    deadlineIso: recurring ? null : deadlineIso,
    category,
    recurring,
  };
}

/**
 * Call Gemini and return the raw response text.
 * Now the fallback leg: reached only after OpenRouter has already failed, so any
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
 * This is the primary leg. Nemotron 3.5 Lightning has no structured-output schema, so
 * JSON-ness rests on the same SYSTEM_RULES instructions plus response_format,
 * with extractJson() as a net — and, failing that, the Gemini fallback.
 */
async function callOpenRouter(prompt, { json = true } = {}) {
  const body = {
    model: config.openrouter.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: json ? 0 : 0.3,
    // Nemotron 3.5 Lightning is a thinking model and reasons by default: a
    // measured parse burned 1549 reasoning tokens over 82.7s, far past
    // REQUEST_TIMEOUT_MS, so every call would time out into the Gemini
    // fallback. Disabling reasoning brings the same parse to 2.8s. Note that
    // `reasoning: { effort: 'low' }` is NOT enough — it was ignored (1406
    // reasoning tokens, 68.9s); only `enabled: false` takes effect.
    reasoning: { enabled: false },
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
 * Parse a free-form Thai message into
 * { title, deadlineIso (UTC | null), category, recurring }.
 * Nemotron 3.5 Lightning (free) is primary, Gemini is the fallback. The
 * fallback trigger is deliberately broad: a free-tier OpenRouter model carries
 * tight shared rate limits and can be deprecated or capacity-starved without
 * notice, so we cannot assume it only fails as a 429. ANY ParseError out of the
 * OpenRouter leg — 429, other 4xx/5xx, network, unusable JSON — re-runs the same
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
 * Run one prompt through OpenRouter, falling back to Gemini, and hand the raw
 * response text to `finalize`. Both callers share this so the retry/timeout,
 * fallback-trigger and key-guard rules can never drift apart between them.
 *
 * `finalize` runs inside the try on purpose: an unusable response from OpenRouter
 * is exactly the kind of failure the fallback exists to absorb.
 */
async function runWithFallback({ label, prompt, finalize, json }) {
  if (isKeyMissing(config.openrouter.apiKey)) {
    throw new ParseError('OPENROUTER_API_KEY is not configured', 'no_api_key');
  }

  try {
    const result = finalize(await callOpenRouter(prompt, { json }), config.openrouter.model);
    console.info('[' + label + '] served by openrouter (primary) (' + config.openrouter.model + ')');
    return result;
  } catch (err) {
    const recoverable = err instanceof ParseError && err.code !== 'low_confidence';
    if (!recoverable) throw err;
    if (isKeyMissing(config.gemini.apiKey)) {
      console.warn(
        '[' + label + '] openrouter (' + config.openrouter.model + ') failed (' + err.code + ') and no GEMINI_API_KEY — giving up'
      );
      throw err;
    }
    console.warn(
      '[' + label + '] openrouter (' + config.openrouter.model + ') failed (' + err.code + '), falling back to ' + config.gemini.model
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
    // Closed over `now` so the weekday resolution inside finalizeResult is
    // measured against the same instant the prompt was grounded on.
    finalize: (rawText, provider) => finalizeResult(rawText, provider, now),
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
 * Summarise ALL of one user's messages for the day — task and non-task alike —
 * into a short Thai paragraph. Same primary/fallback path as parseReminder.
 * The caller must not pass an empty array — an empty bucket means there is
 * nothing to summarise and no call should be made at all.
 * Throws ParseError; the nightly job degrades to "no summary" rather than
 * leaving the day's messages unprocessed.
 */
async function summarizeDay(texts, now = new Date()) {
  if (!Array.isArray(texts) || !texts.length) {
    throw new ParseError('summarizeDay called with no messages', 'empty_input');
  }
  return runWithFallback({
    label: 'summarizeDay',
    prompt: buildDayPrompt(texts, now),
    finalize: finalizeSummary,
    json: false,
  });
}

/**
 * Trim a free-text chat reply. The cap is well under LINE's 5000-char message
 * limit — a chat turn that long is a runaway answer, not a conversation.
 */
function finalizeChatReply(rawText, provider) {
  const replyText = String(rawText || '')
    .replace(/```/g, '')
    .trim();
  if (!replyText) throw new ParseError('Empty chat reply (' + provider + ')', 'empty_reply');
  return replyText.slice(0, 1000);
}

/**
 * Answer a message the reminder parser already rejected, in conversation.
 * `history` is `[{ role, content }]` oldest first, as `getRecentChatHistory`
 * returns it. Same primary/fallback path as parseReminder, so timeout and
 * retry behaviour cannot drift between the three call sites.
 * Throws ParseError; the caller degrades to a canned ack rather than silence.
 */
async function chatReply(userText, history, now = new Date()) {
  return runWithFallback({
    label: 'chatReply',
    prompt: buildChatPrompt(userText, history, now),
    finalize: finalizeChatReply,
    json: false,
  });
}

// finalizeResult is exported for tests only — it is the pure, network-free core
// of the parse path, so its precedence rules can be checked without an API call.
module.exports = { parseReminder, summarizeDay, chatReply, ParseError, finalizeResult };
