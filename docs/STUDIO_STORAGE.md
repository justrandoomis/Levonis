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

## المخطط (`studio/db/schema.ts` → `studio/drizzle/0000_studio_projects.sql` + `0001_project_archive_pins.sql` + `0002_user_prefs.sql`)

| جدول | الأعمدة الأساسية | ملاحظات |
|---|---|---|
| `projects` | `id, owner_id, name, thumbnail_key, schema_version, head_revision_id, created_at, updated_at, last_saved_at, deleted_at` | فهرس `(owner_id, updated_at)`؛ حذف ناعم عبر `deleted_at` |
| `project_revisions` | `id, project_id, revision, parent_revision, schema_version, engine_version, content_hash, size_bytes, manifest_json, snapshot_kind∈{full,source-only}, state∈{pending,committed,abandoned}, created_at, committed_at` | `UNIQUE(project_id, revision)`؛ أرقام revisions متصاعدة لكل مشروع (الفجوات طبيعية) |
| `project_files` | `id, revision_id, kind∈{snapshot3mf,source,thumbnail,asset}, r2_key UNIQUE, sha256, size_bytes, content_type, state∈{pending,verified}, created_at` | مفاتيح R2 **يولدها الخادم فقط**: `projects/{projectId}/rev/{revisionId}/{fileId}` |
| `studio_sessions` | (طبقة الدخول — انظر `docs/STUDIO_AUTH.md`) | نفس DDL في `worker/auth/session.ts` |
| `project_archive` (P1-09) | `project_id PK → projects, archived_at` | وجود الصف = مؤرشف. الأرشفة **ليست حذفًا** |
| `project_revision_pins` (P1-09) | `id, revision_id → project_revisions, pinned_at, pin_reason, pin_ref` | `UNIQUE(revision_id, pin_reason, pin_ref)`؛ صف لكل جهة تمسك النسخة؛ النسخة المثبتة لا تُحذف أبدًا |
| `studio_user_prefs` (P1-10) | `owner_id PK, mode, updated_at` | وضع المحرر بسيط/متقدم (قرارا المالك S6/S7). غياب الصف = **بسيط**، الافتراضي للجميع. لا CHECK على `mode` عمدًا (وضع جديد لا يحتاج إعادة بناء الجدول)؛ القيمة تُتحقق في `worker/api/prefs.ts` وأي قيمة مجهولة تُقرأ «بسيط» |
| `studio_rate_limits` (P1-10) | `key PK, window_start, count` | نافذة ثابتة في D1 بنمط الموقع الرئيسي (`worker/api/ratelimit.ts`)؛ المفتاح `<bucket>:u:<userId>`؛ cron التنظيف يحذف النوافذ الأقدم من يوم |

**لماذا جداول جانبية لا أعمدة؟** خطة P1-09 سمّت الأعمدة
`projects.archived_at` و`project_revisions.pinned_at/pin_reason/pin_ref`، لكن
بوابة ترحيلات الاستوديو (`scripts/check-migrations-additive.mjs`، سير العمل 13)
لا تقبل إلا عبارات `CREATE` وترفض كل `ALTER TABLE` (اختبار
`tests/migrationsAdditive.test.ts` يثبّت ذلك). الأسماء نفسها محفوظة على
جدولين جانبيين، والترحيل `IF NOT EXISTS` لأن bootstrap الـ API
(`ensureStudioTables` في `worker/api/router.ts`) ينشئهما بنفس الـ DDL — فلا
تقرأ أي شيفرة جديدة جدولًا غائبًا حتى على قاعدة لم يصلها الترحيل `0001`.

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
   `DELETE` (نقل إلى سلة المحذوفات بتأكيد من الواجهة)، `POST /duplicate` (نسخ
   كائنات R2 أولًا ثم الصفوف)، `POST .../abandon`، ومسارات دورة الحياة
   والسجل أدناه.
5. **CLEANUP** — `runCleanup` في `worker/api/cleanup.ts`: جلسات منتهية؛
   revisions «pending» الأقدم من TTL و«abandoned» (كائنات R2 أولًا ثم الصفوف)؛
   مشاريع محذوفة ناعمًا بعد مدة الاحتفاظ؛ الإبقاء على أحدث N revisions معتمدة
   **غير مثبتة** مع حماية دائمة للـ head **ولأحدث snapshot كامل**؛ ومصالحة
   منخفضة التردد بين بادئة `projects/` في R2 والقاعدة (حذف كائنات >48 ساعة
   بلا صف). **النسخ المثبتة لا تُقلَّم ولا تُحذف في أي خطوة** (انظر أدناه).

## دورة حياة المشروع والسجل والتثبيت (P1-09)

ثلاث حالات منفصلة لا تختلط أبدًا (`studio/worker/api/projects.ts`):

