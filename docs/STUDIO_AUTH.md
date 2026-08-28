# LEVO Studio — ربط الحساب وتسجيل الدخول (Account linking & sign-in)

> **Draft — pending owner review.** يوثق هذا الملف التصميم **المنفذ فعلًا** في
> الكود (شريحة S2 + مسار worker الموقع)، مع قسم صريح لما لم يُوصَّل بعد.
> المرجع المعماري: `docs/STUDIO_PLAN.md` القرار 3؛ تعليمات المالك بند 3.

## المبدأ

حساب واحد فقط — حساب LEVONIS الأساسي. لا تسجيل مستقل في الاستوديو، ولا ثقة
بأي هوية يرسلها المتصفح (البريد، ترويسات `oai-*` القديمة). الهوية المعتمدة هي
`users.id` الداخلي الثابت، وتنتقل إلى الاستوديو عبر **تبادل رمز أحادي
الاستخدام خادم-لخادم**.

لماذا هذا التصميم: كوكي `levonis_session` مقيد بمضيف الموقع الرئيسي ولا يصل
إلى `studio.levonis-iq.com`، وتوسيعه إلى `Domain=.levonis-iq.com` محظور
(متاجر المجتمع الفرعية موجودة). التبادل خادم-لخادم يبقي كل مسارات
`/auth/*` same-origin على مضيف الاستوديو فلا يمس COOP/COEP ولا
`connect-src 'self'`.

## التدفق (كما هو منفذ)

```
Studio (متصفح)                     Main worker                    Studio worker
--------------                     -----------                    -------------
GET /auth/login?return_to=/x  ────────────────────────────────►  يولّد state (32B)
                                                                 كوكي handoff (host-scoped,
                                                                 HttpOnly, Max-Age 600s,
                                                                 يحمل state + return path)
        302 ◄────────────────────────────────────────────────────┘
GET main/api/studio/handoff/start?dest=<origin>&state=…
   │  (جلسة levonis_session + rate limit 30/5min)
   │  غير مسجل؟ 302 إلى /auth?next=… ثم العودة لنفس المسار
   │  مسجل: يسكّ code (32 بايت عشوائي) — يُخزن SHA-256 فقط،
   │  مربوطًا بـ user_id + dest + TTL 60 ثانية + consumed_at
   ▼
302 إلى <dest>/auth/callback?code=…&state=…
                                                                 يتحقق state ضد كوكيه
                                                                 (مقارنة ثابتة الزمن)
                              POST /api/studio/handoff/redeem ◄──┘
                              Authorization: Bearer <سر مشترك>
                              استهلاك ذري (UPDATE مشروط) — الإعادة
                              والمنتهي والوجهة الخطأ = خطأ موحّد واحد
                              الرد: {user_id, display_name, locale} فقط
                                                                 يسكّ جلسة الاستوديو
                                                                 (صف D1 + كوكي host-scoped)
                                                                 302 إلى return path
                                                                 (الرابط يُنظَّف من code)
```

## نقاط التنفيذ

| المكوّن | الملف |
|---|---|
| مسارات handoff في worker الموقع (`start` / `handoff` / `redeem` / `introspect`) | `worker/routes/studio.ts` |
| جدول الرموز (تجزئة SHA-256، dest، expires_at، consumed_at) | `migrations/0012_studio_handoff.sql` |
| مسارات `/auth/*` في worker الاستوديو (login/callback/logout/me + تحويل المسارات القديمة) | `studio/worker/auth/callback.ts` |
| جلسات الاستوديو + تجريد الترويسات + فحص الحيوية | `studio/worker/auth/session.ts` |
| قارئ الهوية في تطبيق SSR (بديل `chatgpt-auth.ts` المحذوف) | `studio/app/studio-auth.ts` |
| اختبارات سلوكية (رمز منتهٍ/مكرر، وجهة غير مسموحة، ترويسات مزورة، state خاطئ) | `studio/tests/auth-handoff.test.mjs` |

## خصائص الأمان المنفذة

- **رمز أحادي الاستخدام:** 32 بايت عشوائي؛ يُخزن **مُجزأً SHA-256** فقط؛
  صلاحية 60 ثانية؛ الاستهلاك ذري (`UPDATE … WHERE consumed_at IS NULL`)؛
  كل أنماط الفشل ترجع رسالة موحدة واحدة (لا oracle).
- **الوجهة:** مطابقة origin **حرفية** ضد allowlist (`STUDIO_ALLOWED_DESTINATIONS`)
  — لا بادئات ولا wildcard؛ والاسترداد يعيد فحص dest.
