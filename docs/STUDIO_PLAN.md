# LEVO Studio — خطة التنفيذ (Implementation Plan)

هذه الخطة تنفّذ برومت LEVO Studio على قاعدة جدول الفجوات `docs/STUDIO_GAPS.md`. كل قرار أدناه مبني على نتائج المسح الستة؛ لا تُدّعى أي قدرة وُسمت هناك «جزئي/لا» على أنها مكتملة.

---

## أولًا: قرارات المعمارية (Architecture decisions)

### 1. التنظيم: monorepo مع workspace مستقل تمامًا لـ Studio

**القرار:** يبقى `studio/` داخل monorepo `Levonis` كتطبيق مستقل بالكامل: lockfile خاص، `studio/wrangler.jsonc` جديد يعرّف worker باسم `levonis-studio` وبيئة `env.staging` باسم `levonis-studio-staging`، وworkflows نشر خاصة به في جذر `.github/workflows` (المكان الوحيد الذي ينفذ GitHub منه). worker المتجر `levonis`/`levonis-staging` و`wrangler.jsonc` الجذري لا يُمسّان.

**الأسباب:** (أ) العزل بنيوي أصلًا — تطبيقان وworkers منفصلان يحققان بند 2 (لا حمولة سلايسر في المتجر) بالمعمارية لا بتقسيم حزم داخل bundle واحد؛ (ب) workflows `studio/.github/` خاملة موضعيًا ويجب أن تبقى كذلك (خطر إعادة تفعيل نشر APK تلقائي)؛ (ج) نمط النشر الجذري (`deploy-staging.yml`: إنشاء موارد إن غابت + استبدال placeholders + فحص صحة) جاهز للنسخ؛ (د) concurrency groups منفصلة تضمن ألا يكسر نشر Studio نشر المتجر (بند 2).

### 2. البناء: إبقاء vinext وإصلاح config المبتور

**القرار:** يبقى vinext 0.0.50 (مثبت بالقفل من registry.npmjs.org). إصلاح `studio/vite.config.ts` بإزالة استيراد `./.openai/hosting.json` (المحذوف) واستبداله بثوابت، وحذف plugin `sites()` مع `build/sites-vite-plugin.ts`، وإسقاط أغلفة `install-ci.sh`/`sites-env.sh` لصالح `npm ci` خالص في CI.

**الأسباب:** vinext لازم **وقت التشغيل** لا البناء فقط — `studio/worker/index.ts` يستورد `vinext/server/app-router-entry` و`vinext/server/image-optimization`؛ إسقاطه يعني إعادة كتابة مدخل الخادم. المسار البديل (SPA بـ Vite خالص كما يثبت `mobile/vite.config.ts`) موثق كخطة تراجع إن تعطل vinext (حزمة 0.x بنطاقات peer ضيقة) — لكنه ليس المسار الافتراضي لأنه أعلى تغييرًا الآن.

### 3. الدخول: تبادل رمز أحادي الاستخدام خادم-لخادم (اختيار من مقترحات المسح)

**القرار:** حذف `chatgpt-auth.ts` كليًا واستبداله بالتصميم التالي (بند 3 من البرومت حرفيًا):

