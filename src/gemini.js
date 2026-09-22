'use strict';

const { config } = require('./config');
const {
  nowLocalIso,
  thaiWeekday,
  toUtcIso,
  resolveWeekday,
  resolveBareWeekReference,
  withTimeOfDay,
} = require('./datetime');

// BOTH legs are OpenAI-compatible chat/completions calls to OpenRouter, on one
// key and through one client (callOpenRouter), differing only in the model id
// and the retry policy passed in:
//   - primary  = inception/mercury-2.5 (paid but cheap, ~$0.00046 per parse).
//     Measured 9/9 reps at 4.9-8.5s against the real 2,982-char Thai prompt,
//     with bounded, stable reasoning (2035-2460 tokens, no spikes). NO retries.
//   - fallback = qwen/qwen3-30b-a3b-instruct-2507, an instruct-only build with
//     no reasoning in the weights. Retries 429s (see MAX_429_RETRIES).
// The fallback used to be Google Gemini direct — a second provider, a second
// key, and a second response shape. That is gone; there was never an SDK, only
// a URL constant and a second call function.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// ---------------------------------------------------------------------------
// TIMEOUT BUDGETS — THREE numbers, and they are coupled. Read this before
// touching any one of them.
//
// What actually constrains us is the LINE **reply token**: valid for ~60s,
// single-use. It is NOT the webhook. The webhook already acks in well under
// LINE's 1s limit — src/index.js sends `res.status(200).end()` BEFORE
// handleEvent() is called and deliberately does not await it, so HTTP ack and
// parsing are decoupled already. The old single 12s ceiling was set as if the
// webhook were the constraint; it was not, and it guillotined the fallback for
// no reason.
//
// Delivery stays on `reply`, not `push`, on purpose: replies are free and
// unlimited on every LINE plan, while push is capped at 200/month (~6/day).
// Buying latency headroom with push quota would be strictly worse than
// spending more of the 60s reply window we already have for free.
//
// Inside ONE chain the worst case is SEQUENTIAL, not parallel:
//     primary times out  ->  fallback runs  ->  LINE reply API call
// so a chain costs up to PRIMARY + FALLBACK = 25s + 20s = 45s.
//
// But PRIMARY + FALLBACK is NOT the invariant, and treating it as one was a
// real regression. One LINE event can run TWO chains back to back: webhook.js
// calls parseReminder, and a not-a-task verdict then calls chatReply on the
// SAME, already-partly-spent reply token. 45s twice is 90s against a 60s
// token. The old shared 12s ceiling happened to survive this (12x4 = 48s);
// raising the per-chain numbers broke a configuration that was only
// accidentally safe. It is not hypothetical either — the measurement that
// started this whole investigation was a free-tier call that hung 120s and
// returned an empty HTTP 200. Fast errors (402/503) collapse both chains to
// ~1s and are harmless; HANGS are exactly what these budgets exist for and
// exactly what used to break them.
//
// So the real bound is a THIRD number, `config.llm.eventBudgetMs` (45s):
// ONE deadline per LINE event, created in webhook.js at event receipt and
// threaded through every LLM call that event makes. The invariant is
//     EVENT BUDGET + reply round-trip  <  60s
// and every leg below runs for min(its own budget, time left on that
// deadline). config.js checks THAT expression at startup.
//
// Two further rules follow from the same reasoning and are enforced in code:
//   - a leg's budget covers the WHOLE leg, retries and backoff sleeps
//     included, not each individual fetch (see callOpenRouter's legDeadline);
//   - webhook.js only starts a second chain for a verdict about the USER'S
//     TEXT ('low_confidence' and friends), never after a provider failure —
//     a second LLM call cannot help when the provider is down, and it is what
//     doubled the budget in the first place.
//
// Why the fallback still gets its own, separate 20s rather than sharing the
// primary's number: it is the only leg that RETRIES, and its budget has to
// cover every attempt plus the backoff sleeps between them (the primary makes
// exactly one fetch, so for it leg budget and fetch budget coincide). The old
// justification for this figure — gemini-3.6-flash's undisableable 11.5-22.6s
// thinking latency — no longer applies now that the fallback is
// qwen3-30b-a3b-instruct-2507, which does not reason at all and should answer
// well inside a single attempt. The 20s is therefore RETRY headroom, not
// think-time headroom: up to 3 attempts plus 2 clamped backoff sleeps have to
// fit inside it, and it is kept at 20s rather than trimmed because shrinking it
// would buy nothing (the event budget, not this number, is the real bound) and
// would cost the retries their room. If the fallback is ever pointed at a
// thinking model again, re-check this number against that model's floor.
//
// All three overridable via LLM_PRIMARY_TIMEOUT_MS / LLM_FALLBACK_TIMEOUT_MS /
// LLM_EVENT_BUDGET_MS.
const PRIMARY_TIMEOUT_MS = config.llm.primaryTimeoutMs;
const FALLBACK_TIMEOUT_MS = config.llm.fallbackTimeoutMs;
const EVENT_BUDGET_MS = config.llm.eventBudgetMs;
// Below this there is no point starting (or retrying) an HTTP call: it would
// be aborted before any plausible provider could answer, and the abort itself
// then eats the remaining budget. Used to abandon rather than start a doomed
// attempt.
const MIN_ATTEMPT_MS = 1000;
// OpenRouter rate-limits per key, so a burst of traffic (or a shared upstream
// pool) produces transient 429s — retry a couple of times with backoff before
// giving up, honoring Retry-After when the response carries it. This applies to
// the FALLBACK leg only: the primary is given `retries: 0` deliberately, since
// it already has a fallback behind it and spending the primary's budget on a
// retry would just delay reaching it.
const MAX_429_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1500;
// Daily-quota 429s can carry a Retry-After measured in hours, not seconds —
// clamp it so we never sleep past the point the LINE reply token is dead.
// The clamp alone was NOT enough: the retry sleeps and the per-fetch
// AbortSignal used to be unbounded as a group, so with MAX_429_RETRIES = 2 a
// leg documented as 20s could really run 3 x 20s of fetch plus 2 x 8s of sleep
// = ~76s. Both the sleeps and the fetches now sit under one per-leg deadline
// (see callOpenRouter), which is what actually enforces the 20s.
const MAX_RETRY_DELAY_MS = 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How much of a budget is left, given an optional absolute deadline.
 * `deadline` is a ms timestamp (Date.now() based) or null/undefined for "no
 * event deadline" — the scheduler's nightly summarizeDay has no reply token to
 * race, so it passes none and is bounded only by the per-leg budgets.
 */
