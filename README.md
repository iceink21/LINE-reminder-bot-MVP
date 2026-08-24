# LINE Reminder Bot

บอทเตือนความจำส่วนตัวบน LINE Official Account — พิมพ์อะไรมาก็ได้เป็นภาษาไทยธรรมดา บอทเก็บข้อความไว้ก่อน แล้ว **ตอนเที่ยงคืน** ค่อยใช้ Ox Alpha (มี Gemini เป็น fallback) คัดว่าอันไหนเป็นงาน + กำหนดส่ง (บันทึกลง SQLite เลย ไม่ต้องกดยืนยัน) อันไหนเป็นเรื่องคุยเล่น (สรุปเป็นย่อหน้าเดียว) แล้วส่งกลับเป็น push เดียวต่อคนต่อวัน

## ทำอะไรได้บ้าง

| อินพุต | ผลลัพธ์ |
|---|---|
| ข้อความอิสระ เช่น `ส่งรายงาน JS วันศุกร์นี้บ่าย 3 โมง` | ตอบรับทราบทันที (reply ฟรี ไม่กินโควตา) แล้วพักไว้ใน `inbox_messages` → เที่ยงคืนคัดเป็นงาน `pending` หรือเข้าถังคุยเล่น |
| `/list` | รายการงานที่ยัง `pending` เรียงตามใกล้ถึงกำหนดก่อน |
| `/done <id>` | ปิดงาน (เฉพาะงานของตัวเอง) |
| `/delete <id>` | ลบงาน (เฉพาะงานของตัวเอง) |
| `/help` | วิธีใช้ |

การเตือนอัตโนมัติ: cron ทำงานทุกนาที ส่ง push 3 จังหวะต่องาน — **ล่วงหน้า 1 วัน**, **ล่วงหน้า 1 ชั่วโมง** และ **เมื่อถึงกำหนด** (ธงกันเตือนซ้ำเก็บใน DB คนละคอลัมน์)

สรุปประจำวัน: ทุก 06:00 น. (Asia/Bangkok) push ข้อความเดียวรวมงานที่ยังค้างทั้งหมดของแต่ละคน เรียงใกล้ถึงกำหนดก่อน — ใครไม่มีงานค้างจะไม่ได้รับอะไรเลย

### รอบคัดข้อความเที่ยงคืน (00:00 Asia/Bangkok)

1. ไล่ทีละคนที่มีแถวใน `inbox_messages` ที่ยัง `processed_at IS NULL`
2. แต่ละแถวส่งเข้า `parseReminder(text, created_at)` — **ใช้เวลาที่ส่งข้อความจริงเป็นจุดอ้างอิง** ไม่ใช่เวลาเที่ยงคืน วันสัมพัทธ์อย่าง "พรุ่งนี้"/"ศุกร์นี้" จะได้ตรง
3. ผ่าน → insert ลง `reminders` เป็น `pending` เลย; ไม่ผ่าน (รวมถึง `low_confidence`) → เข้าถังคุยเล่น
4. ถังคุยเล่นที่ไม่ว่างส่งเข้า `summarizeChitChat()` ได้ย่อหน้าสรุปภาษาไทยสั้น ๆ
5. รวมทั้งสองส่วนเป็น **push เดียวต่อคน** แล้วประทับ `processed_at` ให้ทุกแถวที่คัดแล้ว

> แถวถูกประทับ `processed_at` แม้ push จะล้มเหลว — ถ้าไม่ทำ รอบถัดไปจะ parse ซ้ำแล้วสร้างงานซ้ำทั้งชุด ซึ่งแย่กว่าสรุปหายไปหนึ่งวัน

## โควตา push รายเดือน

LINE แพลนฟรีจำกัด push/multicast/broadcast ที่ **200 ข้อความ/เดือน** (ส่วน reply ผ่าน `replyToken` ไม่จำกัดและไม่ถูกนับ) — `push()` ใน `line.js` เลยนับทุกครั้งที่ส่งสำเร็จลงตาราง `push_log` โดยคีย์เดือนเป็น `YYYY-MM` ตามปฏิทินไทย

เมื่อยอดแตะ `PUSH_MONTHLY_LIMIT × PUSH_WARN_RATIO` จะยิงเตือน **ครั้งเดียวต่อเดือน** ไปหา `ADMIN_LINE_USER_ID` (ถ้าไม่ได้ตั้งไว้ = แค่ `console.warn` ไม่ throw) ธง `warned` กันไม่ให้เตือนซ้ำ

เช็กยอดปัจจุบัน:

```bash
curl http://localhost:3000/usage   # {"month":"2026-08","count":12,"limit":200}
```

## สถาปัตยกรรม