1. worker الموقع الرئيسي يضيف `POST /api/studio/handoff` (مصادَق بجلسة `levonis_session`، محمي CSRF): يسكّ رمزًا أحادي الاستخدام (32 بايت عشوائي، يُخزن **مُجزأ SHA-256** مع user_id والوجهة وصلاحية ≤ 60 ثانية و`consumed_at`), ثم 302 إلى `https://studio.levonis-iq.com/auth/callback?code=...&state=...` بعد فحص الوجهة ضد allowlist.
2. worker الاستوديو في `/auth/callback` يستبدل الرمز **خادم-لخادم** لدى worker الموقع (سر مشترك عبر secret منشور بالمسار القائم، أو service binding) — الاستهلاك ذري ومرة واحدة؛ الإعادة تُرفض. يستلم `{user_id, display_name, locale}` فقط (الحد الأدنى — لا KYC ولا محفظة، بند 3).
3. الاستوديو يسكّ جلسته الخاصة بنمط `worker/lib/session.ts` نفسه: كوكي HttpOnly Secure SameSite=Lax **مقيد بالمضيف** (لا `Domain=.levonis-iq.com` أبدًا — متاجر المجتمع الفرعية موجودة)، الرمز يُخزن مُجزأً، وينظف الرابط من `code` فورًا ثم يعيد التوجيه إلى return path مُتحقق بنفس قواعد المسار النسبي التي يطبقها `safeRelativeReturnPath` الحالي.
4. الخروج يهدم جلسة الاستوديو؛ الـ APIs الحساسة يمكنها التحقق من حيوية جلسة الموقع خادم-لخادم؛ تبديل الحساب يلغي الرفع المؤجل (بند 4).
5. دفاع في العمق: worker الاستوديو **يجرّد ترويسات `oai-*` الواردة** قبل أي معالجة.

**السبب في اختيار هذا التصميم:** كوكي `levonis_session` مقيد بمضيف الموقع الرئيسي ولن يصل إلى studio.levonis-iq.com أصلًا؛ توسيعه على النطاق كله محظور بنص البرومت؛ والترويسات القديمة ثغرة انتحال مفتوحة على أي خادم عام. التبادل خادم-لخادم هو الخيار الوحيد المتبقي المتوافق مع COOP/COEP (كل مسارات `/auth/*` same-origin على مضيف الاستوديو، فلا تمسّ `connect-src 'self'`).

### 4. التخزين: قاعدة D1 منفصلة + R2 خاص + بروتوكول revisions

**القرار:** إنشاء `levonis-studio-db` + `levonis-studio-db-staging` (D1) و`levonis-studio-files` + `-staging` (R2 خاص)، مربوطة بworker الاستوديو فقط عبر native bindings (لا مفاتيح في المتصفح — بند 13).

**الأسباب الحاسمة ضد مشاركة `levonis-db`:** bindings D1 على مستوى القاعدة كلها بلا grants للجداول — المشاركة تمنح خادم السلايسر users/sessions/wallet/KYC/orders وهو ما يمنعه بند 3 صراحة؛ عزل نصف قطر الانفجار (خطأ migration في الاستوديو لا يلمس التجارة)؛ وworkflow الإنتاج القائم **يرفض** migrations على قاعدة غير فارغة، فقاعدة جديدة تمر من البوابة طبيعيًا بينما توسيع قاعدة المتجر يستلزم «ترقية مراجَعة» يدوية على أي حال. الهوية تبقى قانونية في `levonis-db`؛ الاستوديو يخزن `owner_id` (نص `users.id` المعتم) فقط ولا يجري أي join على جداول المتجر.

**مخطط D1 (يملأ `studio/db/schema.ts` بmigrations حقيقية):**
- `projects(id PK, owner_id NOT NULL, name NOT NULL, thumbnail_key, schema_version NOT NULL, head_revision_id, created_at, updated_at, last_saved_at, deleted_at; INDEX(owner_id, updated_at))`
- `project_revisions(id PK, project_id→projects, revision NOT NULL, parent_revision, schema_version, engine_version, content_hash NOT NULL, size_bytes, manifest_json NOT NULL, snapshot_kind IN ('full','source-only'), state IN ('pending','committed','abandoned'), created_at, committed_at, UNIQUE(project_id, revision))`
- `project_files(id PK, revision_id→project_revisions, kind IN ('snapshot3mf','source','thumbnail','asset'), r2_key UNIQUE NOT NULL, sha256 NOT NULL, size_bytes NOT NULL, content_type, state IN ('pending','verified'), created_at)`

`manifest_json` يحمل ما يطلبه بند 4 فوق ملف 3MF: أسماء المجسمات ووحداتها وتحويلاتها، توزيع الألواح، هوية الطابعة/الفوهة/السرير/المواد، الإعدادات العامة والخاصة، وأعلام وجود بيانات التلوين/الرسم — مع `snapshot_kind='source-only'` يسم الحفظ المتدهور بصدق فلا يُعرض «متزامن كامل» أبدًا ولا يستبدل آخر revision كامل (بند 4 حرفيًا).