function remainingMs(budgetMs, deadline) {
  if (!deadline) return budgetMs;
  return Math.min(budgetMs, deadline - Date.now());
}

/** Thrown when the message cannot be turned into a usable reminder. */
class ParseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ParseError';
    this.code = code || 'parse_failed';
  }
}

/**
 * Absolute deadline for ALL LLM work belonging to one LINE event.
 * Called once, at event receipt, and threaded down from there — never
 * recomputed mid-event, or the second chain would silently get a fresh budget
 * and we would be back to the 90s worst case this exists to prevent.
 */
const newEventDeadline = (from = Date.now()) => from + EVENT_BUDGET_MS;

// ParseError codes that mean "the PROVIDER broke", as opposed to "the model
// read the user's text and this was not a usable task". The distinction is not
// cosmetic: a provider failure must NOT trigger a second LLM chain, because a
// second call cannot help when the provider is down or hanging, and running
// one is what doubles the event's timeout budget.
const PROVIDER_FAILURE_CODES = new Set([
  'network', // includes the AbortSignal timeout — i.e. the hang case
  'bad_json',
  'empty_reply',
  'empty_summary',
  'no_api_key',
  'timeout',
  'deadline_exceeded',
  'parse_failed', // the ParseError default: unattributed, so assume the worst
]);

/**
 * True when this failure came from the provider rather than from reading the
 * user's message. Every 'http_*' code counts, 402 and 503 included.
 */
function isProviderFailure(err) {
  if (!(err instanceof ParseError)) return true;
  return PROVIDER_FAILURE_CODES.has(err.code) || /^http_/.test(err.code);
}