- **state ضد login-CSRF:** يولده worker الاستوديو ويخزنه في كوكي host-scoped
  قصير العمر؛ الـ callback يرفض أي state لا يطابق كوكيه (مقارنة ثابتة الزمن)
  — رابط handoff مزور لا يمكنه معرفة كوكي الضحية.
- **جلسة الاستوديو:** كوكي `levo_studio_session` HttpOnly Secure SameSite=Lax
  **مقيد بالمضيف** (بلا `Domain` إطلاقًا)؛ الرمز مُجزأ في D1؛ تسكّ عند الدخول
  فقط (لا session fixation)؛ 14 يومًا؛ تسجيل الدخول بهوية جديدة على نفس
  المتصفح يهدم صف الجلسة السابقة أولًا.
- **تنظيف الرابط:** `/auth/callback` لا يصيّر صفحة أبدًا — 302 فوري إلى return
  path نسبي مُتحقق (`safeRelativeReturnPath`)، والرمز لا يُسجل في اللوغات؛
  طلبات prefetch/prerender ترد 204 ولا تستهلك الرمز.
- **دفاع في العمق:** worker الاستوديو يجرّد **كل** ترويسات `oai-*` و`x-levo-*`
  الواردة قبل أي معالجة؛ هوية SSR تمر داخليًا فقط عبر `x-levo-user` بعد تحقق
  الجلسة.
- **الخروج وتبديل الحساب:** `/auth/logout` يحذف صف الجلسة من D1 (لا إخفاء
  قائمة)؛ POST بفحص Origin وGET بفحص `Sec-Fetch-Site` ضد الإجبار عبر المواقع.
  طبقة العميل (S5) تلغي الرفع المؤجل عند تبديل الحساب.
- **إبطال من الموقع الرئيسي:** `POST /api/studio/handoff/introspect`
  (خادم-لخادم) يجيب هل ما زال للمستخدم أي جلسة حية على الموقع؛ القيمة
  'unknown' لا تُعامل أبدًا كـ'active'.
- **الحد الأدنى من البيانات:** الاسترداد يعيد `{user_id, display_name, locale}`
  فقط — لا بريد ولا هاتف ولا أدوار ولا KYC/محفظة. قاعدة الاستوديو لا تحوي
  جدول مستخدمين ولا تجري أي join على جداول المتجر.
- **الضيف:** التحرير بلا دخول يبقى كاملًا؛ غياب الإعداد يعطي 503 صادقًا
  (`AUTH_NOT_CONFIGURED`) لا فشلًا صامتًا ولا نجاحًا مزيفًا.
- لا اشتراك PLUS/PRO مطلوب للسلايسر أو للحفظ — هذه المرحلة لا تضيف أي قيد
  عضوية.

## الإعداد (per environment)

| أين | الاسم | الدور |
|---|---|---|
| worker الموقع (vars/secrets) | `STUDIO_ALLOWED_DESTINATIONS` | origins الوجهات المسموحة، مفصولة بفواصل (مثال: `https://studio.levonis-iq.com`) |
| worker الموقع (secret) | `STUDIO_HANDOFF_SECRET` | السر المشترك الذي يقدمه worker الاستوديو في redeem/introspect |
| worker الاستوديو (vars) | `MAIN_SITE_ORIGIN` | origin موقع LEVONIS الموثوق (لا يُشتق من ترويسات الطلب أبدًا) |
| worker الاستوديو (secret) | `STUDIO_HANDOFF_SECRET` | نفس السر المشترك |

غياب أي قيمة = الدخول معطل بصدق (503) والتحرير كضيف يعمل.

## ما لم يُوصَّل بعد (صادقًا)

1. **تركيب المسار في worker الموقع:** `worker/routes/studio.ts` موجود لكنه
   **غير مركب** بعد في `worker/index.ts`
   (`app.route('/api/studio', studioRoutes)`) — الملف محجوز للمنسق.
2. **تسمية السر في workflows الاستوديو:** ترفع
   `deploy-studio-*.yml` السر باسم `HANDOFF_EXCHANGE_SECRET` بينما الكود يقرأ
   `env.STUDIO_HANDOFF_SECRET` — يجب توحيد الاسم قبل أول اختبار على staging.
3. **workflows الموقع الرئيسي** لا تضبط بعد `STUDIO_HANDOFF_SECRET` ولا
   `STUDIO_ALLOWED_DESTINATIONS` على worker المتجر.
4. `Env` في `worker/lib/types.ts` لا يضم المتغيرين بعد (الملف محجوز) —
   المسار يتعامل معهما كاختياريين ويرد 503 حتى إضافتهما.
5. اختبار T2 على staging HTTPS الحقيقي (دخول + عودة + `crossOriginIsolated`)
   ينتظر اكتمال 1–3.