| الحالة | المسار | السلوك |
|---|---|---|
| نشط | `GET /api/projects` (الافتراضي `view=active`) | القائمة العادية |
| مؤرشف | `POST /:id/archive` · `POST /:id/unarchive` · `GET ?view=archived` | يخرج من القائمة الافتراضية، يبقى قابلًا للفتح والحفظ، **ولا يحذفه التنظيف أبدًا** |
| سلة المحذوفات | `DELETE /:id` · `POST /:id/restore` · `GET ?view=trash` | قابل للاستعادة ما دام `deleted_at` داخل مدة الاحتفاظ (`purge_after` في الاستجابة)؛ بعدها `410 RETENTION_EXPIRED` ثم يحذفه الـ cron |

**السجل:** `GET /:id/revisions?state=committed` يعيد النسخ المحفوظة الأحدث
أولًا مع `pinned` و`pin_reasons` (الأسباب فقط، **لا** معرّف الجهة الماسكة).
`POST /:id/revisions/:revId/restore` (مع `base_revision` = الـ head الذي رآه
المستخدم) ينسخ ملفات النسخة المختارة (R2 أولًا، مع فحص الحصة) إلى revision
**جديدة** أبوها الـ head الحالي، ثم يحرك الـ head بنفس compare-and-set الذي
يستعمله COMMIT — لا يُعاد كتابة التاريخ، والـ head الذي تحرك على جهاز آخر يرد
`409`. «افتح كنسخة منفصلة» في الواجهة يفتح النسخة كمشروع محلي جديد غير مرتبط
بالحساب، فلا يصبح head تلقائيًا.

**التثبيت (`studio/worker/api/pins.ts`):** صف لكل جهة: `user` (زر «احتفظ
بهذه النسخة» — `POST|DELETE /:id/revisions/:revId/pin`، والمالك لا يستطيع
تحرير إلا تثبيته هو)، و`request`/`order` (شيفرة الخادم فقط — يستدعي
`pinRevision` مسارُ «اطلب تصنيعه» في P1-11). لا يُثبَّت إلا revision
`committed` لمشروع حي يملكه المستدعي. التنظيف:
`purgeRevisionById` يرفض النسخة المثبتة، والاحتفاظ يعدّ أحدث N **غير
مثبتة** ويبقي المثبتة خارج العدد، وحذف مشروع بعد مدة الاحتفاظ يزيل كل ما ليس
مثبتًا ويترك صف المشروع شاهدًا محذوفًا يملك النسخ المثبتة (لا يظهر في أي قائمة
ولا يُستعاد، ولا يُختار ثانية حتى يبقى فيه ما يُستعاد). المفتاح الأجنبي من
`project_revision_pins` يجعل القاعدة نفسها ترفض حذف revision مثبتة. بايتات
النسخ المثبتة تبقى محسوبة في حصة المالك ما دامت مثبتة.

## الحدود والحصص (معلنة وقابلة للضبط — `worker/api/quota.ts`)

| الحد | الافتراضي | متغير الضبط |
|---|---|---|
| حصة تخزين لكل مستخدم | **1 GiB** (قرار المالك Q7) | `STUDIO_USER_QUOTA_BYTES` |
| أكبر ملف واحد | 64 MiB | `STUDIO_MAX_FILE_BYTES` |
| أكبر صورة مصغرة | 4 MiB | `STUDIO_THUMBNAIL_MAX_BYTES` |
| ملفات لكل revision | 64 | `STUDIO_MAX_FILES_PER_REVISION` |
| حجم manifest | 256 KiB | `STUDIO_MAX_MANIFEST_BYTES` |
| مهلة pending قبل التنظيف | 24 ساعة | `STUDIO_PENDING_TTL_HOURS` |
| احتفاظ المحذوف ناعمًا | 30 يومًا | `STUDIO_DELETED_RETENTION_DAYS` |
| revisions معتمدة محفوظة لكل مشروع | 20 | `STUDIO_KEEP_COMMITTED_REVISIONS` |
| حد الطلبات — طول النافذة (P1-10) | 60 ثانية | `STUDIO_RATE_LIMIT_WINDOW_SECONDS` |
| حد الطلبات — قراءات (GET/HEAD) لكل حساب في النافذة | 1200 | `STUDIO_RATE_LIMIT_READS` |
| حد الطلبات — كتابات لكل حساب في النافذة | 600 | `STUDIO_RATE_LIMIT_WRITES` |

الحصة تُحتسب شاملة حجوزات pending (منع التجاوز عبر OPENs متوازية) والنسخ
المثبتة. `GET /api/quota` يعرض الاستخدام والحدود الفعلية — لا «غير محدود»
أبدًا. **الحصة قرار مالك (Q7، 2026-10-19): 1 GiB لكل مستخدم، بلا أي اشتراك
لازم للحفظ، وأكبر ملف يبقى 64 MiB** (`DEFAULT_USER_QUOTA_BYTES` في
`worker/api/quota.ts`)؛ المتغير `STUDIO_USER_QUOTA_BYTES` ما زال يتجاوزها لكل
بيئة. بقية الأرقام افتراضات معلنة تُعرض كحدود حالية لا كوعود.