const SYSTEM_RULES = [
  'คุณคือระบบแยกวิเคราะห์ข้อความภาษาไทยให้เป็นข้อมูลงานที่มีกำหนดส่ง',
  'ตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นหรือ markdown code fence',
  'รูปแบบ: {"title": string, "deadline_iso": string|null, "relative_weekday": string|null, "weekday_qualifier": "this"|"next"|null, "time_of_day": string|null, "category": string|null, "recurring": boolean, "confident": boolean}',
  '- title: ชื่องานสั้น กระชับ ภาษาไทย ไม่ต้องใส่วันเวลาซ้ำในชื่อ',
  // recurring:true DESTROYS the deadline (finalizeResult forces deadlineIso to
  // null), so it must require an explicit repetition token. The old wording
  // described only "ทุกวัน" habits and left end-of-period deadlines unclassified:
  // live, "สิ้นเดือนจ่ายค่าหอ" came back recurring:true and was scheduled for
  // nothing at all.
  '- recurring: true เฉพาะเมื่อข้อความมีคำบอกการทำซ้ำชัด ๆ เท่านั้น',
  '  คำที่ถือว่าชัด: "ทุกวัน", "ทุกสัปดาห์", "ทุกเดือน", "ทุกปี", "ทุกเช้า", "ทุกเย็น", "ทุกคืน", "ประจำ"',
  '  เช่น "กินยาทุกวัน", "เตือนดื่มน้ำให้ครบทุกวัน", "ออกกำลังกายทุกเช้า" → recurring: true',
  '  ถ้า recurring เป็น true ให้ใส่ deadline_iso เป็น null และห้ามเดาวันกำหนดส่งขึ้นมาเอง',
  '  ถ้าไม่มีคำเหล่านั้น ให้ recurring เป็น false เสมอ แม้ข้อความจะอ้างถึงปลายช่วงเวลา',
  '  เช่น "สิ้นเดือนจ่ายค่าหอ", "สิ้นปีส่งรายงาน", "สิ้นสัปดาห์เคลียร์งาน" → recurring: false และต้องมี deadline_iso จริง',
  '  (งานที่ครบกำหนดครั้งเดียวตอนปลายเดือน/ปลายปี ไม่ใช่งานประจำ)',
  '- recurring: false (ค่าปกติ) สำหรับงานครั้งเดียวที่มีกำหนดส่ง — ต้องมี deadline_iso เสมอ',
  '  ยกเว้นกรณีที่ผู้ใช้อ้างถึงชื่อวันในสัปดาห์ ให้เว้น deadline_iso เป็น null แล้วใช้ relative_weekday แทน (ดูกฎด้านล่าง)',
  '- deadline_iso: ISO 8601 พร้อม offset +07:00 (เวลาไทย) เช่น 2026-08-28T15:00:00+07:00',
  '- คำนวณวันที่สัมพัทธ์ ("พรุ่งนี้", "วันนี้", "อีก 3 วัน", "สิ้นเดือน") จากเวลาปัจจุบันที่ให้ไว้',
  '  และวันที่ระบุตรง ๆ (เช่น "28 ส.ค.", "2026-08-28") ก็ใส่ deadline_iso ตามปกติ',
  '  "สิ้นเดือน" = วันสุดท้ายของเดือนปัจจุบัน (28/29/30/31 แล้วแต่เดือน)',
  '  "สิ้นปี" = 31 ธันวาคม ของปีปัจจุบัน; "ต้นเดือนหน้า" = วันที่ 1 ของเดือนถัดไป',
  // The model is unreliable at weekday arithmetic, so it is taken out of the
  // loop entirely: it names the weekday, resolveWeekday() does the math.
  '- ถ้าผู้ใช้อ้างถึง "ชื่อวันในสัปดาห์" ("จันทร์นี้", "วันจันทร์หน้า", "ศุกร์หน้า", "พุธนี้")',
  '  ให้ถือว่ากฎนี้เหนือกว่ากฎ "ต้องมี deadline_iso เสมอ" ข้างบนเสมอ',
  '  ห้ามคำนวณวันที่เอง ให้ deadline_iso เป็น null — แล้วระบุเป็นสัญลักษณ์แทน:',
  '  relative_weekday = ชื่อวันล้วน ๆ หนึ่งใน "จันทร์","อังคาร","พุธ","พฤหัสบดี","ศุกร์","เสาร์","อาทิตย์"',
  '  weekday_qualifier = "this" ถ้าผู้ใช้พูดว่า "...นี้", "next" ถ้าพูดว่า "...หน้า", ไม่ชัดให้ null',
  '  time_of_day = เวลาในรูป "HH:MM" แบบ 24 ชั่วโมง ถ้าผู้ใช้ระบุเวลา ไม่ระบุให้ null',
  '  ระบบจะคำนวณวันที่จริงให้เอง ไม่ต้องคิดแทน',
  // "อาทิตย์" is both "Sunday" and "week". The earlier version of this rule
  // asked the model to tell the two apart AND to compute the date itself for
  // the bare "next week" reading. It FAILED live 0/3 on 2026-09-16
  // (nvidia/nemotron-3.5-lightning:free, temperature 0, quota confirmed): one
  // rep returned relative_weekday=null AND deadline_iso=null, losing the
  // reminder to 'no_deadline'; two reps filled relative_weekday="อาทิตย์" —
  // the same value the real-Sunday phrasing produces — firing up to six days
  // early. It was also self-contradictory: it handed weekday arithmetic back
  // to the model, which is exactly what the symbolic slot exists to avoid.
  // The decision now lives entirely in code (resolveBareWeekReference), keyed
  // off the raw user text, and OVERRIDES both date slots. Do not re-litigate
  // this at the prompt layer. What is left below is only a nudge that keeps
  // the model's output harmless whichever slot it fills.
  '- คำว่า "อาทิตย์" ภาษาไทยหมายได้ทั้ง "วันอาทิตย์" และ "สัปดาห์"',
  '  ถ้ามี "วัน" นำหน้า ("วันอาทิตย์หน้า") หมายถึงวันอาทิตย์จริง ๆ',
  '  ให้ใช้ relative_weekday = "อาทิตย์" และ deadline_iso = null ตามกฎชื่อวันข้างบน',
  '  ถ้าไม่มี "วัน" นำหน้า ("อาทิตย์หน้า") หมายถึง "สัปดาห์หน้า" ระบบจะคำนวณวันที่ให้เอง',
  '  กรณีนี้จะใส่หรือไม่ใส่ relative_weekday ก็ได้ ไม่ต้องกังวล ระบบไม่ได้ใช้ค่านั้น',
  '- ถ้าไม่ได้อ้างชื่อวันในสัปดาห์ ให้ relative_weekday, weekday_qualifier, time_of_day เป็น null ทั้งหมด',
  '- "บ่าย 3 โมง" = 15:00',
  // The old form was '"ทุ่ม" = 19:00 + n', i.e. off by one: live, "5 ทุ่ม"
  // resolved to 00:00 of the NEXT day. Stated as a table so the model does not
  // have to apply a formula correctly.
  '- "ทุ่ม" นับแบบไทย: n ทุ่ม = (18+n):00 ของวันเดียวกัน',
  '  1 ทุ่ม = 19:00, 2 ทุ่ม = 20:00, 3 ทุ่ม = 21:00, 4 ทุ่ม = 22:00, 5 ทุ่ม = 23:00',
  '  ห้ามเริ่มนับจาก 19:00 แล้วบวก n และ "5 ทุ่ม" ต้องเป็น 23:00 ของวันนั้น ไม่ใช่ 00:00 ของวันถัดไป',
  '- "คาบ N" (คาบเรียนที่ N) = เวลาเริ่มคาบนั้น คิดจาก 08:00 แล้วบวก (N-1) ชั่วโมง',
  '  เช่น คาบ 1 = 08:00, คาบ 2 = 09:00, คาบ 3 = 10:00, คาบ 4 = 11:00, คาบ 5 = 12:00',
  '  เมื่อระบุคาบมาแล้ว ถือว่าระบุเวลาแล้ว ห้ามใช้ 09:00 เป็นค่าเริ่มต้น',
  '  ถ้า "คาบ N" มากับชื่อวันในสัปดาห์ ให้ใส่เวลานั้นใน time_of_day (เช่น คาบ 3 → "10:00")',
  '  ถ้า "คาบ N" มากับวันที่ระบุตรง ๆ ให้ใส่เวลานั้นใน deadline_iso ตามปกติ',
  '- ถ้าไม่ได้ระบุเวลา ให้ใช้ 09:00 ของวันนั้น',
  '- category: หนึ่งใน "เรียน", "งาน", "ส่วนตัว", "สุขภาพ", "การเงิน" หรือ null ถ้าไม่ชัด',
  '- confident: false ถ้าข้อความไม่ใช่การสั่งงาน หรือเป็นงานครั้งเดียวที่ไม่มีกำหนดเวลาที่พอจะเดาได้',
].join('\n');