```
src/
  index.js      Express app, /webhook (มี LINE signature middleware) + /health + /usage, บูต scheduler
  webhook.js    routing ของ event: command / free text (พักลง inbox) / follow
  gemini.js     เรียก Ox Alpha (หลัก) / Gemini (fallback) — parseReminder + summarizeChitChat
  db.js         better-sqlite3: schema + prepared statement (scope ด้วย line_user_id ทุกคำสั่ง)
  scheduler.js  node-cron: sweep ทุกนาที + คัดข้อความเที่ยงคืน 00:00 + สรุปประจำวัน 06:00
  messages.js   ข้อความภาษาไทยทั้งหมด
  datetime.js   แปลง/ฟอร์แมตเวลาโซน Asia/Bangkok + คีย์เดือนสำหรับโควตา push
  line.js       LINE Messaging API client (reply ฟรี / push ที่นับโควตา)
```

**ตาราง `reminders`**

| คอลัมน์ | ชนิด | หมายเหตุ |
|---|---|---|
| `id` | INTEGER PK | ใช้อ้างใน `/done` `/delete` |
| `line_user_id` | TEXT | มาจาก `event.source.userId` |
| `title` | TEXT | |
| `deadline_iso` | TEXT | เก็บเป็น **UTC ISO-8601** เสมอ แสดงผลเป็นเวลาไทย |
| `category` | TEXT NULL | |
| `status` | TEXT | `pending` → `done` (รอบเที่ยงคืน insert เป็น `pending` ตรง ๆ ไม่มีสถานะรอยืนยันแล้ว) |
| `day_before_notified` | INTEGER | 0/1 |
| `hour_before_notified` | INTEGER | 0/1 |
| `due_notified` | INTEGER | 0/1 |
| `created_at` | TEXT | |

**ตาราง `inbox_messages`** — ข้อความดิบที่รอรอบคัดเที่ยงคืน

| คอลัมน์ | ชนิด | หมายเหตุ |
|---|---|---|
| `id` | INTEGER PK | |
| `line_user_id` | TEXT | มาจาก `event.source.userId` |
| `text` | TEXT | ข้อความดิบตามที่ผู้ใช้พิมพ์ |
| `created_at` | TEXT | **UTC ISO-8601** เหมือน `reminders.created_at` — รอบเที่ยงคืนใช้ค่านี้เป็นจุดอ้างอิงเวลาสัมพัทธ์ |
| `processed_at` | TEXT NULL | `NULL` = ยังไม่ถูกคัด |

**ตาราง `push_log`** — ตัวนับโควตา push รายเดือน

| คอลัมน์ | ชนิด | หมายเหตุ |
|---|---|---|
| `month` | TEXT PK | `YYYY-MM` ตามปฏิทิน Asia/Bangkok |
| `count` | INTEGER | นับเฉพาะ push ที่ LINE รับแล้ว (reply ไม่นับ) |
| `warned` | INTEGER | 0/1 — ธงกันเตือนโควตาซ้ำในเดือนเดียวกัน |

## Environment variables

| ตัวแปร | จำเป็น | ตัวอย่าง / ค่าเริ่มต้น |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | จาก LINE Developers Console → Messaging API |
| `LINE_CHANNEL_SECRET` | ✅ | ใช้ตรวจ `x-line-signature` |
| `OPENROUTER_API_KEY` | ✅ | ตัวแยกวิเคราะห์หลัก (Ox Alpha) จาก openrouter.ai |
| `DATABASE_URL` | — | `file:./dev.db` (รองรับทั้ง `file:` prefix และ path เปล่า) |
| `PORT` | — | `3000` |
| `OPENROUTER_MODEL` | — | `stealth/ox-alpha` |
| `GEMINI_API_KEY` | — | จาก Google AI Studio; ใช้เป็น fallback ทุกครั้งที่ Ox Alpha พลาด (429/4xx/5xx/เน็ตหลุด/JSON เสีย); ไม่ใส่ = ปิด fallback |
| `GEMINI_MODEL` | — | `gemini-3.6-flash` |
| `TZ_NAME` | — | `Asia/Bangkok` |
| `PUSH_MONTHLY_LIMIT` | — | `200` (โควตา push/multicast/broadcast ของแพลนฟรี — reply ไม่นับ) |
| `PUSH_WARN_RATIO` | — | `0.9` (แตะ 90% ของโควตาแล้วเตือนหนึ่งครั้ง) |
| `ADMIN_LINE_USER_ID` | — | ปลายทางของข้อความเตือนโควตา; ไม่ใส่ = แค่ log ไว้ ไม่กระทบการทำงานอื่น |

`.env` ไม่ถูก commit (มีอยู่ใน `.gitignore` แล้ว) — อย่าใส่ค่าจริงลง repo

## รันในเครื่อง

```bash
npm install
npm run dev          # nodemon
# หรือ
npm start
```

เช็กว่าขึ้นแล้ว:

```bash
curl http://localhost:3000/health   # {"status":"ok"}
```

LINE ต้องยิง webhook เข้ามาได้ ตอน dev ใช้ ngrok เปิด tunnel:

```bash
ngrok http 3000
# เอา URL ที่ได้ไปตั้งเป็น Webhook URL: https://xxxx.ngrok-free.app/webhook
```

> ⚠️ `better-sqlite3` เป็น native module ที่ **ต้องการ Node ≥22** (`package.json` บังคับด้วย `engines.node`) — เวอร์ชันต่ำกว่านี้จะติดตั้งได้แบบ silent-fail (npm แค่เตือน ไม่ error) แล้วไปพังตอนรันจริงแบบไม่มี stack trace (เจอเคสนี้ตอน deploy จริงบน Railway ที่ auto-detect เลือก Node ผิดเวอร์ชัน) ทดสอบผ่านบน Node 22/26 ด้วย better-sqlite3 v13

## Deploy ขึ้น Railway

**สำคัญ:** repo นี้มี `Dockerfile` ที่ pin Node 22 ไว้ตรงๆ เพื่อเลี่ยงปัญหาข้างบน — ต้องตั้งให้ Railway ใช้ Dockerfile แทนการ auto-detect (Nixpacks) ไม่งั้นจะกลับไปเจอ segfault เดิม

1. **push โค้ดขึ้น GitHub** (ไม่ต้องกลัว `.env` หลุด — ถูก ignore แล้ว)
   ```bash
   git add . && git commit -m "LINE reminder bot MVP" && git push
   ```
2. **สร้าง project** ที่ [railway.app](https://railway.app) → *New Project* → *Deploy from GitHub repo* → เลือก repo นี้
   จากนั้นเข้า **Settings → Build** → เปลี่ยน **Builder** จาก Nixpacks เป็น **Dockerfile** (ระบุ path `Dockerfile` ที่ root ของ repo)
3. **ตั้ง Variables** (แท็บ *Variables* ของ service):
   ```
   LINE_CHANNEL_ACCESS_TOKEN=...
   LINE_CHANNEL_SECRET=...
   OPENROUTER_API_KEY=...
   GEMINI_API_KEY=...
   DATABASE_URL=file:/data/dev.db
   TZ_NAME=Asia/Bangkok
   ```
   > **ไม่ต้องตั้ง `PORT` เอง** — Railway inject ให้อัตโนมัติ
4. **เพิ่ม Volume (สำคัญมาก)**: *Settings → Volumes → Add Volume*, mount path `/data`
   ถ้าไม่ทำ ไฟล์ SQLite จะหายทุกครั้งที่ redeploy — ต้องตั้ง `DATABASE_URL` ให้ชี้ในโวลุ่มตามข้อ 3
5. **เปิด public domain**: *Settings → Networking → Generate Domain* จะได้ URL แบบ
   `https://<ชื่อ>.up.railway.app`
6. **เช็ก health**:
   ```bash
   curl https://<ชื่อ>.up.railway.app/health
   ```
7. **กลับไปตั้ง Webhook URL ที่ LINE Developers Console**:
   - เข้า [developers.line.biz](https://developers.line.biz) → เลือก Provider → เลือก Channel (Messaging API)
   - แท็บ **Messaging API** → หัวข้อ **Webhook settings**
   - **Webhook URL** = `https://<ชื่อ>.up.railway.app/webhook` → กด **Update**
   - เปิดสวิตช์ **Use webhook** → กด **Verify** ต้องขึ้น `Success`
   - เลื่อนลงหัวข้อ **LINE Official Account features** → ปิด **Auto-reply messages** และ **Greeting messages** (ไม่งั้นข้อความตอบอัตโนมัติจะทับบอท)
8. แอดบอทเป็นเพื่อนจาก QR ในแท็บ Messaging API แล้วลองพิมพ์ `ส่งรายงาน JS วันศุกร์นี้บ่าย 3 โมง`

## หมายเหตุด้านความปลอดภัย

- ลายเซ็น webhook ตรวจด้วย middleware ของ `@line/bot-sdk` (ไม่ได้เขียน HMAC เอง) — ลายเซ็นผิด/ไม่มี ตอบ `401`
- ทุก query ที่แตะข้อมูลผู้ใช้ scope ด้วย `line_user_id` ทั้ง read และ write → `/done` `/delete` ข้ามคนอื่นไม่ได้
- GEMINI API key ส่งผ่าน header `x-goog-api-key` ไม่ใช่ query string เพื่อไม่ให้ติดไปกับ access log
- ไม่มีการ log ค่า secret หรือ body ของ error จากฝั่ง Gemini
- `inbox_messages` ก็ scope ด้วย `line_user_id` เหมือนกัน — รอบคัดเที่ยงคืนอ่าน/ประทับเฉพาะแถวของผู้ใช้คนนั้น
- `/usage` เปิดอ่านได้โดยไม่ต้อง auth เหมือน `/health` — คืนแค่ตัวเลข `{month, count, limit}` ไม่มี user id หรือเนื้อหาข้อความ