**تخطيط R2:** مفاتيح يولدها الخادم فقط: `projects/{projectId}/rev/{revisionId}/{fileId}` — لا يُقبل مفتاح من العميل أبدًا (بند 4)، ولا روابط R2 عامة/موقعة: كل قراءة تمر عبر worker بعد فحص الملكية في D1.

**بروتوكول الرفع (D1 وR2 ليسا معاملة واحدة — بند 4):**
1. **OPEN:** العميل يجزّئ (sha256/حجم) ويطلب `POST /api/projects/:id/revisions` → الخادم يتحقق (جلسة + ملكية + حصة) وينشئ revision `pending` وصفوف ملفات `pending` بمفاتيح R2 خادمية.
2. **UPLOAD:** `PUT /api/uploads/:fileId` يبث إلى R2 عبر binding مع حساب sha256 أثناء البث؛ التطابق ⇒ `verified`. إعادة PUT لنفس fileId idempotent (retries آمنة)؛ multipart للأجزاء الكبيرة ضمن حدود Workers.
3. **COMMIT:** `POST .../revisions/:revId/commit` → دفعة D1 واحدة: كل الملفات `verified` والمالك مطابق و`head == base_revision`، وإلا **409** يعيد head الخادم (rebase/fork — لا طمس صامت لنسخة أحدث). عند النجاح: `committed` + تحديث head/`last_saved_at`/thumbnail.
4. **READ:** فحص ملكية D1 أولًا ثم بث R2 عبر الـ worker — يغطي المشروع والصورة المصغرة وrevisions القديمة والتصدير (اختبار T3).
5. **CLEANUP:** cron في worker الاستوديو يحذف `pending` الأقدم من ~24 ساعة و`abandoned` (كائنات R2 من صفوف `project_files` ثم الصفوف)، مع مصالحة منخفضة التردد بين بادئة R2 وقاعدة البيانات؛ حصص تخزين لكل مستخدم والاحتفاظ بآخر N revisions معتمدة (الأرقام ضمن «قرارات المالك»).

**طبقة العميل:** `project-store.ts` (IndexedDB) يبقى مسودة/استرداد أعطال فقط، مفصولًا بـ namespace لكل `user_id` (+`guest`)، بحالات خمس منفصلة: تغييرات غير محفوظة / محفوظ محليًا / جارٍ الرفع / متزامن / فشل-أعد المحاولة («متزامن» فقط بعد 200 للـ commit). الخروج/تبديل الحساب يلغي مؤقتات autosave والرفع الجاري؛ استيراد مسودات قديمة فعل مستخدم صريح فقط.

### 5. COOP/COEP والأداء

**القرار:** تبقى `SECURITY_HEADERS` في `studio/worker/index.ts` (COOP same-origin / COEP require-corp / CORP same-origin) مغلِّفة **كل** استجابة — فالمحرك يختار نواة WASM المخيطة فقط تحت `crossOriginIsolated`، والإلغاء الحقيقي (Atomics على SAB) يعتمد عليها. كل مسارات `/auth/*` و`/api/*` تُعالج داخل fetch الـ worker **قبل** تفويض vinext — نفس الأصل، فلا حاجة لتوسيع `connect-src` ولا لإضعاف العزل لإصلاح الدخول (بند 10 حرفيًا). HTML يمر دائمًا عبر الـ worker بـ `Cache-Control: no-store`؛ الأصول المبصومة immutable طويلة الأمد؛ استجابات `/api` كلها `private, no-store` (بند 13). CI يحوّل T15 إلى فحص آلي (curl على الترويسات بعد كل نشر staging).

### 6. المداخل (Entry points)

