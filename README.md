# LINE Reminder Bot

บอทเตือนความจำส่วนตัวบน LINE Official Account — พิมพ์งานเป็นภาษาไทยธรรมดา บอทใช้ Gemini แปลงเป็นงาน + กำหนดส่ง แล้วส่ง Flex ให้กดยืนยัน ก่อนเก็บลง SQLite และเตือนกลับมาเองเมื่อใกล้ถึงกำหนด

## ทำอะไรได้บ้าง

| อินพุต | ผลลัพธ์ |
|---|---|
| ข้อความอิสระ เช่น `ส่งรายงาน JS วันศุกร์นี้บ่าย 3 โมง` | Gemini แยกเป็น `{title, deadline_iso, category}` → Flex ยืนยัน/ยกเลิก → กด "ยืนยัน" แล้วบันทึก |
| `/list` | รายการงานที่ยัง `pending` เรียงตามใกล้ถึงกำหนดก่อน |
| `/done <id>` | ปิดงาน (เฉพาะงานของตัวเอง) |
| `/delete <id>` | ลบงาน (เฉพาะงานของตัวเอง) |
| `/help` | วิธีใช้ |

การเตือนอัตโนมัติ: cron ทำงานทุกนาที ส่ง push 2 จังหวะต่องาน — **ล่วงหน้า 1 วัน** และ **เมื่อถึงกำหนด** (ธงกันเตือนซ้ำเก็บใน DB คนละคอลัมน์)

สรุปประจำวัน: ทุก 06:00 น. (Asia/Bangkok) push ข้อความเดียวรวมงานที่ยังค้างทั้งหมดของแต่ละคน เรียงใกล้ถึงกำหนดก่อน — ใครไม่มีงานค้างจะไม่ได้รับอะไรเลย

## สถาปัตยกรรม

```
src/
  index.js      Express app, /webhook (มี LINE signature middleware) + /health, บูต scheduler
  webhook.js    routing ของ event: command / free text / postback / follow
  gemini.js     เรียก Gemini REST แบบ JSON-only + normalize ผลลัพธ์
  db.js         better-sqlite3: schema + prepared statement (scope ด้วย line_user_id ทุกคำสั่ง)
  scheduler.js  node-cron: sweep ทุกนาที + สรุปประจำวัน 06:00 + ล้าง draft ค้างวันละครั้ง
  messages.js   ข้อความ/Flex ภาษาไทยทั้งหมด
  datetime.js   แปลง/ฟอร์แมตเวลาโซน Asia/Bangkok
  line.js       LINE Messaging API client (reply/push)
```

**ตาราง `reminders`**

| คอลัมน์ | ชนิด | หมายเหตุ |
|---|---|---|
| `id` | INTEGER PK | ใช้อ้างใน `/done` `/delete` |
| `line_user_id` | TEXT | มาจาก `event.source.userId` |
| `title` | TEXT | |
| `deadline_iso` | TEXT | เก็บเป็น **UTC ISO-8601** เสมอ แสดงผลเป็นเวลาไทย |
| `category` | TEXT NULL | |
| `status` | TEXT | `draft` (รอยืนยัน) → `pending` → `done` |
| `day_before_notified` | INTEGER | 0/1 |
| `due_notified` | INTEGER | 0/1 |
| `created_at` | TEXT | |

> รายการที่ยังไม่กดยืนยันจะถูกเก็บเป็น `draft` ก่อน แล้ว postback ถือแค่ `id` — ไม่ต้องยัดข้อมูลลง payload และรอดจากการรีสตาร์ตเซิร์ฟเวอร์ ถ้าไม่ยืนยันภายใน 24 ชม. จะถูกล้างทิ้งอัตโนมัติ

## Environment variables

| ตัวแปร | จำเป็น | ตัวอย่าง / ค่าเริ่มต้น |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | จาก LINE Developers Console → Messaging API |
| `LINE_CHANNEL_SECRET` | ✅ | ใช้ตรวจ `x-line-signature` |
| `GEMINI_API_KEY` | ✅ | จาก Google AI Studio |
| `DATABASE_URL` | — | `file:./dev.db` (รองรับทั้ง `file:` prefix และ path เปล่า) |
| `PORT` | — | `3000` |
| `GEMINI_MODEL` | — | `gemini-3.6-flash` |
| `OPENROUTER_API_KEY` | — | ใช้เป็น fallback เฉพาะตอน Gemini ติด rate limit (429) เท่านั้น; ไม่ใส่ = ปิด fallback |
| `OPENROUTER_MODEL` | — | `stealth/ox-alpha` |
| `TZ_NAME` | — | `Asia/Bangkok` |

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