// NOTE — ACCEPTED LOSS OF STRICTNESS (2026-09-22).
// There used to be a RESPONSE_SCHEMA here: a Google-shaped `responseSchema`
// (title/deadline_iso/relative_weekday/weekday_qualifier/time_of_day/category/
// recurring/confident, with only title+recurring+confident required) sent with
// every Gemini fallback call, which made the fallback the STRICTER of the two
// legs — it was schema-enforced while the primary was only instruction-guided.
// OpenAI-compatible `response_format: { type: 'json_object' }` has no equivalent
// in that shape: it guarantees syntactically valid JSON, not these keys. Now
// that both legs are OpenRouter, the schema has no endpoint to be sent to and
// the shape of the object is enforced NOWHERE at the wire level — SYSTEM_RULES
// states it in the prompt, and extractJson() + finalizeResult() are the only
// net, on BOTH legs. finalizeResult already rejects every bad shape it can see
// (missing title -> 'no_title', missing/unparseable deadline -> 'no_deadline',
// non-JSON -> 'bad_json'), so nothing silently passes; what is lost is the
// provider refusing to emit a bad object in the first place.

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
 *   2. a bare "next week" reference in the RAW USER TEXT ("อาทิตย์หน้า",
 *      "สัปดาห์หน้า") -> now + 7 days, computed HERE, overriding BOTH model date
 *      slots. It has to override rather than merely suppress relative_weekday:
 *      live reps showed the model sending deadline_iso=null alongside, so
 *      suppression alone loses the reminder to 'no_deadline'. See the note on
 *      resolveBareWeekReference for the failed prompt-layer attempt.
 *   3. a resolvable `relative_weekday` -> date computed HERE from `now`, and it
 *      overrides any `deadline_iso` the model emitted alongside it (the model
 *      often sends both, and only the symbolic slot is trustworthy — see the
 *      note on resolveWeekday)
 *   4. otherwise                     -> `deadline_iso` as before
 *
 * `now` is what the weekday resolution is measured against; it is threaded in
 * from parseReminder so tests can pin it. `userText` is the USER's original
 * message (not the model's response, which is `rawText`) and is likewise
 * threaded in from parseReminder; it is optional and trailing so existing call
 * sites keep working — omitting it simply disables rule 2.
 */
function finalizeResult(rawText, provider, now = new Date(), userText = '') {
  const parsed = extractJson(rawText);
  if (!parsed) throw new ParseError('Model did not return JSON (' + provider + ')', 'bad_json');
  if (parsed.confident === false) throw new ParseError('Model not confident', 'low_confidence');

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const recurring = parsed.recurring === true;
  // Rule 2 before rule 3: the bare-week reading is decided from the user's own
  // wording, which is strictly better evidence than either model date slot.
  const bareWeekDate = recurring ? null : resolveBareWeekReference(now, userText);
  const weekdayDate = recurring || bareWeekDate
    ? null
    : resolveWeekday(now, parsed.relative_weekday, parsed.weekday_qualifier);
  const computedDate = bareWeekDate || weekdayDate;
  const deadlineIso = computedDate
    ? toUtcIso(withTimeOfDay(computedDate, parsed.time_of_day))
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
 * Call OpenRouter (OpenAI-compatible chat/completions) and return the raw
 * response text. ONE client serves BOTH legs — the caller says which by passing
 * `model`, and the two legs differ ONLY in the explicit arguments below:
 *
 *   primary : model = config.openrouter.model,         retries = 0
 *   fallback: model = config.openrouter.fallbackModel, retries = MAX_429_RETRIES
 *
 * The retry policy is a parameter rather than a constant on purpose. The
 * primary deliberately has NO retry loop: it has a whole fallback leg behind
 * it, so burning its budget on a backoff sleep only delays reaching a model
 * that might actually answer. The fallback is the last resort and has nothing
 * behind it, so it retries transient 429s.
 *
 * `timeoutMs` bounds the WHOLE leg — every retry attempt and every backoff
 * sleep between them — not each individual fetch. A single absolute
 * `legDeadline` is computed once, before the loop; each attempt is given only
 * the time still left, and a retry is abandoned outright when what remains
 * cannot cover the sleep plus a minimum attempt. Putting AbortSignal.timeout()
 * inside the loop instead is the bug this replaces: it made the ceiling
 * per-attempt, so a "20s" leg could really run ~76s. With `retries: 0` the loop
 * runs exactly once and the leg deadline and the fetch deadline coincide, which
 * is precisely the primary's old single-fetch behaviour.
 *
 * `disableReasoning` is per-call and defaults to OFF (see below); only the
 * primary ever passes the configured flag.
 */
async function callOpenRouter(
  prompt,
  {
    json = true,
    timeoutMs = PRIMARY_TIMEOUT_MS,
    model = config.openrouter.model,
    retries = 0,
    disableReasoning = false,
  } = {}
) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: json ? 0 : 0.3,
  };
  // The reasoning flag is OPT-IN (OPENROUTER_DISABLE_REASONING), not a
  // constant, because it is not portable across providers.
  //
  // History, so this is not re-litigated:
  //   - nvidia/nemotron-3.5-lightning:free reasons by default; a measured parse
  //     burned 1549 reasoning tokens over 82.7s, far past any sane budget.
  //     `reasoning: { effort: 'low' }` was ignored (1406 tokens, 68.9s); only
  //     `enabled: false` took effect, bringing the same parse to 2.8s. So the
  //     flag was hardcoded on.
  //   - That fix worked and KEPT working (responses came back with
  //     reasoning_tokens: 0) — but by 2026-09-21 the model still failed every
  //     call anyway, for an unrelated reason: the OpenRouter `:free` tier is
  //     queue-starved. Same Thai prompt, measured: 12.9s, 19.4s, 54.9s, and one
  //     call that hung 120s and returned an EMPTY body under HTTP 200. Four
  //     parseReminder reps fell back 4/4, and 2 of those then hard-failed
  //     because the Gemini fallback timed out too. The rest of the `:free` tier
  //     was no better (gemma-4-31b/26b and qwen3.8-27b all 429; liquid/lfm-2.5
  //     and ling-3.0-flash-vl 400; nex-n2.5-mini hallucinated). Hence the swap
  //     to the cheap paid z-ai/glm-5.3-flash — a revert to what ran before.
  //   - The flag itself is now a liability: several providers, glm-5.3-flash
  //     included, answer it with HTTP 400 "Reasoning is mandatory for this
  //     endpoint and cannot be disabled". Sending it unconditionally would fail
  //     100% of primary calls. The current model must send NO reasoning field.
  //   - glm-5.3-flash then failed its own live gate and is NOT the primary any
  //     more: its reasoning is not just undisableable but UNBOUNDED — against
  //     the real 2,982-char prompt the reasoning tokens spiked 204 -> 1024 and
  //     latency went 8.2s / 12.9s / 29.1s. The primary is now
  //     inception/mercury-2.5, which also reasons by default but keeps it
  //     bounded and stable (2035-2460 tokens, 9/9 reps at 4.9-8.5s). So the
  //     flag stays OFF: "reasons by default" is fine, "reasons without a
  //     ceiling" is not.
  //   - The free tier is closed, and widening the budget does not reopen it:
  //     re-measured at a 30s ceiling, nemotron-3.5-lightning:free timed out
  //     5/5 and glm-5.2:free returned HTTP 429 5/5 in under a second.
  //   - the FALLBACK model, qwen/qwen3-30b-a3b-instruct-2507, must never be
  //     sent this flag at all: it is an instruct-only build with no reasoning
  //     in the weights, so there is nothing to disable, and several OpenRouter
  //     endpoints reject the flag with HTTP 400 — which would fail the one leg
  //     that exists to catch a failure. runWithFallback passes false for it.
  if (disableReasoning) body.reasoning = { enabled: false };
  // Both legs rely on this plus SYSTEM_RULES for JSON-ness; neither has a
  // structured-output schema any more. See the RESPONSE_SCHEMA note above.
  if (json) body.response_format = { type: 'json_object' };

  // One deadline for the whole leg, fixed before the first attempt.
  const legDeadline = Date.now() + timeoutMs;

  let res;
  for (let attempt = 0; ; attempt++) {
    const attemptBudget = legDeadline - Date.now();
    if (attemptBudget < MIN_ATTEMPT_MS) {
      throw new ParseError('OpenRouter leg ran out of budget (' + model + ')', 'timeout');
    }
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Key travels in a header so it never lands in a URL or access log.
          Authorization: 'Bearer ' + config.openrouter.apiKey,
          // Optional OpenRouter analytics headers.
          'HTTP-Referer': 'https://github.com/line-reminder-bot',
          'X-Title': 'line-reminder-bot',
        },
        body: JSON.stringify(body),
        // Whatever is left of the leg, never a fresh full budget per attempt.
        // The caller has already clipped `timeoutMs` against the event deadline.
        signal: AbortSignal.timeout(attemptBudget),
      });
    } catch (err) {
      throw new ParseError('OpenRouter request failed: ' + err.name, 'network');
    }

    if (res.status !== 429 || attempt >= retries) break;

    const retryAfterHeader = Number(res.headers.get('retry-after'));
    const rawDelay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
    const delay = Math.min(rawDelay, MAX_RETRY_DELAY_MS);
    // Sleeping and then aborting the retry immediately would burn the rest of
    // the budget for nothing, so give up the retry here and let the 429 stand
    // as the leg's answer.
    if (legDeadline - Date.now() < delay + MIN_ATTEMPT_MS) {
      console.warn(
        '[openrouter] 429 from ' + model + ', but only ' + Math.max(0, legDeadline - Date.now()) +
          'ms of the leg budget is left (needs ' + (delay + MIN_ATTEMPT_MS) +
          'ms to retry) — giving up'
      );
      break;
    }
    console.warn(
      '[openrouter] 429 from ' + model + ', retrying in ' + delay +
        'ms (attempt ' + (attempt + 1) + ')'
    );
    await res.body?.cancel();
    await sleep(delay);
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
 * The configured OpenRouter model (mercury-2.5 by default) is primary and
 * OPENROUTER_FALLBACK_MODEL (qwen3-30b-a3b-instruct-2507 by default) is the
 * fallback — same provider, same key, different model. The fallback trigger is
 * deliberately broad: a hosted model can be rate-limited, deprecated or
 * capacity-starved without notice — the 2026-09-21 `:free`-tier starvation is
 * exactly that — so we cannot assume it only fails as a 429. ANY ParseError out
 * of the primary leg — 429, other 4xx/5xx, network, unusable JSON — re-runs the
 * same prompt through the fallback model. The two exceptions:
 *   - a missing OPENROUTER_API_KEY is a config problem no model can fix, and it
 *     now disables BOTH legs, so it surfaces directly (guard clause below,
 *     outside the try);
 *   - 'low_confidence' is a verdict about the user's text, not a provider
 *     failure — a second opinion would just double the cost of every chit-chat
 *     message, so it surfaces as-is.
 * Throws ParseError on anything the caller should answer with a Thai retry message.
 */