**القرار:** بطاقة «LEVO Studio — تجهيز ملفات الطباعة» في خدمات الصفحة الرئيسية للمتجر ومدخل في مجتمع ليفو — **روابط `<a>` عادية** إلى `https://studio.levonis-iq.com`، بلا iframe ولا تضمين ولا prefetch لأي أصل من الاستوديو (بند 2). روابط عودة من الاستوديو إلى الموقع/المجتمع مع حماية return URL. مشاركة tokens تصميم خفيفة (ألوان/خطوط/مسافات) بالنسخ إلى ثيم الاستوديو، لا بمشاركة حزم.

### 7. استراتيجية المحرك

**القرار:** يبقى `three-slicer@0.2.2` مثبتًا بالقفل (بند 6: لا استبدال بمحاكاة أو سحابة). كل الـ DOM automation يُحشر في `engine-adapter.ts` واحد بواجهة typed، مع اختبار عقد testids موسع ضد الحزمة المثبتة. الاحتياجات داخل المحرك — ترتيب عام عبر توسيع `__vpApi`، وcodec تلوين الأسطح لـ MMU — تُنفذ عبر patch/fork موثق قابل لإعادة البناء (AGPL يسمح؛ لا تعديل يدوي لـ node_modules) **بعد قرار المالك** المدرج أدناه؛ إلى حين القرار يُنفَّذ المكسب الأرخص المؤكد: التحقق من وصول إسناد extruder لكل مجسم إلى ناتج G-code باختبار فعلي، وتُعرض حدود MMU بصدق في الواجهة.

---

## ثانيًا: تقسيم التنفيذ على أسطول مراحل (Fleet breakdown)

**ملفات مشتركة محجوزة للمنسق (orchestrator) — لا تملكها أي شريحة:**
`studio/app/slicer-client.tsx` (المونوليث: الشرائح تسلّم مقاطع الاستخراج والمنسق يسلسل دمجها)، `worker/index.ts` الجذري (سطر تركيب مسارات المتجر)، `wrangler.jsonc` الجذري (secrets/vars الجديدة)، `studio/package.json` + `studio/package-lock.json`، `studio/tsconfig.json`.

**المرحلة 1 (متوازية، ملكية منفصلة):** S1, S2, S3, S4 — أساس النشر، الدخول، الخادم، تفكيك المحرر.
**المرحلة 2 (بعد اكتمال 1):** S5, S6, S7 — مزامنة العميل، الهوية واللغات، MakerWorld.
**المرحلة 3:** S8 — المداخل والأدلة والوثائق والقياسات.

### S1 — `deploy-foundation` (أساس البناء والنشر)
إصلاح البناء المبتور ونشر مستقل: استبدال استيراد `.openai/hosting.json` في `vite.config.ts` بثوابت وحذف plugin `sites()`؛ تأليف `studio/wrangler.jsonc` (levonis-studio + env.staging levonis-studio-staging، `assets` binding على `dist/client` مع بقاء HTML عبر الـ worker، `IMAGES`، nodejs_compat؛ D1/R2 placeholders لتستبدلها workflows)؛ workflow نشر staging وإنتاج بجذر `.github/workflows` تحاكي النمط القائم (إنشاء الموارد إن غابت، استبدال placeholders، migrations، فحص ترويسات COOP/COEP + `crossOriginIsolated` بعد النشر = T15 في CI)؛ إسقاط أغلفة Sites لصالح `npm ci`.
**الملفات:** `studio/vite.config.ts`، `studio/wrangler.jsonc` (جديد)، `studio/cloudflare-env.d.ts`، `studio/.npmrc`، `studio/scripts/build-verified.sh`، `studio/scripts/install-ci.sh` (حذف)، `studio/scripts/sites-env.sh` (حذف)، `studio/build/sites-vite-plugin.ts` (حذف)، `.github/workflows/deploy-studio-staging.yml` (جديد)، `.github/workflows/deploy-studio-production.yml` (جديد).

