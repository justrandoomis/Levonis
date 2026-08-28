# LEVO Studio — تقرير التكامل والتحقق (Integration & Verification Report)

تاريخ التشغيل: 2026-08-28 — فرع `claude/new-session-2hq4ci`، جلسة تكامل أسطول Studio (بعد S1–S8).
كل الأرقام أدناه من تشغيل فعلي محلي في هذه الجلسة؛ ما لم يُشغَّل مذكور صراحة في «غير المغطى».

---

## 1) أعمال التكامل المنفذة في هذه الجلسة

| # | التغيير | الملفات |
|---|---|---|
| 1 | تركيب مسارات handoff في worker المتجر: `app.route('/api/studio', studioRoutes)` | `worker/index.ts` |
| 2 | إضافة `STUDIO_HANDOFF_SECRET?` و`STUDIO_ALLOWED_DESTINATIONS?` إلى `Env` (تنظيف cast محلي في route) | `worker/lib/types.ts` |
| 3 | ساق الاستئناف لغير المسجلين: `finishAuth` ينفذ `window.location.assign` لمسارات `/api/studio/handoff/start` بدل تنقل react-router (وإلا سقط المستخدم على SPA catch-all) | `src/pages/Auth.tsx` |
| 4 | إصلاح سكربتات `studio/package.json` المكسورة بعد حذف أغلفة Sites: حذف `install:ci`، `lint` مباشر، `db:generate` مباشر | `studio/package.json` |
| 5 | ربط cron التنظيف: معالج `scheduled` في مدخل worker الاستوديو + `"crons": ["0 * * * *"]` في الكتلتين (كان مؤجلًا حتى وجود المعالج — الآن موجود) | `studio/worker/index.ts`, `studio/wrangler.jsonc` |
| 6 | استثناء `studio/` من tsc الجذري (workspace مستقل بإعداداته) واستثناء `mobile/` من tsc الاستوديو (workspace منفصل بلا node_modules) | `tsconfig.json`, `studio/tsconfig.json` |
| 7 | **تركيب طبقة S5 في المحرر** (كانت مبنية ومختبرة لكن غير موصولة): `useProjectPersistence` + `ProjectsPanel` داخل `slicer-client.tsx` — التقاط snapshot من المحرك عبر intent `persist`، autosave عبر `markDirty`، إنشاء/فتح مشاريع الحساب، ربط/فك ربط المشروع البعيد، تمرير `user.id` من `page.tsx` | `studio/app/slicer-client.tsx`, `studio/app/page.tsx` |
| 8 | تحديث 5 اختبارات قديمة في `editor-capabilities.test.mjs` كانت تؤكد سلوك المونوليث القديم المخالف للتفويض (روابط APK نشطة، `checkForNativeUpdate` في الويب، نص «لا حد للحجم») — أصبحت تؤكد السلوك الجديد في ملفاته المالكة، مع تأكيدات سلبية لما أزاله التفويض (بند 12) | `studio/tests/editor-capabilities.test.mjs` |

لا حذف أو إضعاف لأي تأكيد اختبار: التأكيدات المنقولة تغطي نفس السلوك في موقعه الجديد، والمُزال (APK/تحديث أصلي) صار تأكيد **غياب** كما يفرضه البرومت.

## 2) البوابات الثابتة (typecheck / build / tests)

| البوابة | الأمر | النتيجة |
|---|---|---|
| Studio typecheck | `cd studio && npx tsc --noEmit` | **0 أخطاء** |
| Studio tests | `cd studio && node --test tests/*.test.mjs` | **109 نجاح / 0 فشل / 1 تخطٍ** (تخطي APK الموقّع — أصل لا يُبنى في هذه الجلسة، مسمى بصدق) |
| Studio build | `cd studio && npm run build` (build-verified.sh / vinext) | **أخضر** (client + ssr) |
| Root typecheck | `npm run check` (tsc + worker tsc) | **0 أخطاء** |
| Root unit tests | `npm run test:unit` | **142 / 142** (يشمل اختبار عزل المتجر الجديد `tests/store-isolation.test.ts`) |
| Root build | `npm run build` (vite) | **أخضر** |
| Studio eslint | `cd studio && npm run lint` | يعمل الآن (كان مكسورًا)؛ ما أضفته نظيف — تبقى **7 أخطاء قديمة** من قواعد react-hooks الصارمة في كود الأسطول (انظر §7) |