**حد الطلبات (P1-10)** ليس حصة منتج بل حماية للسعة: يُحسب على نداءات الحساب
المسجّل فقط (هي التي تصل D1 وR2)؛ نداء الضيف يُرفض بـ 401 قبل أي عمل في القاعدة،
و`/api/health` مجاني. القراءات والكتابات في دلوين منفصلين كما في `limitByMethod`
على الموقع. الأرقام أعلى بكثير مما يفعله المحرر نفسه (حفظ تلقائي كل 2.5 ثانية
على الأكثر = OPEN + PUT لكل ملف متغير + COMMIT)، وتتجاوزها 429 مع `Retry-After`
و`code: RATE_LIMITED`، ويعاملها عميل المزامنة كخطأ مؤقت يُعاد.

## طبقة العميل (S5 — `studio/app/project-store.ts` + `project-sync.ts`)

- IndexedDB **مسودة/استرداد أعطال فقط**، بـnamespace لكل مستخدم
  (`user:<id>` / `guest` / `legacy`). سجلات المخزن القديم لا تُتبنى تلقائيًا —
  استيرادها فعل مستخدم صريح.
- خمس حالات مرئية منفصلة: تغييرات غير محفوظة / محفوظ محليًا / جارٍ الرفع /
  متزامن / فشل-أعد المحاولة. «متزامن» لا تظهر إلا بعد 200 للـ COMMIT.
- حفظ debounced مع تخطي المحتوى غير المتغير بالبصمة (لا إعادة رفع كاملة لكل
  حركة)، وretries محدودة بتراجع، و409 يُعرض كتضارب صريح.
- الخروج/تبديل الحساب: `dispose()` يلغي كل المؤقتات ويجهض الرفع الجاري —
  لا يُرفع شيء إلى حساب آخر أبدًا (T5). لوحة «مشاريعي» مفتاحها حساب المستخدم
  فلا يرث حساب لاحق قوائمها أو صورها أو سجلها.
- **عمل الضيف بعد الدخول (P1-09):** الدخول يبدل الـ namespace فقط ولا ينقل
  شيئًا. مسودات `guest` تبقى على الجهاز وتُعرض للمستخدم مع زر صريح «احفظ عملك
  في حسابي» لكل مسودة: يُنشأ مشروع حساب جديد وتُرفع ملفات المسودة كـrevision 1
  (`uploadDraftToAccount`)، وبعد نجاح الـ COMMIT فقط تُنقل المسودة إلى
  `user:<id>` (`adoptGuestDraft`). لا مسار يتبناها تلقائيًا، وفشل الرفع يترك
  المسودة مكانها وينقل المشروع الفارغ إلى السلة.
- **الخروج الصريح:** ورقة تسجيل الخروج تعرض خيارًا غير مفعّل افتراضيًا «احذف
  مسوداتي المحلية من هذا الجهاز أيضًا»؛ عند اختياره يوقف الـ hook كل حفظ معلق
  ثم يحذف مسودات `user:<id>` فقط (`purgeNamespaceDrafts`) — مسودات الضيف
  وحسابات أخرى لا تُمس.
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
  idempotent retries، تنظيف pending (T6)، والأرشفة ليست حذفًا، والسلة
  وانتهاء مدتها، وبقاء النسخة المثبتة عبر كل تشغيل تنظيف، واستعادة نسخة من
  السجل كـhead جديد، والترحيل `0001` على كل المسارات، والحصة 1 GiB — سلوكيًا ضد
  router الـ API.
- `studio/tests/project-lifecycle.test.mjs`: عمل الضيف يبقى بعد الدخول ولا
  يُتبنى إلا بالموافقة، وعزل المسودات عند تبديل الحساب، والحذف الصريح عند
  الخروج.
- `studio/tests/browser-account-switch.mjs` (Chromium ضد بناء محلي، خارج
  `npm test`): دخول A ثم B في نفس المتصفح بلا أي اسم أو صورة أو مسودة أو
  استجابة مخبأة لـA، وتبني عمل الضيف بالنقر فقط، وحذف المسودات عند الخروج.
- **موصول:** cron التنظيف يعمل كل ساعة — handler `scheduled` في
  `studio/worker/index.ts` يستدعي `scheduledCleanup`، والتعبير في
  `studio/wrangler.jsonc` (`triggers.crons`).
- T4 (فتح من جهاز آخر باستعادة كاملة) يتطلب staging HTTPS مكتمل الإعداد —
  انظر نواقص `docs/STUDIO_AUTH.md`.