### S2 — `auth-handoff` (الدخول الموحد)
تنفيذ تصميم القرار 3 كاملًا: مسار handoff في worker الموقع (ملف route جديد؛ تركيبه في `worker/index.ts` الجذري عبر المنسق)، جدول رموز التبادل في migration للموقع، `/auth/callback` + `/auth/logout` وجلسات الاستوديو في worker الاستوديو، تجريد ترويسات `oai-*`، حذف `chatgpt-auth.ts` واستبداله بموفر هوية جديد يستهلكه `page.tsx`، وربط مسارات `/auth/*` و`/api/*` قبل تفويض vinext في `studio/worker/index.ts` (يستدعي router الـ API المملوك لـ S3 عبر واجهة متفق عليها). اختبارات T2 سلوكية: رمز منتهٍ/مكرر، وجهة غير مسموحة، ترويسات مزورة.
**الملفات:** `worker/routes/studio.ts` (جديد — جذر)، `migrations/0012_studio_handoff.sql` (جديد — رقم بحسب التسلسل الفعلي)، `studio/worker/index.ts`، `studio/worker/auth/callback.ts` (جديد)، `studio/worker/auth/session.ts` (جديد)، `studio/app/chatgpt-auth.ts` (حذف)، `studio/app/studio-auth.ts` (جديد)، `studio/app/page.tsx`، `studio/tests/auth-handoff.test.mjs` (جديد).

### S3 — `project-storage-server` (حفظ بالحساب: D1 + R2)
مخطط القرار 4 كاملًا: schema + migrations حقيقية، router الـ API (`/api/projects`, `/api/uploads`) ببروتوكول OPEN→UPLOAD→COMMIT→READ، فحص ملكية على كل قراءة/كتابة/صورة/revision/تصدير، حصص وحدود معلنة، cron تنظيف اليتامى والمصالحة، وحذف عينة `examples/d1` المضللة. اختبارات T3/T6 سلوكية ضد miniflare/wrangler dev: عزل مستخدمين، 409 عند التضارب، idempotent retries، تنظيف pending.
**الملفات:** `studio/db/schema.ts`، `studio/db/index.ts`، `studio/drizzle.config.ts`، `studio/drizzle/` (migrations مولدة)، `studio/worker/api/router.ts` (جديد)، `studio/worker/api/projects.ts` (جديد)، `studio/worker/api/uploads.ts` (جديد)، `studio/worker/api/cleanup.ts` (جديد)، `studio/worker/api/quota.ts` (جديد)، `studio/examples/` (حذف)، `studio/tests/api-projects.test.mjs` (جديد).

### S4 — `editor-core` (تفكيك المونوليث + adapter المحرك + الترتيب العام + صدق التقطيع)
استخراج adapter المحرك أولًا (كل shadow-root/testid/حقن ملفات/CSS/`__vpApi` خلف واجهة typed واحدة، حقن مدفوع بالأحداث بدل poll الـ 500ms)، ثم القصّات الآمنة (profiles، profile-loader مع تحذير السقوط الصامت للـ preset، import-orchestrator)، وإغلاق فجوة النتائج القديمة (إبطال/وسم stale عند أي تعديل مشهد بعد التقطيع + عدم تخزين ناتج over_bed)، والترتيب التلقائي **العام** فوق `packModelsAcrossPlates` مغذّى بكل المجسمات عبر sceneSnapshot مع معاينة وتراجع وحدود معلنة (9 ألواح، سرير مستطيل)، وميزانية فك ضغط ZIP بتأكيد المستخدم. تعديلات `slicer-client.tsx` تمر عبر المنسق.
**الملفات:** `studio/app/engine-adapter.ts` (جديد)، `studio/app/printer-profiles.ts` (جديد)، `studio/app/profile-loader.ts` (جديد)، `studio/app/import-orchestrator.ts` (جديد)، `studio/app/hooks/use-slicing-state.ts` (جديد)، `studio/app/plate-packing.ts`، `studio/app/archive-import.ts`، `studio/app/model-loaders.ts`، `studio/tests/editor-capabilities.test.mjs`، `studio/tests/arrange.test.mjs` (جديد).