## 3) انحدار المتجر (Store regression) — wrangler dev محلي :8787

Migrations محلية مطبقة حتى `0012_studio_handoff.sql`.

| المجموعة | النتيجة |
|---|---|
| `scripts/api-tests.mjs` | **60 / 0** |
| `scripts/api-tests-v2.mjs` | **37 / 0** |
| `scripts/api-tests-v3.mjs` | **114 / 0 / 10 محجوبة** (المحجوبات هي قرارات مالك/أسرار غير مضبوطة — مسماة بصدق في خرج السكربت) |

### endpoint الـ handoff الجديد (curl):
- `POST /api/studio/handoff` بلا جلسة → **401** ✓
- `GET /handoff/start` بلا جلسة → **302** إلى `/auth?next=<resume>` ✓
- بجلسة حية: mint ينجح، `redirect_url` إلى `<dest>/auth/callback?code&state`، صلاحية 60 ث ✓
- وجهة خارج allowlist → **403** ✓
- redeem بلا سر → **401**؛ بالسر → `{user_id, display_name, locale}` **فقط** (لا بريد/هاتف/KYC) ✓
- **إعادة استخدام الرمز → 400 BAD_CODE** (استهلاك ذري أحادي) ✓
- `introspect`: جلسة حية → `active:true`؛ **بعد تسجيل خروج الموقع → `active:false`** ✓

## 4) تشغيل الاستوديو محليًا (wrangler dev :8788 على البناء الفعلي)

ملاحظة: workerd المثبت (wrangler 4.92.0) أقصى compatibility date له 2026-05-22 — التشغيل المحلي مرّ بعلم `--compatibility-date 2026-05-22` على سطر الأوامر فقط؛ ملف الإعداد يبقى 2026-08-01 للنشر.

- الوثيقة المقدمة عبر الـ worker تحمل كامل الترويسات: **COOP same-origin / COEP require-corp / CORP same-origin** + CSP + `Cache-Control: no-store` — مؤكد بفحص headers.
- `/api/projects` بلا جلسة → 401؛ ترويسات `oai-*` و`x-levo-user` المزورة **تُجرَّد** (`/auth/me` يبقى null) ✓

### فحص المتصفح (Playwright Chromium headless، 1024×768 و390×844): **18/18**
- تحميل الصفحة، `lang="ar" dir="rtl"` ✓
- **`window.crossOriginIsolated === true`** و`SharedArrayBuffer` متاح ✓ (T15 محليًا)
- **هيكل المحرك mounted فعلًا**: shadow root يحوي `.app-shell` وعناصر `stl-input` / `gizmo-move` / `plate-add` / `save-project` ✓، وviewport المحرك يبقى **LTR** داخل chrome عربي RTL ✓
- **صفر روابط APK** في DOM (بطاقة «تطبيق LEVONIS الكامل — قريبًا» معطلة بلا رابط) ✓
- لوحة «مشاريعي» تفتح؛ تبويب الحساب للضيف يعرض دعوة تسجيل الدخول الصادقة ✓

### دخول شامل عبر المتصفح (worker↔worker حقيقيان): **8/8**
1. `studio/auth/login` → هبوط على شاشة دخول الموقع الرئيسي (ساق الاستئناف) ✓
2. تسجيل الدخول في SPA → استئناف عبر `handoff/start` → `auth/callback` → العودة إلى الاستوديو ✓ (يثبت إصلاح `finishAuth`)
3. `/auth/me` يرجع الهوية الدنيا؛ **الرابط النهائي بلا `code=`** (منظف) ✓
4. تبويب الحساب بلا دعوة ضيف؛ إنشاء مشروع من اللوحة → مدرج ✓
5. المشروع موجود خادميًا في `/api/projects` ✓
6. logout يهدم جلسة الاستوديو ✓

### خط الحفظ الكامل client→server: **5/5** (T4 النصف الأول)
استيراد `cube-10mm.stl` حقيقي في المحرر → طبقة S5 التقطت **snapshot كامل من المحرك** (3MF عبر `save-project`) وصورة مصغرة حقيقية من canvas → OPEN→UPLOAD→COMMIT إلى مشروع الحساب المربوط:
**`head=1, kind=full, thumbnail=true`** خادميًا. اللوحة تعرض شارات «متزامن» و«نسخة كاملة» ورقم المراجعة والصور المصغرة الحقيقية.