function isKeyMissing(key) {
  return !key || key.startsWith('REPLACE_ME');
}

/**
 * Run one prompt through the primary OpenRouter model, falling back to the
 * fallback OpenRouter model, and hand the raw response text to `finalize`.
 * Both legs go through the same callOpenRouter client, so the response
 * extraction and error mapping cannot drift between them. All three callers
 * share this so the
 * retry/timeout, fallback-trigger and key-guard rules can never drift apart
 * between them. The two legs run SEQUENTIALLY in the failure case, which is why
 * their budgets are sized as a pair — see the note at the top of this file.
 *
 * `deadline` is an absolute ms timestamp for the whole LINE event, threaded in
 * from webhook.js. Each leg gets min(its own budget, what is left) so that two
 * chains on one event cannot add up past the reply token. Omitted means "no
 * event deadline" — the nightly scheduler job, which has no token to race.
 *
 * `finalize` runs inside the try on purpose: an unusable response from OpenRouter
 * is exactly the kind of failure the fallback exists to absorb.
 */
async function runWithFallback({ label, prompt, finalize, json, deadline }) {
  if (isKeyMissing(config.openrouter.apiKey)) {
    throw new ParseError('OPENROUTER_API_KEY is not configured', 'no_api_key');
  }

  const primaryMs = remainingMs(PRIMARY_TIMEOUT_MS, deadline);
  if (primaryMs < MIN_ATTEMPT_MS) {
    throw new ParseError(
      'No event budget left before the primary leg (' + label + ')',
      'deadline_exceeded'
    );
  }

  try {
    const result = finalize(
      await callOpenRouter(prompt, {
        json,
        timeoutMs: primaryMs,
        model: config.openrouter.model,
        // No retries on the primary: the fallback leg IS its retry, and a
        // backoff sleep here would only delay reaching it.
        retries: 0,
        disableReasoning: config.openrouter.disableReasoning,
      }),
      config.openrouter.model
    );
    console.info('[' + label + '] served by openrouter (primary) (' + config.openrouter.model + ')');
    return result;
  } catch (err) {
    const recoverable = err instanceof ParseError && err.code !== 'low_confidence';
    if (!recoverable) throw err;
    // There is deliberately no second key check here. The fallback used to be a
    // different provider with its own GEMINI_API_KEY, so it needed its own
    // "is the fallback even configured?" guard. Both legs now run on
    // OPENROUTER_API_KEY, which the guard at the top of this function has
    // already asserted — a second check could only ever be redundant, and
    // checking the OLD key would have disabled a fallback that no longer
    // depends on it.
    const fallbackMs = remainingMs(FALLBACK_TIMEOUT_MS, deadline);
    if (fallbackMs < MIN_ATTEMPT_MS) {
      console.warn(
        '[' + label + '] openrouter (' + config.openrouter.model + ') failed (' + err.code +
          ') but the event budget is spent — skipping the ' + config.openrouter.fallbackModel + ' fallback'
      );
      throw new ParseError(
        'No event budget left for the fallback leg (' + label + ')',
        'deadline_exceeded'
      );
    }
    console.warn(
      '[' + label + '] openrouter (' + config.openrouter.model + ') failed (' + err.code +
        '), falling back to ' + config.openrouter.fallbackModel + ' (up to ' + fallbackMs + 'ms)'
    );
    const result = finalize(
      await callOpenRouter(prompt, {
        json,
        timeoutMs: fallbackMs,
        model: config.openrouter.fallbackModel,
        // The only leg that retries — it is the last resort, so a transient 429
        // must not end the chain. The budget above covers every attempt and
        // every backoff sleep.
        retries: MAX_429_RETRIES,
        // Never on this leg — the model has no reasoning to disable and the
        // flag can be answered with HTTP 400. See callOpenRouter.
        disableReasoning: false,
      }),
      config.openrouter.fallbackModel
    );
    console.debug(
      '[' + label + '] served by openrouter fallback (' + config.openrouter.fallbackModel + ')'
    );
    return result;
  }
}

