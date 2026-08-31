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

**حُدِّثت هذه القائمة في 2026-08-30 بعد تدقيق فعلي للملفات — أربعة من بنودها
الخمسة كانت قد أُنجزت أو أُصلحت والقائمة لم تُحدَّث معها.**

1. ~~**تركيب المسار في worker الموقع**~~ ✅ **مركَّب**: `worker/index.ts:86`
   يحمل `app.route('/api/studio', studioRoutes)`.
2. ~~**تسمية السر في workflows الاستوديو**~~ ✅ **أُصلح**. كانت
   `deploy-studio-*.yml` ترفع السر باسم `HANDOFF_EXCHANGE_SECRET` بينما الكود
   يقرأ `env.STUDIO_HANDOFF_SECRET`، **ولا شيء في الكود يقرأ الاسم القديم**.
   أثر هذا العطل أنه صامت تمامًا: السر يُرفع بنجاح، النشر ينجح، ثم يظل تسجيل
   الدخول يرد `AUTH_NOT_CONFIGURED` بلا خطأ في أي مكان يفسّر السبب. صار
   الاسمان موحّدين على `STUDIO_HANDOFF_SECRET`.
3. ~~**workflows الموقع الرئيسي**~~ ✅ **أُصلح**: `deploy-production.yml` صار
   يمرّر `STUDIO_ALLOWED_DESTINATIONS` كمتغيّر و`STUDIO_HANDOFF_SECRET` كسر،
   وحين لا يوجد أيٌّ منهما يبقى التبادل معطّلًا بصدق.
4. ~~`Env` في `worker/lib/types.ts`~~ ✅ **مضاف**: الحقلان موجودان الآن.
5. **ما يبقى فعلًا**: ضبط الأربعة أسرار في المستودع ثم تشغيل workflows 7
   و8 — التفصيل في «إعداد تسجيل الدخول» أسفل هذا الملف. حتى ذلك الحين
   الاستوديو يعمل كضيف وتسجيل الدخول وحده معطّل.

## ما يراه الزائر فعلًا (تصحيح مهم)

الاستوديو **ليس** محجوبًا خلف تسجيل الدخول: زائر على `/` يحصل على المحرر
كاملًا كضيف، والتحرير يعمل بلا حساب. `AUTH_NOT_CONFIGURED` تظهر **فقط** عند
الضغط على «تسجيل الدخول» (المسار `/auth/login` أو `/auth/callback`)، لأن أول
سطر في كلا المعالجَين يتحقق من `MAIN_SITE_ORIGIN` و`STUDIO_HANDOFF_SECRET`
(`studio/worker/auth/callback.ts:119` و`:166`). فالمشكلة تخص الحساب والمشاريع
المحفوظة، لا استعمال الاستوديو نفسه.

## أي workflow ينشر studio.levonis-iq.com

**`8 - Deploy LIVE Studio levonis-studio-staging` (`deploy-studio-code.yml`)** — وهي التي تنشر على
`levonis-studio-staging`، العامل الذي يخدم النطاق فعلًا. ملفها يقول ذلك في
سطره الأول. و`5 - Deploy levonis-studio (ALTERNATE …)` **لم تُشغَّل ولا مرة**، ولا يوجد
عامل باسم `levonis` على الحساب أصلًا (تحقّقت منه: `wrangler deployments list
--name levonis` يرد `This Worker does not exist on your account`).

نتيجة عملية: **تغييرات الكود** في الاستوديو تصل عبر workflow 8 وحدها.

### لماذا لا تُستعمل workflow 4 لرفع السر

هذا فخّ حقيقي: `4 - Rebuild levonis-studio-staging (LIVE Studio)` ترفع السر إلى العامل الصحيح
(`--env staging`)، لكنها في نفس التشغيل تعيد النشر بـ
`--var APP_ORIGIN:<workers.dev url>` و`--var MAIN_SITE_ORIGIN:$STUDIO_STAGING_MAIN_SITE_ORIGIN`.
وبما أن `levonis-studio-staging` هو العامل الذي يخدم `studio.levonis-iq.com`
فعلًا، فإن تشغيلها يكتب عنوان workers.dev فوق origin النطاق الحقيقي — أي
تُعطِّل التحقّق من روابط العودة على موقع يعمل، لتفعّل تسجيل الدخول. لذلك
**نُقل الإعداد كلّه إلى workflows 7 و8**، وهما اللتان تقرآن vars العامل الحيّة
وتعيدانها كما هي.

## إعداد تسجيل الدخول — الخطوات بالترتيب

كل قيمة أدناه تُضبط كـ**repository secret** في
`Settings → Secrets and variables → Actions → New repository secret`.
لا أرى قيمة أيّ سر ولا أطلبها؛ أنت تضبطها وأنا أتحقّق من النتيجة.

| # | اسم الـ secret | القيمة | لماذا |
|---|---|---|---|
| 1 | `STUDIO_HANDOFF_SECRET` | قيمة عشوائية تولّدها أنت مرّة واحدة، مثلًا `openssl rand -base64 32` | السر المشترك بين العاملَين. يُرفع إلى **كليهما** من نفس الـ secret، فيكون متطابقًا بالضرورة |
| 2 | `STUDIO_ALLOWED_DESTINATIONS` | `https://studio.levonis-iq.com` | قائمة origins المسموح تسليم الجلسة إليها. مطابقة تامّة، بلا wildcards |
| 3 | `STUDIO_PROD_APP_ORIGIN` | `https://studio.levonis-iq.com` | origin الاستوديو نفسه: تحقّق روابط العودة والكوكيز |
| 4 | `STUDIO_PROD_MAIN_SITE_ORIGIN` | `https://levonis-iq.com` | origin الموقع الرئيسي الذي يبادل الاستوديو معه الشيفرة خادمًا-لخادم |

ثم شغّل الاثنتين — الترتيب لا يهم، لكن **كلتيهما لازمة**؛ كلٌّ منهما تضبط طرفها:

1. `7 - Deploy LIVE main site levonis-staging` (اكتب `DEPLOY-CODE`) — تضبط
   `STUDIO_ALLOWED_DESTINATIONS` على `levonis-staging` وترفع السر المشترك إليه.
2. `8 - Deploy LIVE Studio levonis-studio-staging` (اكتب `DEPLOY-STUDIO-CODE`) — تضبط `APP_ORIGIN`
   و`MAIN_SITE_ORIGIN` على `levonis-studio-staging` وترفع السر المشترك إليه.

**إن ضبطت السر ولم تُعِد التشغيل، لن يتغيّر شيء**: الأسرار تُرفع أثناء النشر،
لا لحظة حفظها في GitHub. وإن تركت أيّ واحد من الأربعة فارغًا، تبقى الخطوة
معطّلة **بصدق** (503 برسالة تسمّي المفقود) بدل أن تفشل بصمت.

### كيف يُتحقَّق أن الأمر نجح فعلًا

بعد التشغيلين، على `levonis-iq.com` وأنت مسجّل الدخول:
`POST /api/studio/handoff` يجب أن يردّ `200` مع `redirect_url`. ما دام أيّ
طرف ناقصًا يردّ `503` ويسمّي المتغيّر الناقص بالاسم — وهذا هو الفرق عن العطل
القديم، الذي كان يردّ `AUTH_NOT_CONFIGURED` بلا أيّ أثر يفسّر السبب.