### S5 — `project-sync-client` (مزامنة العميل و«مشاريعي»)
طبقة العميل من القرار 4: namespaces لكل مستخدم في IndexedDB، حالات المزامنة الخمس، عميل الرفع (تجزئة، retries، إلغاء عند الخروج/تبديل الحساب)، تمييز snapshot كامل/مصدر-فقط في الواجهة وحماية آخر snapshot كامل، شاشة «مشاريعي» (إنشاء/تسمية/نسخ/بحث/حذف بتأكيد/فتح/تصدير/استيراد + حالات تحميل/فارغ/خطأ وصور مصغرة حقيقية)، واستخراج منطق الاستمرارية من المونوليث إلى hook تملكه الشريحة.
**الملفات:** `studio/app/project-store.ts`، `studio/app/project-sync.ts` (جديد)، `studio/app/hooks/use-project-persistence.ts` (جديد)، `studio/app/components/projects-panel.tsx` (جديد)، `studio/app/thumbnail.ts` (جديد — التقاط canvas للصور المصغرة)، `studio/tests/project-sync.test.mjs` (جديد).

### S6 — `ui-i18n-theme` (هوية LEVONIS واللغات والموبايل وتعطيل APK)
استخراج القواميس إلى `i18n/{ar,en,ckb}` مع إضافة السورانية (ترجمة بشرية مراجعة) وحفظ اللغة وRTL/LTR صحيحين؛ ثيم LEVONIS من tokens المتجر يشمل عناصر المحرك (ملف الثيم الذي يحقنه adapter S4)؛ تفكيك JSX للمونوليث إلى Header وSheets مكونات مملوكة؛ تحسينات اللمس/آيباد (بند 5)؛ **تعطيل APK**: استبدال الروابط الثلاثة النشطة بـ «تطبيق LEVONIS الكامل — قريبًا» بلا رابط، وإزالة توصيلات فحص التحديث الأصلي من واجهة الويب (مع تحديث تأكيدات الاختبار المرتبطة بالتنسيق مع S4 مالكة ملف الاختبار).
**الملفات:** `studio/app/globals.css`، `studio/app/layout.tsx`، `studio/app/editor-theme.ts` (جديد)، `studio/app/i18n/index.ts` (جديد)، `studio/app/i18n/ar.ts` (جديد)، `studio/app/i18n/en.ts` (جديد)، `studio/app/i18n/ckb.ts` (جديد)، `studio/app/components/header.tsx` (جديد)، `studio/app/components/sheets/setup.tsx` (جديد)، `studio/app/components/sheets/print.tsx` (جديد)، `studio/app/components/sheets/connect.tsx` (جديد)، `studio/app/components/sheets/about.tsx` (جديد)، `studio/public/og.png`، `studio/public/favicon.svg`، `studio/public/manifest.webmanifest`.

### S7 — `slicing-makerworld` (مسار الإخراج الأساسي + التلوين الصادق)
تنفيذ بند 9: تدفق «تجهيز لـ MakerWorld» بخطواته 1-4 (preflight للمشروع/الألواح/المواد، 3MF باسم واضح + صورة مصغرة، ملخص «ما سيُنقل وما قد لا يُدعم»، فتح صفحة الرفع الرسمية بصياغات صادقة)؛ تمييز أنواع الملفات الثلاثة إلزاميًا (مشروع 3MF / Print Profile — **غير ممكن حاليًا لأن MakerWorld يرفض ملفات غير Bambu Studio** / G-code)؛ إنزال G-code من الإجراء الأساسي؛ مؤشر غير محدد لمرحلة tree-support؛ golden fixture لملف 3MF مُصدَّر يُتحقق فتحه بالأداة المتوافقة؛ اختبار وصول إسناد extruder إلى ناتج التقطيع (المكسب المؤكد من بند 7) مع عرض حدود MMU المتبقية بصدق. إعادة التحقق من روابط ويكي MakerWorld الثلاثة من شبكة غير محجوبة وأرشفة النتيجة.
**الملفات:** `studio/app/makerworld/preflight.ts` (جديد)، `studio/app/makerworld/prepare.tsx` (جديد)، `studio/app/export-manager.ts` (جديد)، `studio/BAMBU_PRINT_PIPELINE.md`، `studio/tests/slice-fixtures.test.mjs` (جديد)، `studio/tests/makerworld-flow.test.mjs` (جديد)، `studio/tests/fixtures/` (جديد — عينات ثابتة).

