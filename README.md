# Dlleni — Lead Feedback Loop (Meta Conversions API)

الليدز بتيجي من إنستانت فورمز ميتا → تظهر في داشبورد → فريق المبيعات يحدد جودتها → الإشارة ترجع لميتا عبر Conversions API عشان الخوارزمية تدوّر على ناس **بتشتري**، مش ناس **بتملّي فورم**.

```
Meta Lead Form ──► /api/sync ──► Supabase ──► Dashboard ──► /api/feedback ──► CAPI ──► Meta
   كل 10 دقايق                    (الليدز)     (البروكر)        (الحدث)      (بتتعلّم)
```

---

## خريطة الحالات → أحداث ميتا

| الحالة في الداشبورد | الحدث اللي يروح لميتا | إشارة |
|---|---|---|
| جديد | *(مفيش — ميتا بتبعت `Lead` لوحدها)* | — |
| اتكلمنا معاه | `Contacted` | محايدة |
| **مؤهّل** | **`Qualified`** | ➕ |
| حجز معاينة | `Schedule` | ➕ |
| عاين | `Visited` | ➕ |
| **باع** | **`Purchase`** + قيمة الصفقة | ➕➕ |
| زبالة / رقم غلط | `Disqualified` | ➖ |
| مش مهتم | `Disqualified` | ➖ |

التعديل في `lib/stages.ts` — سطر واحد لكل حالة.

---

## التنصيب

### ١. متغيرات البيئة

انسخ `.env.example` لـ `.env.local` واملاه:

| المتغير | القيمة |
|---|---|
| `META_ACCESS_TOKEN` | توكن System User (نفس اللي في MCP) |
| `META_PAGE_ID` | `109652897854140` — Dlleni - دلني |
| `META_DATASET_ID` | `2918655091623838` — بكسل «dlleni p» |
| `SUPABASE_URL` | `https://yrmgwbufaaiaioqvabon.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | من Supabase → Settings → API |
| `APP_PASSWORD` | الباسورد اللي الفريق هيدخل بيه |
| `CRON_SECRET` | أي نص عشوائي طويل |
| `META_TEST_EVENT_CODE` | **للتجربة بس** — شيله في الإنتاج |

> ⚠️ **الصلاحيات المطلوبة في التوكن**: `leads_retrieval` · `pages_show_list` · `pages_manage_ads` · `ads_management` · `ads_read` · `business_management`

### ٢. قاعدة البيانات

المايجريشن **اتطبّق بالفعل** على مشروع `Conversions-API`. لو محتاج تعيده:

```bash
psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql
```

### ٣. التشغيل

```bash
npm install
npm run dev      # http://localhost:3000
```

### ٤. الديبلوي

```bash
vercel --prod
```

الـ crons في `vercel.json` بتشتغل لوحدها:
- `/api/sync` كل 10 دقايق
- `/api/capi/replay` كل ساعة

---

## أول تشغيل

1. افتح الداشبورد واضغط **«سحب كامل»** — هيجيب كل الليدز التاريخية (160 ليد تقريباً)
2. حط `META_TEST_EVENT_CODE` وغيّر حالة ليد واحد
3. Events Manager → Test Events → لازم تشوف الحدث
4. **شيل** `META_TEST_EVENT_CODE` — الأحداث التجريبية **مش** بتتحسب في التحسين
5. سيب الفريق يشتغل عادي أسبوعين

---

## بعد ما الداتا تتجمّع

Meta بتقول الـ **Conversion Leads** محتاج **200+ ليد/شهر**. لما توصل:

**Ads Manager → Ad set → Performance goal → Maximise number of conversion leads** → اختار **`Qualified`** كحدث التحسين.

من الوقت ده ميتا بتوقف عن استهداف اللي بيملوا الفورم، وتبدأ تستهدف اللي **بيتأهلوا**.

> 💡 وكمان اعمل **Lookalike من اللي `won`** مش من كل الليدز — ده أقوى جمهور هيطلع من الداتا دي.

---

## نقط مهمة اتعالجت في الكود

**١. توكن البيدج.** `/{page-id}/leadgen_forms` و `/{form-id}/leads` **بترفض** توكن الـ System User برسالة `(#190) This method must be called with a Page Access Token`. `lib/meta.ts` بيبدّل لتوكن البيدج أوتوماتيك ويكاشه.

**٢. `lead_id` مش بيتهَش.** ده مُعرّف من ميتا نفسها — لو عملتله SHA-256 مش هيطابق. التليفون والإيميل بس اللي بيتهشوا.

**٣. Dedup.** كل حدث معاه `event_id = "{lead_id}:{event_name}"`، فالضغط المتكرر أو الـ replay مش بينفخ الأرقام.

**٤. مفيش حدث بيضيع.** الحدث بيتسجل في `capi_events` **قبل** ما يتبعت. لو الشبكة وقعت، الكرون بتاع الساعة بيعيده (٦ محاولات).

**٥. السحب مش بيمسح الفيدباك.** `ignoreDuplicates` — الليد الموجود مبيتلمسش، فحالة البروكر بتفضل زي ما هي.

**٦. أرقام مصر.** `01xxxxxxxxx` و `+20` و `002` كلها بتترجم لـ `20xxxxxxxxxx` قبل الهَش — ده اللي بيرفع Event Match Quality.

---

## الملفات

```
app/
  page.tsx                  الداشبورد (RTL)
  api/sync/                 سحب الليدز من ميتا
  api/feedback/             تغيير الحالة → CAPI
  api/leads/                قراءة الليدز + تقرير الجودة
  api/capi/replay/          إعادة إرسال الفاشل
lib/
  meta.ts                   Graph API + توكن البيدج
  capi.ts                   بناء وإرسال الأحداث
  stages.ts                 خريطة الحالات ← عدّل هنا
  supabase.ts / auth.ts
supabase/migrations/        السكيما
```

## API

| Endpoint | الوظيفة |
|---|---|
| `GET /api/sync` | سحب الجديد · `?full=1` لسحب كامل |
| `GET /api/leads` | قراءة · `?status=` `?q=` |
| `POST /api/feedback` | `{lead_id, status, notes?, deal_value?}` |
| `GET /api/capi/replay` | إعادة المحاولات الفاشلة |

الكل محمي بـ `x-app-password` أو `Authorization: Bearer $CRON_SECRET`.