async function parseReminder(userText, now = new Date(), { deadline } = {}) {
  return runWithFallback({
    label: 'parseReminder',
    prompt: buildPrompt(userText, now),
    deadline,
    // Closed over `now` so the weekday resolution inside finalizeResult is
    // measured against the same instant the prompt was grounded on, and over
    // `userText` so the bare "อาทิตย์หน้า" / "สัปดาห์หน้า" reading can be decided
    // from the user's original wording — the model's response no longer carries
    // that distinction.
    finalize: (rawText, provider) => finalizeResult(rawText, provider, now, userText),
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
async function summarizeDay(texts, now = new Date(), { deadline } = {}) {
  if (!Array.isArray(texts) || !texts.length) {
    throw new ParseError('summarizeDay called with no messages', 'empty_input');
  }
  return runWithFallback({
    label: 'summarizeDay',
    prompt: buildDayPrompt(texts, now),
    deadline,
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
 * returns it. Same primary/fallback path as parseReminder, so the timeout
 * budgets and retry behaviour cannot drift between the three call sites.
 * Throws ParseError; the caller degrades to a canned ack rather than silence.
 */
async function chatReply(userText, history, now = new Date(), { deadline } = {}) {
  return runWithFallback({
    label: 'chatReply',
    prompt: buildChatPrompt(userText, history, now),
    deadline,
    finalize: finalizeChatReply,
    json: false,
  });
}

// finalizeResult is exported for tests only — it is the pure, network-free core
// of the parse path, so its precedence rules can be checked without an API call.
// SYSTEM_RULES is likewise exported for tests only: the ทุ่ม conversion and the
// recurring classification are enforced in the prompt, not in code, so the only
// thing a unit test can pin is that the corrected wording is still there.
module.exports = {
  parseReminder,
  summarizeDay,
  chatReply,
  ParseError,
  isProviderFailure,
  newEventDeadline,
  finalizeResult,
  SYSTEM_RULES,
};