### S8 — `entry-evidence-docs` (المداخل والأدلة والوثائق)
بطاقة الخدمات في الصفحة الرئيسية ومدخل المجتمع (`<a>` عادي للنطاق الفرعي، ترجمات المتجر الثلاث)؛ دليل T1 (network traces للمتجر تُظهر صفر أصول سلايسر) واختبار عزل آلي؛ سكربت قياسات الأداء قبل/بعد بنفس fixtures (T16)؛ تحديث الوثائق: وسم `SLICER_ARCHITECTURE.md` مُتجاوَزة، وثيقة خصوصية حفظ المشاريع ومدد الاحتفاظ، وثائق ربط الحساب والمخطط وحماية R2 والبيئات (متطلبات التسليم بند 15)، ومراجعة إشعارات AGPL في النشر.
**الملفات:** `src/pages/Home.tsx`، `src/pages/Community.tsx`، `src/translations.ts`، `tests/store-isolation.test.ts` (جديد — جذر)، `studio/tests/perf-baseline.mjs` (جديد)، `studio/SLICER_ARCHITECTURE.md`، `studio/README.md`، `docs/STUDIO_AUTH.md` (جديد)، `docs/STUDIO_STORAGE.md` (جديد)، `docs/STUDIO_PRIVACY.md` (جديد).

---

## ثالثًا: خريطة اختبارات القبول (بند 14) إلى الشرائح

| T | الاختبار | الشريحة المسؤولة | ملاحظات |
|---|---|---|---|
| 1 | المتجر/المجتمع بلا JS/WASM سلايسر + الزر يفتح النطاق الفرعي | S8 | traces + اختبار عزل آلي |
| 2 | الدخول والعودة، رفض رمز منتهٍ/مكرر/وجهة غير مسموحة، عدم الثقة بترويسات مزورة | S2 | اختبارات سلوكية ضد worker حقيقي |
| 3 | مستخدم A لا يصل لمشروع/صورة/revision لمستخدم B ولو بالتخمين | S3 | فحص ملكية على كل مسار قراءة |
| 4 | إنشاء/تعديل/حفظ ثم فتح من جهاز آخر باستعادة كاملة | S3 + S5 | «الاستعادة الكاملة» مرهونة بـ snapshot كامل — تمييز source-only صريح |
| 5 | عدم تسرب مشروع حساب سابق عند تبديل المستخدم؛ الخروج يبطل APIs | S5 + S2 | إلغاء الرفع المؤجل + namespaces |
| 6 | استرداد بعد انقطاع الشبكة، حماية آخر نسخة ناجحة، تضارب جهازين | S5 + S3 | 409/rebase + idempotent retries |
| 7 | استيراد صالح/معطوب/ZIP خبيث بأمان دون تجميد | S4 | ميزانية فك الضغط الجديدة |
| 8 | نقل/تدوير/تحجيم وترتيب عام عبر ألواح مع الحدود وتراجع صحيح | S4 | يشمل الترتيب العام الجديد |
| 9 | تلوين/إسناد مواد محفوظ وموجود في الملف النهائي، مع تمييز حدود MMU | S7 (+ adapter S4) | إسناد extruder مُتحقق؛ رسم الأسطح يبقى «معلقًا بقرار المحرك» ويُذكر كذلك |
| 10 | تقطيع fixtures، تغيير إعداد يغيّر الخرج، إلغاء سريع، رفض نتيجة قديمة | S4 (stale/إلغاء) + S7 (fixtures) | |
| 11 | توافق 3MF بالأداة المتوافقة + اختبار رفع MakerWorld بموافقة | S7 | الجزء الخارجي مرهون بقرار/حساب المالك؛ إن تعذر يُذكر صراحة |
| 12 | فتح صفحة MakerWorld لا يسجل «رفع ناجح» ولا نشر/طباعة بلا موافقة | S7 | صياغات صادقة موجودة أصلًا وتُختبر |
| 13 | لا APK نشط ولا جسر أصلي ولا ملفات إصدار في نشر الويب | S6 (الواجهة) + S1 (أصول النشر) + S8 (الدليل) | |
| 14 | الواجهة والثيم وar/en/ckb وRTL/LTR على الأجهزة الثلاثة | S6 | محاكاة Chromium ≠ iPad فعلي — يُفصل الدليلان |
| 15 | `crossOriginIsolated` وworker/WASM تحت HTTPS النهائي مع الدخول والحفظ | S1 (CI) + S2 | فحص آلي بعد كل نشر staging |
| 16 | قياسات قبل/بعد بنفس fixtures + typecheck/build/tests/تبعيات | S8 (+ S1) | baseline يؤخذ فور نجاح أول بناء |