### فتح من «جهاز آخر»: **3/3** (T4 النصف الثاني)
سياق متصفح جديد تمامًا (كوكيز/IndexedDB نظيفة) → تسجيل دخول → فتح المشروع المتزامن من اللوحة → **استعادة المجسم والإعدادات (98 إعدادًا ولوح واحد) وملف الطابعة X2D** في المحرر.

الأدلة: `docs/evidence/studio/smoke-*.png` (محرر iPad/هاتف، حالة الضيف، اللوحة المسجلة، الالتزام المتزامن، الاستعادة من جهاز آخر).

## 5) خريطة سريعة لاختبارات القبول (بند 14) — ما ثبت في هذه الجلسة

| T | الحالة محليًا | ملاحظة |
|---|---|---|
| T1 | ✓ آلي | `tests/store-isolation.test.ts` ضمن 142/142 |
| T2 | ✓ سلوكي + متصفح | curl + Playwright عبر workers حقيقيين؛ منتهي/مكرر/وجهة ممنوعة/ترويسات مزورة كلها مرفوضة |
| T3 | ✓ اختبارات S3 | `api-projects.test.mjs` ضمن 109/0 (عزل مستخدمين، 409، idempotency) |
| T4 | ✓ متصفح كامل | حفظ كامل + فتح من سياق نظيف مع الاستعادة (أعلاه) |
| T5 | جزئي | فك الربط عند مشروع جديد + هدم الجلسة مثبتان؛ تبديل حساب أثناء رفع مؤجل مغطى باختبارات وحدة S5 لا بمتصفح |
| T7/T8/T10 | ✓ اختبارات وحدة | arrange/orchestrator/slicing-state ضمن 109/0 |
| T13 | ✓ متصفح + اختبار | صفر روابط APK في DOM + تأكيدات الغياب الجديدة |
| T14 | جزئي | Chromium محاكى 1024×768/390×844 RTL — **ليس iPad فعليًا** |
| T15 | ✓ محليًا فقط | `crossOriginIsolated===true` تحت wrangler dev — يبقى إثبات HTTPS النهائي على staging |
| T16 | جزئي | `perf-baseline.latest.json` موجود من S8؛ لم تُعد القياسات هنا |

## 6) ما لم يُغطَّ (بصدق)

- **لا نشر فعلي على Cloudflare**: workflows يدوية ولم تُشغَّل؛ أول staging حقيقي هو إثبات T15 النهائي (COOP/COEP وworkers.dev)، وربط الأسرار (`STUDIO_HANDOFF_SECRET` بالقيمة نفسها في الطرفين، `STUDIO_ALLOWED_DESTINATIONS`)، وIMAGES entitlement.
- **iPad حقيقي / Safari**: كل فحوص الأجهزة محاكاة Chromium.
- **MakerWorld خارجيًا**: لا رفع اختباري لأي نموذج (يتطلب حساب المالك وموافقته)؛ المسار المساعد وfixtures مغطاة باختبارات وحدة فقط.
- **قدرات داخل المحرك المعلقة بقرار المالك** (رسم أسطح MMU، fork المحرك): لم تُدَّعَ ولم تُختبر.
- **التقطيع الكامل في المتصفح** (WASM slice إلى G-code) لم يُنفذ ضمن smoke هذه الجلسة — مغطى باختبارات fixtures الثابتة فقط.
- تشغيل wrangler dev المحلي احتاج `--compatibility-date 2026-05-22` (حد binary المحلي)؛ سلوك 2026-08-01 الإنتاجي غير مختبر محليًا.
- cron التنظيف مربوط الآن لكنه لم يُشغَّل فعليًا ضد بيانات (منطق `runCleanup` مغطى باختبارات S3 الوحدوية).

## 7) بقايا معروفة (ليست من بوابات هذه المهمة)

- 7 أخطاء eslint قديمة بعد إصلاح سكربت lint: أنماط `setState` داخل effects وقراءة refs أثناء render في `slicer-client.tsx` (مواقع قديمة)، `use-slicing-state.ts`، `use-project-persistence.ts`، `projects-panel.tsx` — قواعد react-hooks الجديدة الصارمة؛ تحتاج جولة تنظيف مستقلة.
- حزمة worker الاستوديو ~9.1 MiB gzip (قرب حد 10 MiB المدفوع) — معمارية vinext القائمة، موثقة في تقرير S1.
- `studio/tests/api-projects.test.mjs` وغيرها تعمل ضد SQLite داخل العملية، لا miniflare — مقايضة S3 الموثقة.
