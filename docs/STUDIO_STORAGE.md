# LEVO Studio — التخزين والمزامنة (Project storage, protocol, recovery)

> **Draft — pending owner review.** يوثق المخطط والبروتوكول **المنفذين فعلًا**
> (شريحتا S3 خادمًا وS5 عميلًا)، مع قسم صريح للنواقص وقرارات المالك المعلقة.
> المرجع: `docs/STUDIO_PLAN.md` القرار 4؛ تعليمات المالك بند 4 و13.

## البنية

- **قاعدة D1 منفصلة:** `levonis-studio-db` (+ `-staging`) — مربوطة بworker
  الاستوديو فقط. **لا مشاركة مع `levonis-db`**: bindings D1 على مستوى القاعدة
  كلها، ومشاركتها كانت ستمنح خادم السلايسر users/sessions/wallet/KYC.
  الهوية تُخزن كـ`owner_id` معتم (نص `users.id`) ولا يوجد أي join على جداول
  المتجر.
- **R2 خاص:** `levonis-studio-files` (+ `-staging`) — لا وصول عام، لا روابط
  موقعة؛ كل بايت يمر عبر الـ worker بعد فحص الملكية في D1. لا مفاتيح R2 أو
  توكنات Cloudflare في المتصفح (native bindings فقط).
- التعريف في `studio/wrangler.jsonc`؛ الإنشاء التلقائي واستبدال المعرفات في
  `.github/workflows/deploy-studio-*.yml`؛ بيئة staging منفصلة كليًا عن
  الإنتاج (worker وقاعدة وسلة مستقلة).

## المخطط (`studio/db/schema.ts` → `studio/drizzle/0000_studio_projects.sql`)

| جدول | الأعمدة الأساسية | ملاحظات |
|---|---|---|
| `projects` | `id, owner_id, name, thumbnail_key, schema_version, head_revision_id, created_at, updated_at, last_saved_at, deleted_at` | فهرس `(owner_id, updated_at)`؛ حذف ناعم عبر `deleted_at` |
| `project_revisions` | `id, project_id, revision, parent_revision, schema_version, engine_version, content_hash, size_bytes, manifest_json, snapshot_kind∈{full,source-only}, state∈{pending,committed,abandoned}, created_at, committed_at` | `UNIQUE(project_id, revision)`؛ أرقام revisions متصاعدة لكل مشروع (الفجوات طبيعية) |
| `project_files` | `id, revision_id, kind∈{snapshot3mf,source,thumbnail,asset}, r2_key UNIQUE, sha256, size_bytes, content_type, state∈{pending,verified}, created_at` | مفاتيح R2 **يولدها الخادم فقط**: `projects/{projectId}/rev/{revisionId}/{fileId}` |
| `studio_sessions` | (طبقة الدخول — انظر `docs/STUDIO_AUTH.md`) | نفس DDL في `worker/auth/session.ts` |

`manifest_json` يحمل ما يطلبه بند 4 فوق ملف 3MF: أسماء المجسمات ووحداتها
وتحويلاتها، توزيع الألواح، الطابعة/الفوهة/السرير/المواد، الإعدادات العامة
والخاصة، وأعلام وجود بيانات التلوين/الرسم. `snapshot_kind='source-only'` يسم
الحفظ المتدهور بصدق: لا يُعرض «متزامن كامل» أبدًا ولا يستبدل آخر revision
كامل.

## البروتوكول (D1 وR2 ليسا معاملة واحدة)

المسارات في `studio/worker/api/` (router → projects/uploads/quota/cleanup)،
كل استجابات `/api` بـ`Cache-Control: private, no-store`، وكل مسار يتطلب جلسة
استوديو (الضيف يرد عليه 401 صادق مع بقاء التحرير المحلي):

1. **OPEN** — `POST /api/projects/:id/revisions`: العميل يرسل بيان الملفات
   (sha256 + الحجم + النوع) و`base_revision`؛ الخادم يتحقق (جلسة + ملكية +
   حصة + الحدود) وينشئ revision بحالة `pending` وصفوف ملفات `pending`
   بمفاتيح R2 خادمية. رفض مبكر لقاعدة قديمة (`409` مع head الخادم).
2. **UPLOAD** — `PUT /api/uploads/:fileId`: بث إلى R2 مع حساب sha256 أثناء
   البث (`DigestStream`/`FixedLengthStream` حيث توفرت)؛ التطابق في الحجم
   والبصمة يقلب الصف إلى `verified`، وعدم التطابق يحذف الكائن — لا يُترك ملف
   خاطئ أبدًا. إعادة PUT idempotent (retries آمنة).
3. **COMMIT** — `POST /api/projects/:id/revisions/:revId/commit`: يتحقق أن كل
   الملفات `verified` والمالك مطابق و`head == parent_revision`، وإلا **409**
   يعيد head الخادم (rebase/fork — لا طمس صامت لنسخة أحدث). النجاح يقلب
   الحالة إلى `committed` ويحرك head/`last_saved_at`/الصورة المصغرة. إعادة
   commit لنفس revision ترد نجاحًا (idempotent)، ومسار استرداد الانهيار يكمل
   قلب الحالة إن مات commit سابق بين الخطوتين.