---

## رابعًا: سجل المخاطر والمجاهيل (Risks / Unknowns)

1. **هشاشة جسر المحرك:** كل التحكم DOM automation ضد shadow DOM لحزمة خارجية؛ أي ترقية قد تكسر بصمت. التخفيف: adapter واحد + اختبار عقد testids يغطي كل معرف مستخدم؛ لا ترقية للمحرك دون تشغيل العقد.
2. **لقطة غير قابلة للبناء:** كل نتائج «تعمل» قراءة ثابتة؛ أول بناء (S1) قد يكشف مفاجآت (peer ranges الضيقة لـ vinext 0.x، سكربتات تثبيت sharp/workerd). التخفيف: S1 أول شريحة، وbaseline الأداء يؤخذ فور نجاحه.
3. **سلوكيات محرك غير مُتحققة:** مدى معاينة الطبقات، إبطال المحرك الداخلي عند التعديل، بقاء إسناد extruder في G-code — كلها تحتاج تحققًا تشغيليًا قبل البناء فوقها (S4/S7 تبدآن بالتحقق لا بالافتراض).
4. **مستودع Studio الأصلي:** البرومت يحذر من استبدال عمل أحدث بأرشيف أقدم؛ لم تتح مقارنة `studio/` مع HEAD الفعلي لـ `aliamer229/Levo_slicer` من هذه البيئة — معلق على قرار/وصول المالك.
5. **MakerWorld:** لا API رسميًا (تحقق ثانوي — الروابط الثلاثة كانت محجوبة)؛ رفض Print Profile غير المولد بـ Bambu Studio يجعل خطوة «اطبع من Bambu Handy» غير مُتحققة. التخفيف: صياغات صادقة، تحقق خارجي بموافقة، وتليين النص إن لزم.
6. **تلوين MMU:** يتطلب تطويرًا داخل المحرك (fork/patch) — معلق على قرار المالك؛ الخطة لا تعده مكتملًا ولا تضع زر «قريبًا» كإنجاز، بل تنفذ المؤكد (إسناد extruder المُتحقق) وتعرض الحدود.
7. **تضارب D1/R2:** لا معاملة مشتركة — بروتوكول pending→verified→committed + cron إلزامي من اليوم الأول وإلا تراكمت ملفات يتيمة أو revisions ناقصة.
8. **AGPL §13:** نشر studio.levonis-iq.com يوجب إتاحة المصدر المطابق للبناء المنشور؛ الإشعارات موجودة لكن وجهة عرض المصدر معلقة على قرار المالك (أدناه).
9. **إعادة تفعيل workflows APK بالخطأ:** نقل YML إلى الجذر أو فصل `studio/` كمستودع مستقل يعيد نشرًا موقعًا تلقائيًا على أي push — موثق في S8 ويُمنع في مراجعات الكود.
10. **أسرار النشر:** إضافة GitHub Secret لا تجعله متاحًا تلقائيًا (بند 13)؛ سر تبادل الرموز بين الـ workers يجب ربطه عبر مسار الأسرار القائم في workflows، ويُختبر في staging قبل الإنتاج.
