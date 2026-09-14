# إصلاح نموذج المنتج والحذف النهائي — Levonis

التاريخ: 2026-09-14. الكود في [PR #7](https://github.com/justrandoomis/Levonis/pull/7)، والمهاجرات السابقة له في [PR #8](https://github.com/justrandoomis/Levonis/pull/8). تم تنفيذ الكود والمهاجرات والاختبارات. **لم تُطبّق المهاجرات أو يُنشر الكود الجديد في الإنتاج، ولم تُنظّف البقايا القديمة.** أدلة الحذف أدناه تخص قاعدة اختبار محلية تعمل فعليًا عبر Cloudflare workerd/D1/R2، وأدلة البقايا القديمة تخص قراءة الإنتاج فقط. هذا التفريق ضروري: اختفاء منتج من الواجهة ليس إثباتًا للحذف.

## 1. سبب خلط Options وAvailability

كان `availability_type` يُخزّن على صف `product_option_values` نفسه، ويُستخدم لتحديد Direct أو Pre-order. لذلك كانت النسخة الفيزيائية الواحدة تحتاج صفين بأسعار ومخزون منفصلين. وكان النقل يعتمد على إعدادات المنتج العامة، فلا توجد علاقة مستقلة لأسعار تنفيذ كل Model. كما كان من الممكن أن تتداخل طريقة الدفع مع اختيار سعر التنفيذ القديم.

الـModel الآن صف واحد. له علاقات تنفيذ مستقلة، والتنفيذ المسبق له علاقات نقل. `Standard/Personal Delivery` تبقى إعدادات إيصال محلي مستقلة، وكذلك Payment. نموذج الإدارة يعرض أسعار النسخة أولًا، ثم Direct ومخزونه، ثم Pre-order وطرقه. المتجر يختار Model ثم Order Type، ويعرض النقل عند Pre-order فقط، ثم الإيصال المحلي والدفع في Checkout.

## 2. مخطط قاعدة البيانات الفعلي

لم نفترض وجود جداول مثل `product_options` أو `product_spec_rows`؛ فُحصت المهاجرات و`sqlite_master` و`PRAGMA table_info/foreign_key_list`.

| الكيان | الجدول/الموضع | أهم القيود والحقول |
|---|---|---|
| المنتج | `products` | أسعار المنتج، defaults، إعدادات الإيصال المحلي |
| مجموعة النسخ | `product_option_groups` | علاقة المنتج الحالية |
| Model | `product_option_values` | نسخة حقيقية واحدة، الاسم وSKU والصورة والأسعار الأساسية |
| التنفيذ | `product_option_fulfillment` | `direct_sale` أو `pre_order`؛ enabled؛ أسعار/adjustments لـRegular/PRIME/PRO/Cost؛ stock/reserved؛ الصورة وSKU؛ lead time |
| نقل الطلب المسبق | `product_option_transports` | `air/sea/land`؛ enabled؛ surcharge؛ أسعار/adjustments لكل فئة؛ lead time |
| توافق IDs القديمة | `product_option_aliases` | old ID → Model + fulfillment؛ snapshot كامل للصف القديم |
| لقطة الاختيار | `cart_items` / `order_items` | `selection_snapshot` مستقل؛ معلومات التنفيذ والتوصيل |
| حذف المنتج | `product_deletion_jobs` | سجل عملية لا يعتمد على وجود المنتج |
| تنظيف الملفات | `media_cleanup_jobs` | pending/retry/done/shared، attempts، error، موعد المحاولة |
| حماية الملفات | `media_cleanup_locks` | يمنع إنشاء مرجع جديد أثناء حذف المفتاح أو بعد حذفه |
| الكاش | `catalog_revision` | جيل الكتالوج المشترك بين نقاط Cloudflare |
| فحص البقايا | `product_orphan_reports` | تقرير محفوظ ومرشحون محددون للتأكيد |
| سجل المخزون التاريخي | `historical_inventory_ledger` | يحفظ السجل قبل حذف علاقات المخزون الحية |

العلاقات الجديدة تستخدم FKs مركبة متوافقة مع المنتج والنسخة و`ON DELETE CASCADE` للبيانات المملوكة. يوجد UNIQUE لكل Model + fulfillment ولكل fulfillment + method. المخزون المحجوز لا يجوز أن يتجاوز المخزون الفعلي. لا يُستخدم CASCADE لحذف الطلبات أو عناصرها أو المحاسبة.

## 3. المهاجرات الجديدة

| Migration | الغرض |
|---|---|
| `0072_model_fulfillment.sql` | جداول التنفيذ والنقل وaliases وحقول لقطات السلة/الطلب |
| `0073_product_history_dependencies.sql` | جعل reviews آمنة بـSET NULL؛ فصل مراجع الكتالوج عن mystery history؛ دعم مخزون fulfillment |
| `0074_product_deletion_jobs.sql` | outbox للحذف والملفات، تقارير orphan، أرشيف المخزون، وحاجز تغيير المنتج |
| `0075_legacy_model_availability.sql` | دمج الصفوف القديمة باستخدام variant_key وحفظ البيانات وإعادة ربط العلاقات |
| `0076_product_media_fences_cache.sql` | حواجز مراجع الملفات وrevision للكاش مع triggers على البيانات المملوكة |

نجح تطبيق جميع المهاجرات مرتين على قاعدة الاختبار: 169 جدولًا، و0 أخطاء `foreign_key_check`. واختُبرت مهاجرة قاعدة ممتلئة بطلبات ومراجعات وmystery allocations ومخزون. هذه المهاجرات لا تنفذ تنظيف البقايا القديمة دون موافقة.

## 4. TXT الجديد وRound trip

الملف الفارغ: [product-model-blank.txt](examples/product-model-blank.txt). المثال القابل للاستيراد: [a1-mini-model-fulfillment.txt](examples/a1-mini-model-fulfillment.txt).

```ini
options.1.id=a1-mini
options.1.name_en=A1 mini
options.1.regular_price_iqd=499000
options.1.direct.enabled=true
options.1.direct.regular_price_iqd=549000
options.1.direct.stock=5
options.1.preorder.enabled=true
options.1.preorder.regular_price_iqd=499000
options.1.preorder.transports.1.method=air
options.1.preorder.transports.1.enabled=true
options.1.preorder.transports.1.surcharge_iqd=80000
options.1.preorder.transports.1.lead_time_min_days=7
options.1.preorder.transports.1.lead_time_max_days=12
transports.1.method=air
transports.1.enabled=true
transports.1.surcharge_iqd=50000
standard_delivery_enabled=true
standard_delivery_quantity_step=2
standard_delivery_fee_iqd=10000
personal_delivery_enabled=true
personal_delivery_quantity_step=1
personal_delivery_fee_iqd=25000
```

تُدعم الحقول المناظرة لـPRIME/PRO/Cost والأسعار الثابتة وadjustments وlead time. `transports.N` على المنتج Defaults فقط. لا يصدّر القالب `availability_type` ولا ينشئه ProductForm.

التصدير الكامل يضم الملفات الداخلية في manifest معلّق داخل TXT مع MIME والحجم وSHA-256. هذا ضروري لأن TXT يحوي روابط فقط لن يستطيع إعادة الصور بعد حذفها من R2. بعد الحذف، يعيد الاستيراد بايتات الصور بمفاتيح جديدة آمنة ويحدّث علاقاتها، ويحافظ على الروابط الخارجية. تُفحص سلامة البيانات قبل الكتابة. استيراد فاشل لا يترك منتجًا جزئيًا؛ الملفات المؤقتة محمية بمهلة استرداد وتنظيف عبر outbox.

**حد التصدير المحمول الحالي 24 MiB من ملفات R2 لكل TXT.** يرفض التصدير الكامل ما يتجاوزه برسالة واضحة؛ لا يسلّم نسخة ناقصة بصمت. `include_media=false` مخصص لتصدير البيانات للتحرير، وليس نسخة صور قابلة للاسترداد بعد الحذف.

اختبار API نفّذ: Import → Export → Permanent Delete → Import نفس TXT → Delete → Import مرة أخرى. عاد Model والتسعير والتنفيذ والنقل والإيصال والصور والمواصفات والضمان ودليل الاستخدام، مع تطابق bytes/hash للصور ومن دون duplicate slug أو child ID أو بصمة import قديمة.

## 5. Pricing Resolver الواحد

`packages/pricing/src/pricing.ts::resolveUnitPrice` هو مصدر الحساب المشترك؛ يستخدمه Worker والمتجر والسلة وCheckout وإنشاء الطلبات ومعاينة الإدارة. الملف `worker/lib/pricing.ts` يعيد تصديره ولا يحتوي معادلة مستقلة.

أولوية السعر: exact transport fixed → exact transport adjustment → Model fulfillment → product transport default / product direct surcharge → Model base → Product base. القيمة الصريحة صفر تُحترم. الـoverride يستبدل fallback ولا يُجمع معه. سعر النقل الثابت يمثل السعر النهائي لذلك المستوى، بينما adjustment فرق على أساس التنفيذ.

تبقى درجات Product وModel وFulfillment وTransport وMembership مستقلة في snapshot. تُطبق سياسة العضوية الفعلية من السيرفر. إعفاء PRO من النقل لا يمس فرق Model: 900000 + 200000 + Air المعفى = **1100000**. اختيار النقد لا يحوّل التنفيذ المسبق الجديد إلى بيع مباشر. التوافق السعري للمنتجات القديمة التي لا تستخدم البنية الجديدة يبقى متاحًا حتى تحويلها.

## 6. مثال A1 mini

| Model | Pre-order base Regular | Direct Regular | فرق Direct | Air Regular |
|---|---:|---:|---:|---:|
| A1 mini | 499000 | 549000 | 50000 | 579000، باستخدام override +80000 |
| A1 mini Combo | 679000 | 699000 | 20000 | 729000، باستخدام default +50000 |

يحتوي المنتج صفّي Model فقط. لا يتحول Direct أو Pre-order إلى صف Model ثالث أو رابع، وmini Air ليس 629000 لأن default +50000 لم يُضف مرة ثانية.

## 7. مثال Direct + Air + Sea + Land

لـPrinter A ذي قاعدة Pre-order بقيمة 1000000، يمكن ضبط Direct مستقلًا على 1050000 ومخزون 5:

| Order type / Transport | Regular IQD | Lead time |
|---|---:|---|
| Direct، بلا نقل مسبق | 1050000 | من إعداد Direct |
| Pre-order / Sea | 1000000 | 21–28 يومًا |
| Pre-order / Land | 1030000 | 14–21 يومًا |
| Pre-order / Air | 1080000 | 7–12 يومًا |

تم اختبار حالة الثلاث وسائل، override بدل default، الأسعار الثابتة، فروق Direct المختلفة، وفئات العضوية الثلاث. رسوم Standard/Personal تُضاف لاحقًا من تسعير الإيصال المحلي.

## 8. Backward compatibility والتحقق عند الطلب

صفا `a1-mini-preorder` و`a1-mini-direct` ذوا `variant_key=a1-mini` يُدمجان إلى Model واحد. تُنقل أسعار Regular/PRIME/PRO/Cost والمخزون والمحجوز والصورة وSKU وlead time إلى fulfillment، وتُحفظ نسخة الصف القديم في aliases. تُعاد ربط الصور والألوان والسلة والمتغيرات وعلاقات التركيب والمخزون. تُزال أسعار availability المنقولة من قاعدة الصف لتجنب حسابها مرتين. غياب fulfillment قديم لا يفعّل counterpart تلقائيًا.

الدمج يعتمد على variant_key الصريح، ولا يخمّن من تشابه الأسماء. تضارب صفين لنفس Model والتنفيذ يوقف المهاجرة بدل اختيار سعر وفقد الآخر. TXT يقبل الشكل القديم كمدخل توافق ثم يحوّله إلى البنية الجديدة؛ Form يرفض إنشاء availability rows القديمة. فحص الإنتاج الأول وجد 0 صفوف legacy availability و0 مجموعات ملتبسة.

السيرفر يعيد تحميل Model والتنفيذ والنقل والسعر والعضوية والمخزون والمحجوز والإيصال وlead time. اختبارات HTTP أثبتت رفض النسخة أو التنفيذ أو النقل المعطّل، النقل مع Direct، وتجاوز المخزون، وتجاهل final price وmembership المزوّرين من العميل.

لقطة الطلب تحفظ IDs وvariant_key وأسماء المنتج/Model وSKU والصورة والضمان والتنفيذ والنقل والإيصال والعضوية وكل `resolved_*` والمهلة. رسوم الإيصال النهائية توزّع بدقة على عناصر الطلب. قراءة الطلب التاريخي لا تعيد تسعيره من المنتج الحي.

## 9. سبب بقاء بيانات المنتج بعد الحذف

المسار السابق أرشف بعض المنتجات المرتبطة بطلبات إلى `status=hidden`، لذلك بقي صف المنتج وslug وعلاقاته. والحذف الصلب في مسارات أخرى لم يكن يملك cleanup موحدًا لجميع الجداول أو R2 أو الكاش. من الأمثلة الفعلية `price_history` بعلاقة بلا FK. الصور والمواصفات المخزنة داخل JSON لم تكن ممثلة كلها في حذف علاقات الصور فقط. كما أمكن لبصمة TXT سابقة أن تمنع إعادة الاستيراد.

الحذف النهائي أصبح خدمة واحدة تستخدمها endpoints الحذف الصلب، بما فيها bundles والحذف التعويضي لاستيراد جديد فاشل. الأرشفة تبقى عملية مختلفة للتوافق؛ زر **Delete permanently** لا يسمي الأرشفة حذفًا.

## 10. الجداول التي تُنظف فعليًا

يبني `productDependencyGraph` الرسم من schema الفعلي ويضيف العلاقات غير المعلنة التي توجد فعلًا. مجموعة البيانات المملوكة الحالية تشمل 27 جدولًا مع المنتج:

| المجموعة | الجداول |
|---|---|
| Models والتنفيذ | `product_option_transports`, `product_option_fulfillment`, `product_option_aliases`, `product_option_values`, `product_option_groups` |
| ألوان وصور ومتغيرات | `product_color_option_links`, `product_colors`, `product_images`, `product_variants` |
| الكتالوج | `product_catalogs`, `product_facets`, `product_translations`, `price_history` |
| السلة والمفضلة | `cart_bundle_choices`, `cart_items`, `favorites` |
| bundles | `bundle_component_choices`, `bundle_components`, `bundle_config`, `bundle_items` |
| العروض | `mystery_offer_secrets`, `mystery_offers`, `mystery_pool_entries`, `offer_limits`, `offer_windows` |
| المخزون والمنتج | `inventory_ledger`, `products` |

المواصفات ومجموعاتها وصفوفها والضمان وlabels وcontent blocks وusage guide وproduct transport defaults وخيارات الدفع والإيصال موجودة في JSON المنتج الحالي؛ حذف `products` يزيلها. لا توجد جداول مستقلة لكل اسم افتراضي ورد في الطلب. تُنظف metadata `file_objects` بعد نجاح حذف الملف، أو تُفصل ملكيتها إذا بقي مستخدم آخر. تُحرر بصمة TXT السابقة لإتاحة إعادة الاستيراد. لا توجد جداول حديثة/compare/draft-checkout منفصلة في schema الحالي لندّعي حذفها.

## 11. D1 وR2 وآلية الاسترداد

قبل حذف DB نجمع مفاتيح الوسائط من الصور والخيارات والألوان والمحتوى والدليل والملفات وJSON. داخل D1 batch ذرية: نثبت revision المنتج، ننشئ deletion job وmedia jobs، نحفظ سجل المخزون التاريخي، ننظف العلاقات، ثم نحذف المنتج نفسه. إذا تغيّر المنتج أثناء الجمع، تُرفض العملية بـ409 وتُعاد من بداية سليمة.

بعد نجاح commit فقط تُحذف R2 objects ويؤكد HEAD غيابها. فشل R2 لا يعيد المنتج: تبقى job في retry، وتعيد المهمة المجدولة المحاولة. المفتاح غير الموجود يُعامل كنجاح. الضغط الثاني يعيد `already_deleted=true` بدل 500. عملية الاستيراد لها مهلة تنظيف كي لا تتسابق الكتابة المؤقتة مع cleanup.

Endpoints: `DELETE /api/admin/products/:id/permanent` أو `DELETE /api/admin/products/:id?permanent=true`؛ ومسار الإدارة الحالي `products-v2/:id?permanent=true`. الاستجابة تشمل `product_deleted`, `rows_deleted_by_table`, `r2_objects_deleted`, `r2_objects_shared_skipped`, `r2_cleanup_pending`, `cache_keys_invalidated`.

التأكيد في الإدارة يوضح: «سيتم حذف المنتج وبياناته وصوره الداخلية نهائيًا. الطلبات السابقة لن تُحذف.» ويطلب كتابة DELETE. يختفي المنتج من القائمة مباشرة بعد نجاح السيرفر، مع إظهار انتظار تنظيف الملفات إن لزم.

## 12. حماية الملفات المشتركة والكاش

الروابط الخارجية لا تُحذف. لكل مفتاح R2 داخلي يُفحص استعماله في الجداول الحالية وفي snapshots التاريخية. حذف A الذي يشارك B صورةً يزيل علاقة A ويحتفظ بالملف؛ حذف B الأخير يزيله إن لم يبق مستهلك تاريخي. تُفحص المراجع مرة أخرى عند retry. locks وtriggers يمنعان إضافة مرجع أثناء حذف المفتاح، بما فيه رابط `/files/key?version=...`.

تتغير `catalog_revision` داخل transaction. يقرأ Gateway الجيل من D1 عند الوصول إلى المسارات القابلة للكاش، ويستخدمه في cache key لجميع اللغات والاستعلامات ونقاط الشبكة. تصبح النتائج القديمة غير قابلة للوصول فور commit؛ عند تعذر قراءة الجيل يتجاوز الكاش. هناك حذف مباشر للمسارات المعروفة أيضًا. اختُبرت نقطتا edge ونتائج slug/list/search، وفشل قراءة revision. لم يوجد binding فعّال لكاش منتجات KV حتى نزعم تنظيف مفاتيحه. مسار `/files/products/*` يستخدم no-store؛ لا يمكن سحب بايتات سبق للعميل تنزيلها من جهازه.

## 13. حماية Order history

لا تُحذف `orders` أو `order_items` أو الوحدات والضمانات التاريخية والفواتير والمحاسبة. reviews تستخدم SET NULL، وmystery allocations تفصل IDs الكتالوج التاريخية عن وجوده الحي. سجل المخزون يُنسخ إلى جدول تاريخي قبل حذف العلاقات المملوكة. صورة يستخدمها snapshot طلب قديم ليست orphan، ولذلك تبقى متاحة. الاحتفاظ بهذا الملف المقصود لا يناقض حذف الملفات المملوكة التي لم يعد لها مستخدم.

## 14. Orphan scanner وCleanup المقيّد بالتقرير

`worker/lib/productOrphans.ts::scanProductOrphans()` و`POST /api/admin/products/maintenance/orphans` يبدآن بفحص dry-run. يفحص الرسم الفعلي وFKs والصفوف ذات الأب المفقود، ومفاتيح DB مقابل R2 public/private والروابط المتدلية. تُحفظ IDs وبصمات المرشحين في scan محدد.

التنظيف يتطلب `scan_id` وتأكيدًا حرفيًا `CLEANUP_REVIEWED_ORPHANS` مع `dry_run=false`. لا يحذف صفًا تغيّر أو أصبح سليمًا منذ التقرير، ولا ملفًا اكتسب مرجعًا جديدًا. يستخدم outbox نفسه ثم يبطل الكاش. الفحص التفاعلي محدود بحجم دفعة؛ يصرّح `complete=false` إذا بلغ الحد، ويرفض اعتبار التقرير الناقص مسحًا شاملًا. السكربت القرائي للإنتاج يتصفح الصفوف وR2 pages كاملًا ويرفض pagination غير المكتمل.

## 15. نتيجة DRY RUN للبقايا القديمة في الإنتاج

القراءة أُجريت بتاريخ `2026-09-14T10:33:24.817Z` على `levonis-iq.com`، Worker الفعلي `levonis-staging`، binding `DB` وR2 المرتبطة به. [سجل التشغيل](https://github.com/justrandoomis/Levonis/actions/runs/34833708689)، والبيانات الدقيقة [product-orphans-2026-09-14.json](verification/product-orphans-2026-09-14.json).

| Table / نتيجة | Orphan rows | R2 objects | Bytes |
|---|---:|---:|---:|
| `price_history` | 1 | 0 | 0 |
| بقية 22 جدولًا مفحوصًا، مفصلة في JSON | 0 | 0 | 0 |
| مجموع ملفات R2 غير المستخدمة | — | 0 | 0 |
| Dangling DB media refs | 0 | — | — |

`complete=true` و`destructive_actions=0`. **الصف القديم في price_history لم يُحذف.** هذا التقرير الأول يحصي الصفوف المفقود أباؤها؛ المنتجات المخفية التي ما زال لها صف أب لا تُسمى orphan. أُعيد الفحص الموسع عند `2026-09-14T11:28:21.402Z`، وأكد النتيجة نفسها، ووجد **0 منتجات مخفية تحمل سجل عملية `product_v2.archive`**. هذا هو نطاق التعرف على الأرشفة؛ لا يُعد كل منتج مخفي محذوفًا. التقرير الموسع: [product-orphans-2026-09-14-extended.json](verification/product-orphans-2026-09-14-extended.json)، و[تشغيله](https://github.com/justrandoomis/Levonis/actions/runs/34838325839). بقي `destructive_actions=0`.

## 16. نتائج التحقق

| التحقق | النتيجة |
|---|---|
| Root tests | 2563 ناجحًا |
| Workspace/service tests | 363 ناجحًا في 49 ملفًا |
| `npm run check` | نجح: root/Worker/tests/workspaces/architecture/Studio typecheck وeslint |
| ESLint | 0 errors؛ 116 warnings سابقة |
| `npm run build` | نجح، بما فيه asset/live-marker gates |
| جميع migrations مرتين | نجحت؛ 169 جدولًا؛ 0 FK violations |
| D1/R2 عبر workerd المحلي | نجح؛ 20 ملفًا داخليًا حُذفت؛ 0 ملفات مملوكة متبقية |
| نموذج الحذف الكامل | 2 Models، 3 ألوان، 5 صور، 39 مواصفة، 2 ضمان، 5 content blocks، 10 usage steps، نقل وإيصال وسلة ومفضلة |
| Shared image | A يُحذف والملف يبقى لـB؛ حذف B الأخير يزيله |
| R2 failure | DB product=0 أثناء الفشل؛ pending=1 ثم 0 بعد retry |
| Old orphans | اكتشاف صفوف option/image وملف غير مستخدم؛ لا حذف في dry-run؛ cleanup بعد تأكيد التقرير فقط |
| Checkout | إعادة تحقق سيرفرية، stock reservation، أسعار/عضويات عميل مزورة، snapshot والمهلة |
| Cache | بيانات كاش قديمة في نقطتي edge لا تعيد ghost product بعد تبديل الجيل |
| Export/Delete/Import | نجح عبر APIs؛ الصور عادت بالبايتات نفسها؛ نفس TXT أُعيد استخدامه دون تضارب |

دليل استعلامات D1 وعمليات R2 المحلية: [product-lifecycle-workerd.json](verification/product-lifecycle-workerd.json). يمكن إعادة إنتاجه بـ`node --import tsx scripts/verify-product-lifecycle.mjs`. أثناء هذا التحقق ظهر حد compound SELECT في D1 الحقيقي؛ عُدّل فحص المراجع إلى استعلامات مستقلة محدودة التوازي ثم أُعيد التحقق بنجاح.

## 17. التأكيد الصريح لنموذج المنتج

**Pre-order / Direct / Air / Sea / Land لا يتم إنشاؤها كـProduct Options.** خيارات المنتج هي النسخ الحقيقية فقط، والتنفيذ والنقل والإيصال المحلي كيانات مستقلة.

## 18. التأكيد الصريح للحذف وحدوده التشغيلية

**Permanent Delete المثبت في اختبار D1/R2 يترك 0 product rows و0 child relations مملوكة و0 orphan owned R2 files، مع الحفاظ على historical orders.** استعلم الاختبار عن جميع الجداول الـ27 بعد الحذف، وأكد غياب الملفات وبقاء order وorder item، ثم اختبر idempotency والمشاركة وإعادة المحاولة.

عند تعطل R2 تكون صفوف المنتج والعلاقات صفرًا فور commit، لكن الملفات تنتظر retry حتى يعود عددها إلى صفر؛ لذلك لا تُرجع API نجاحًا كاذبًا لجزء R2، بل العدد الحقيقي في `r2_cleanup_pending`. الملفات المشتركة أو المستخدمة تاريخيًا تبقى عمدًا.

هذه نتيجة تنفيذ واختبار؛ لا تعني أن الإنتاج نُشر عليه الإصلاح بالفعل. وثيقة المشروع `docs/architecture/01-TARGET.md` تشترط بوابة المالك وتسلسل migration قبل نشر الكود الذي يعتمد عليها بسبب تكامل Cloudflare Git. يجب تطبيق المهاجرات قبل نشر Worker وGateway وواجهة الإدارة. تنظيف البقايا القديمة خطوة مستقلة لا تُنفّذ إلا بعد موافقة المستخدم على التقرير المحدد.