4. **READ** — `GET /api/projects` (قائمة)، `GET /api/projects/:id`،
   `/thumbnail`، `/revisions`، `/revisions/:revId`، `/files/:fileId`:
   فحص ملكية D1 أولًا ثم بث R2 عبر الـ worker. غير المالك يرى **404** لا 403
   — لا يُكشف حتى وجود المشروع (اختبار T3). أيضًا `PATCH` (تسمية)،
   `DELETE` (حذف ناعم بتأكيد من الواجهة)، `POST /duplicate` (نسخ كائنات R2
   أولًا ثم الصفوف)، `POST .../abandon`.
5. **CLEANUP** — `runCleanup` في `worker/api/cleanup.ts`: جلسات منتهية؛
   revisions «pending» الأقدم من TTL و«abandoned» (كائنات R2 أولًا ثم الصفوف)؛
   مشاريع محذوفة ناعمًا بعد مدة الاحتفاظ؛ الإبقاء على أحدث N revisions معتمدة
   مع حماية دائمة للـ head **ولأحدث snapshot كامل**؛ ومصالحة منخفضة التردد
   بين بادئة `projects/` في R2 والقاعدة (حذف كائنات >48 ساعة بلا صف).

## الحدود والحصص (معلنة وقابلة للضبط — `worker/api/quota.ts`)

| الحد | الافتراضي | متغير الضبط |
|---|---|---|
| حصة تخزين لكل مستخدم | 200 MiB | `STUDIO_USER_QUOTA_BYTES` |
| أكبر ملف واحد | 64 MiB | `STUDIO_MAX_FILE_BYTES` |
| أكبر صورة مصغرة | 4 MiB | `STUDIO_THUMBNAIL_MAX_BYTES` |
| ملفات لكل revision | 64 | `STUDIO_MAX_FILES_PER_REVISION` |
| حجم manifest | 256 KiB | `STUDIO_MAX_MANIFEST_BYTES` |
| مهلة pending قبل التنظيف | 24 ساعة | `STUDIO_PENDING_TTL_HOURS` |
| احتفاظ المحذوف ناعمًا | 30 يومًا | `STUDIO_DELETED_RETENTION_DAYS` |
| revisions معتمدة محفوظة لكل مشروع | 20 | `STUDIO_KEEP_COMMITTED_REVISIONS` |

الحصة تُحتسب شاملة حجوزات pending (منع التجاوز عبر OPENs متوازية).
`GET /api/quota` يعرض الاستخدام والحدود الفعلية — لا «غير محدود» أبدًا.
**الأرقام النهائية قرار مالك معلق** (تسجيله في `docs/DECISIONS.md` محجوز
للمنسق)؛ حتى قراره تُعرض هذه الافتراضات كحدود حالية لا كوعود.

## طبقة العميل (S5 — `studio/app/project-store.ts` + `project-sync.ts`)

- IndexedDB **مسودة/استرداد أعطال فقط**، بـnamespace لكل مستخدم
  (`user:<id>` / `guest` / `legacy`). سجلات المخزن القديم لا تُتبنى تلقائيًا —
  استيرادها فعل مستخدم صريح.
- خمس حالات مرئية منفصلة: تغييرات غير محفوظة / محفوظ محليًا / جارٍ الرفع /
  متزامن / فشل-أعد المحاولة. «متزامن» لا تظهر إلا بعد 200 للـ COMMIT.
- حفظ debounced مع تخطي المحتوى غير المتغير بالبصمة (لا إعادة رفع كاملة لكل
  حركة)، وretries محدودة بتراجع، و409 يُعرض كتضارب صريح.
- الخروج/تبديل الحساب: `dispose()` يلغي كل المؤقتات ويجهض الرفع الجاري —
  لا يُرفع شيء إلى حساب آخر أبدًا (T5).
- تمييز full/source-only في الواجهة، وحماية آخر snapshot كامل ناجح من
  الاستبدال (T6).

## الاسترجاع والنسخ الاحتياطي

- **انقطاع أثناء الرفع:** الصفوف تبقى `pending`؛ retries آمنة idempotent؛
  إن لم يكتمل خلال TTL يعيد الـ cron المساحة، ولا يتأثر head المعتمد.
- **تضارب جهازين:** 409 مع head الخادم؛ العميل يعيد الفتح/rebase — لا طمس صامت.
- **انهيار بين D1 وR2:** المصالحة الدورية تحذف كائنات R2 اليتيمة؛ حماية
  الـ head وأحدث snapshot كامل مدمجة في مسار التنظيف نفسه.
- **استرجاع بيانات المنصة (Cloudflare):** D1 توفر Time Travel لاستعادة
  القاعدة لنقطة زمنية؛ R2 لا يوفر versioning هنا — آخر N revisions المعتمدة
  هي سجل الإصدارات الفعلي للمستخدم. سياسة نسخ احتياطي خارجي إضافية = قرار
  مالك معلق (تكلفة/نطاق).

## الاختبارات والنواقص

- `studio/tests/api-projects.test.mjs`: عزل مستخدمين (T3)، 409 عند التضارب،
  idempotent retries، تنظيف pending (T6) — سلوكيًا ضد router الـ API.
- **غير موصول بعد:** cron التنظيف يحتاج handler `scheduled` في
  `studio/worker/index.ts` + تعبير cron في `studio/wrangler.jsonc`
  (الملفان لشرائح أخرى/المنسق). حتى التوصيل، التنظيف لا يعمل تلقائيًا —
  موثق بصدق ولا شيء يدّعي غير ذلك.
- T4 (فتح من جهاز آخر باستعادة كاملة) يتطلب staging HTTPS مكتمل الإعداد —
  انظر نواقص `docs/STUDIO_AUTH.md`.
