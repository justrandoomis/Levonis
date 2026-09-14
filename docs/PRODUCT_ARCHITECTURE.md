# Levonis — فصل النماذج والتوفر، والحذف الدائم

التنفيذ والتحقق المحلي: 14 سبتمبر 2026. هذه الوثيقة تصف التغييرات في هذا الفرع؛ لم تُنشر إلى البيئة الحية، ولم تُطبّق migrations أو عملية تنظيف على بياناتها. أرقام D1 وR2 أدناه نتائج اختبارات محلية موضّحة المصدر، وليست تقريرًا عن بيانات الإنتاج.

**1. سبب خلط Options وAvailability**

كان `availability_type` موجودًا على `product_option_values`، وكانت واجهة المنتج تجمع الصفوف بواسطة `variant_key` لتبدو كنموذج واحد. لكن الهوية والأسعار والمخزون بقيت موزعة بين option مباشر وoption مسبق. وكانت عمولة النقل وفرق البيع المباشر على مستوى المنتج غير كافيتين لفروق مستقلة بين النماذج. أزيل هذا الاعتماد من كتابة ProductForm وTXT ومن اختيار نموذج الواجهة.

**2. مخطط البيانات الجديد**

استخدم التنفيذ الجداول الموجودة فعلًا؛ جدول النماذج اسمه `product_option_values`، وليس `product_options`.

| الجدول / البنية | المسؤولية والقيود |
| --- | --- |
| `products` | السعر الأساسي، direct surcharge الافتراضي، transport defaults، Local Delivery والمحتوى العام |
| `product_option_groups` / `product_option_values` | نماذج المنتج الحقيقية وأسعارها وصورها وأسماؤها وSKU |
| `product_option_fulfillment` | صف فريد لكل product + option + `direct_sale` أو `pre_order`؛ enabled، أسعار وتعديلات Regular/PRIME/PRO/Cost، stock/reserved، SKU/image، lead time |
| `product_option_transports` | صف فريد لكل fulfillment + air/sea/land؛ enabled، surcharge، أسعار وتعديلات العضويات، lead time |
| `product_option_aliases` | ربط هوية option القديمة بالنموذج والتنفيذ الصحيحين، مع snapshot كامل للقيم القديمة |
| `cart_items` | fulfillment مستقل يدخل في هوية السطر، Local Delivery وselection snapshot |
| `order_items` | `selection_snapshot` مستقل بجانب snapshots الاسم والصورة والسعر والضمان الموجودة |

الجداول الجديدة تملك مفاتيح أجنبية فعلية، بما فيها مفاتيح مركبة تمنع ربط fulfillment أو transport بنموذج منتج آخر، و`ON DELETE CASCADE` للبيانات المملوكة. لا يوجد cascade من المنتج إلى الطلبات أو الفواتير.

`NULL` يعني الوراثة، و`0` override صريح. غياب قائمة نقل على النموذج يرث قائمة المنتج؛ وجود قائمة نموذج يحدد طرقه، والحقول غير المحددة داخل الطريقة ترث defaults لتلك الطريقة.

**3. Migrations**

| الملف | ما يغيّره |
| --- | --- |
| `0072_model_fulfillment.sql` | fulfillment، transports، aliases، snapshots، هوية سلة مستقلة لكل رحلة، وحماية الحجز عند تعديل المخزون |
| `0073_product_history_dependencies.sql` | مراجعات المنتج تستخدم SET NULL؛ حفظ review rewards وmystery allocation history؛ دعم fulfillment في inventory ledger |
| `0074_product_deletion_jobs.sql` | سجل الحذف، outbox لتنظيف الوسائط، تقارير orphan، وأرشيف inventory ledger التاريخي |
| `0075_legacy_model_availability.sql` | دمج صفوف availability القديمة مع نقل العلاقات والسلة والحجوزات دون حذف تاريخ الطلبات |
| `0076_product_media_fences_cache.sql` | رقم مراجعة مركزي للكاش، وقفل مفاتيح الوسائط أثناء وبعد التنظيف |
| `0077_cart_fulfillment_identity.sql` | إكمال backfill لهوية السلة وإعادة إنشاء فهرسها بالشكل الصحيح |

جميع ملفات الترحيل الـ75 الموجودة في المستودع، ومنها الملفات الستة الجديدة، طُبّقت على D1 المحلي الأصلي. الترقيم يصل إلى 77 لأن التسلسل الموجود يتضمن فجوات. `PRAGMA foreign_key_check` أعاد صفر مخالفات. اختبارات إضافية بدأت بقاعدة ممتلئة قبل 0072 للتحقق من نقل البيانات القديمة.

قبل التطبيق الحي يلزم التحقق من bindings الفعلية، ونسخة احتياطية، وإيقاف كتابة المنتجات أثناء التحويل، ومراجعة حالات `variant_key + availability_type` المكررة. أوقف الترحيل عند الحالة الملتبسة بدل إسقاط أسعار أو حجوزات. لا تفترض اسم قاعدة البيانات من اسم environment؛ إعدادات النشر الموجودة تستعمل أسماء تاريخية تحتاج مطابقة الهدف الفعلي.

**4. TXT schema**

القالب الفارغ: [product-blank.txt](examples/product-blank.txt). أمثلة قابلة للاستيراد ومختبرة: [A1 mini](examples/a1-mini-fulfillment.txt) و[Printer A](examples/printer-a-fulfillment.txt).

```text
options.1.id=a1-mini
options.1.name_en=A1 mini
options.1.regular_price_iqd=499000
options.1.pro_price_iqd=449000
options.1.direct.enabled=true
options.1.direct.regular_price_iqd=549000
options.1.direct.pro_price_iqd=449000
options.1.direct.stock=5
options.1.preorder.enabled=true
options.1.preorder.regular_price_iqd=499000
options.1.preorder.transports.1.method=air
options.1.preorder.transports.1.enabled=true
options.1.preorder.transports.1.surcharge_iqd=80000
options.1.preorder.transports.1.lead_time_min_days=7
options.1.preorder.transports.1.lead_time_max_days=12
```

أسعار `prime_price_iqd` و`pro_price_iqd`، وتعديلات `regular_adjust_iqd` و`prime_adjust_iqd` و`pro_adjust_iqd`، متاحة على المستويات الجديدة. تبقى `transports.N.*` defaults على المنتج. وتبقى `standard_delivery_enabled/quantity_step/fee_iqd` و`personal_delivery_enabled/quantity_step/fee_iqd` كما هي للتوصيل المحلي فقط.

التصدير يضم bytes الوسائط الداخلية مع SHA-256 في تعليقات `levonis_asset_v1`، حتى يظل Export → Delete → Import ممكنًا بعد حذف R2 فعلًا. الاستيراد يستعيدها بمفاتيح جديدة عند الحاجة؛ الروابط الخارجية تبقى روابط ولا تُجلب عبر السيرفر. الحد المعلن للوسائط المضمّنة 24 MiB، ولـJSON الطلب 48 MiB. الملف الذي يشير إلى ملف داخلي مفقود دون إرفاق bytes يرجع `MEDIA_MISSING`؛ لا يدّعي استعادة ملف غير موجود. المرفقات الخاصة لا تدخل في تصدير TXT العام.

وضع draft/create ينشئ product UUID جديدًا. `product_id` في وضع update يستهدف منتجًا موجودًا؛ حذف المنتج لا يجعل الاستيراد يعيد استخدام UUID القديم تلقائيًا.

**5. Pricing Resolver وCheckout**

المصدر المركزي هو `resolveUnitPrice` في `packages/pricing/src/pricing.ts`، وتدعمه قواعد `fulfillment.ts`. يستعمله عرض المنتج، والسلة، وcheckout، وAdmin preview، وإنشاء الطلب.

ينطلق من Product base ثم Model base/delta، ثم fulfillment، ثم transport. في المستوى المحدد يتقدم fixed price على adjustment؛ وoverride الخاص يتقدم على default المقابل ويحل محله. Product direct surcharge يستخدم فقط عندما لا يحدد النموذج فرقًا أو سعرًا مباشرًا خاصًا. رسوم Local Delivery والضمان محفوظة كمكونات مستقلة.

مثال defaults: Air على المنتج +50,000، وعلى Combo +80,000؛ المطبق على Combo هو +80,000 فقط. ومثال إعفاء PRO: base 900,000 + Combo 200,000 + Air المعفى 0 = **1,100,000**. لا تُحذف زيادة النموذج عند إعفاء النقل.

السيرفر يعيد تحديد العضوية الصالحة والأسعار والتوفر والمخزون والحجوزات والنقل والتوصيل وlead time. السعر النهائي المرسل من الواجهة لا يستخدم لتسعير الطلب. الاختبارات تغطي السعر المزور وتغيير التوفر والمخزون بين الاختيار وإنشاء الطلب.

يحفظ `selection_snapshot`: product_id، option_id، variant_key، fulfillment_type، transport_method، local_delivery_method، membership_tier، resolved_product_base، resolved_option_delta، resolved_fulfillment_delta، resolved_transport_delta، resolved_membership_adjustment، resolved_delivery_fee، resolved_final_price، وlead_time. مكونات السلعة في snapshot للوحدة؛ عند الطلب يضاف عدد الوحدات ومجموع السطر وحصته من التوصيل صراحة، بحيث `resolved_final_price` هو إجمالي السطر مع رسومه. snapshots الضمان والصورة والخصومات القائمة تبقى محفوظة كذلك.

**6. مثال A1 mini**

أسعار توضيحية في ملف المثال، بالدينار العراقي وقبل التوصيل والضمان:

| Model | Pre-order base Regular | Direct Regular | فرق Direct | Air Regular |
| --- | ---: | ---: | ---: | ---: |
| A1 mini | 499,000 | 549,000 | 50,000 | 549,000، يستخدم default +50,000 |
| A1 mini Combo | 679,000 | 699,000 | 20,000 | 759,000، يستخدم override +80,000 |

يوجد صفان للنماذج وأربعة صفوف fulfillment؛ لا يوجد نموذج اسمه Direct أو Pre-order.

**7. مثال Direct + Air + Sea + Land**

| اختيار Printer A | Regular | Lead time |
| --- | ---: | --- |
| Direct | 1,050,000 | مخزون مباشر مستقل: 5 |
| Pre-order + Sea | 1,000,000 | 21–28 يومًا |
| Pre-order + Land | 1,030,000 | 14–21 يومًا |
| Pre-order + Air | 1,080,000 | 7–12 يومًا |

ترتيب الاختيار في واجهة المنتج: Model، Order Type، ثم النقل للطلب المسبق. التوصيل المحلي ثم الدفع في رحلة checkout. Direct لا يعرض Air/Sea/Land. ProductForm يعرض النموذج مرة واحدة، وتحته تسعيره ومخزونه المباشر وطلبه المسبق وطرق نقله.

**8. Backward compatibility**

القارئ يقبل `options.N.availability_type` القديم. صفا preorder/direct اللذان يشتركان في `variant_key` يندمجان في نموذج واحد، مع حفظ أسعار العضويات وCost وstock/reserved وlead time وimage وSKU لكل تنفيذ. تحفظ aliases نسخة كاملة من القيم الأصلية، وتنقل روابط الصور والألوان وvariant combinations والسلة والـinventory ledger إلى هوياتها الصحيحة. سجل الطلب القديم لا يعاد تسعيره ولا يغير snapshot الخاص به.

تُستخدم variant labels إن وجدت، وتزال لاحقات التوفر المعروفة عند تحويل أسماء legacy. لا يجري الدمج اعتمادًا على تشابه الاسم وحده. تضارب صفين للتنفيذ نفسه أو اصطدام variant combinations يوقف التحويل ليراجع، ولا يسقط أحدهما. مدخلات legacy تتحول عند الاستيراد؛ الكتابة والتصدير الجديدان لا ينشئان option availability rows.

**9. سبب بقاء المنتج بعد الحذف**

مسار حذف قديم كان يخفي المنتج المرتبط بطلبات، أو يحذف صف المنتج وبعض روابط الكتالوج فقط. لم توجد معاملة تجمع ownership graph، ولا جمع موحد لمفاتيح JSON والصور والعلاقات، ولا outbox لـR2. وظل هناك أكثر من delete handler يمكن أن يعيد السلوك القديم. وحاجز تكرار TXT كان يمكن أن يشير إلى هوية منتج محذوف.

وحّدت المسارات تحت `deleteProductPermanently`. `DELETE /api/admin/products/:id/permanent` و`DELETE /api/admin/products/:id?permanent=true` يرجعان تقريرًا مفصلًا. الطلب المكرر يعيد `already_deleted=true` ويتيح استكمال cleanup، دون 500 بسبب غياب المنتج. الواجهة تطلب تأكيدًا واضحًا ثم كتابة DELETE، وتزيل المنتج من القائمة بعد نجاح العملية مباشرة.

**10. الجداول والعلاقات التي تُنظف**

بُنيت خريطة الاعتماد من `sqlite_master` و`PRAGMA table_info/foreign_key_list` في المخطط الفعلي، مع تعريف الروابط polymorphic غير المقيدة. ترتيب التنظيف يتبع جميع الآباء، بما في ذلك المفاتيح المركبة والـgrandchildren.

| المجموعة | الجداول الحالية |
| --- | --- |
| النماذج والتوفر | `product_option_groups`, `product_option_values`, `product_option_fulfillment`, `product_option_transports`, `product_option_aliases` |
| الألوان والصور والمتغيرات | `product_colors`, `product_color_option_links`, `product_images`, `product_variants` |
| المحتوى والكتالوج | `product_translations`, `product_catalogs`, `product_facets`, `price_history` |
| السلة والتفضيلات | `cart_items`, `cart_bundle_choices`, `favorites` |
| الباقات | `bundle_items`, `bundle_config`, `bundle_components`, `bundle_component_choices` |
| العروض | `mystery_offers`, `mystery_offer_secrets`, `mystery_pool_entries`, `offer_windows`, `offer_limits` |
| المخزون | `inventory_ledger`، بعد نقل نسخه إلى أرشيف التاريخ |
| المنتج نفسه | `products` |

المجموع **27 جدولًا بما فيها products**. Specs وwarranty وcontent blocks وusage guide وlabels وproduct transports وdelivery options موجودة في JSON داخل صف المنتج في المخطط الحالي؛ حذف ذلك الصف يحذفها. لا توجد جداول منفصلة بأسمائها المفترضة في الطلب، ولا KV/search index مستقل في bindings التي فُحصت. الصور الداخلية وmetadata الخاصة بها تُعالج بالآلية التالية. تنظيف بصمات استيراد `rate_limits` يمنع إعادة نتيجة هوية قديمة.

الباقات التي تستعمل المنتج المحذوف تُخفى حتى لا تتحول بصمت إلى باقة ناقصة. لا تُحذف منتجاتها الأخرى. سجل الحذف والـoutbox وسجلات التدقيق والتاريخ تبقى عمدًا؛ احتفاظها بالمعرّف التاريخي لا يعني بقاء صف حي أو علاقة منتج معلّقة.

**11. R2 cleanup وatomicity**

تُجمع مفاتيح الوسائط قبل حذف صفوفها. ثم تنفذ D1 batch ذرية: التحقق من revision والمنتج، إنشاء deletion/outbox jobs، أرشفة ledger، حذف العلاقات من الأبناء إلى الآباء، وحذف products. أي تعديل متزامن خلال جمع المفاتيح يبطل batch قبل لمس R2.

بعد نجاح المعاملة تُنفذ حذف ملفات R2، ثم HEAD للتحقق من اختفائها. الفشل يبقي `pending/retry` مع الخطأ والمحاولات؛ cron يستكملها، ولا يعيد المنتج إلى D1. القفل يمنع إضافة مراجع جديدة لمفتاح قيد الحذف، ويبقى tombstone يمنع إحياء رابط حُذف. DELETE لملف غير موجود آمن عند إعادة المحاولة.

الحذف يعالج نسخ المفتاح في public/private/legacy buckets حتى لا يعيد fallback تقديم نسخة قديمة. تملك العملية الواحدة حدًا للعمل المتزامن؛ تعرض `r2_cleanup_pending` صراحة ويتولى worker المجدول الباقي.

**12. حماية الملفات المشتركة والكاش**

قبل كل حذف R2 يعاد فحص المراجع الحية، بما فيها snapshots التاريخية وJSON. `file_objects` مجرد metadata ولا يعتبر مستهلكًا. إذا بقي مستهلك، تحذف علاقة المنتج فقط ويصبح job `shared`. اختبار A/B يثبت بقاء الملف بعد A وحذفه بعد B. روابط المواقع الخارجية لا تتحول إلى R2 keys.

جميع تغييرات كتالوج المنتج ترفع `catalog_revision` في D1. gateway يقرأ revision عبر مسار غير مخزن في الكاش قبل استخدام cache المنتجات/البحث/القوائم/الباقات/الملفات، ويضعه في مفتاح التخزين. بذلك تصبح المفاتيح القديمة غير قابلة للوصول في جميع نقاط Cloudflare، حتى لو لم يمكن مسحها فعليًا من POP آخر. اختبار بمخزنين منفصلين يثبت عدم إعادة ghost product. تُمسح مفاتيح Cache API المحلية المعروفة أيضًا، وتستخدم ملفات المنتج `no-store` للمتصفح. يجب نشر core وgateway معًا لتفعيل هذه السياسة في الخدمة الحية.

**13. حماية Order history**

`order_items` وسجلات وحداته والفواتير والضمان والمحاسبة لا تدخل ownership cascade. يبقى product_id التاريخي حيث لا توجد live FK، وتستخدم المراجعات `ON DELETE SET NULL`. أزيل اعتماد mystery allocation التاريخي على product/pool entry الحي مع إبقاء snapshot والعلاقات التاريخية الضرورية.

الاسم والنموذج والسعر والصورة والتنفيذ والنقل والضمان محفوظة في snapshots. ملف داخلي تستخدمه صورة طلب سابق يبقى في R2؛ إنه ملف مستخدم تاريخيًا وليس orphan يجب حذفه. اختبارات populated migration والحذف تثبت بقاء الطلب وreview reward وصورة الطلب.

**14. Orphan scanner**

`scanProductOrphans()` يفحص missing product والآباء الوسيطين والمفاتيح المركبة، ويقارن DB media references مع R2. يرجع table/orphan_rows، orphan_r2_files مع الحجم، dangling_db_media_refs، والمجموع بالبايت. `dry_run=true` لا يحذف شيئًا، ويحفظ candidate set للمراجعة.

التنظيف يتطلب `scan_id` لتقرير مكتمل و`confirm=CLEANUP_REVIEWED_ORPHANS`. يعاد التحقق من fingerprint لكل صف ومن أنه ما زال orphan، ومن مشاركة كل ملف قبل حذفه. الملفات المكتسبة حديثًا أو المراجع الجديدة لا تُحذف. لا تدخل وسائط المستخدمين الخاصة غير التابعة للمنتجات في قائمة التنظيف.

التنفيذ محدود افتراضيًا بـ10,000 عنصر R2 و10,000 orphan row لكل جدول؛ عندما يتجاوز المسح الحد يرجع `complete=false` ويرفض التنظيف. هذا ليس تقريرًا شاملًا لكميات أكبر؛ يلزم توسيع المسح إلى دفعات في تلك الحالة قبل السماح بتنظيفها. سعة D1 وحجم التقرير وحدود الطلب تظل قيود تشغيل فعلية.

عميل الصيانة: `node scripts/product-orphans.mjs --help`. بعد نشر الكود وتوفير جلسة Admin مخولة في `LEVONIS_ADMIN_SESSION`، الأمر التالي يجري **dry-run فقط**:

```sh
node scripts/product-orphans.mjs --origin https://levonis-iq.com --output product-orphans-dry-run.json
```

لا تنفّذ مسار `--reviewed ... --confirm ...` قبل عرض التقرير الفعلي والحصول على تأكيد المستخدم. لم يُنفّذ هذا المسار على البيئة الحية خلال هذا العمل.

**15. نتائج dry-run للبقايا القديمة**

لم تتوفر جلسة Admin أو اتصال D1/R2 مخول للبيئة الحية، ولم تُنشر endpoints الجديدة هناك. لذلك أعداد البقايا الحقيقية **غير مقاسة**. لا يوجد تقرير إنتاج مزعوم ولا cleanup إنتاج.

هذه نتيجة fixture محلية أنشأت بقايا قديمة عمدًا، وسجلت التقرير قبل تنظيف fixture فقط:

| Table / Storage | Orphan rows / Objects | Bytes |
| --- | ---: | ---: |
| product_option_groups | 1 | — |
| product_option_values | 1 | — |
| product_colors | 1 | — |
| product_color_option_links | 1 | — |
| product_images | 1 | — |
| بقية جداول graph | 0 | — |
| R2 fixture | 1 | 3 |

الدليل: [orphan-dry-run-fixture.json](evidence/product-architecture/orphan-dry-run-fixture.json). وفحص native D1/R2 المحلي وجد ملف R2 غير مستخدم حجمه 3 bytes؛ native D1 رفض أصلًا إدخال orphan image بمفتاح أجنبي. دليله: [native-orphan-dry-run.json](evidence/product-architecture/native-orphan-dry-run.json).

**16. نتائج الاختبارات والفحوص**

الأرقام والأوامر النهائية مسجلة في [verification.json](evidence/product-architecture/verification.json). الاختبارات والفحوص التي تتعامل مع HTTP جرت مع preload يمنع الشبكات الخارجية؛ الخدمات الخارجية في الاختبارات مستبدلة بـfixtures.

| الفحص النهائي | النتيجة |
| --- | --- |
| Typecheck | نجح للواجهة وworker والاختبارات و10 workspace/probe projects |
| اختبارات الجذر | 2,567 ناجحًا، صفر فشل أو تخطٍّ |
| اختبارات workspaces | 362 ناجحًا، صفر فشل أو تخطٍّ |
| المجموع | **2,929 اختبارًا ناجحًا** |
| ESLint | exit 0، صفر أخطاء، 116 تحذيرًا |
| Build | exit 0؛ Vite وasset headers وفحص live markers نجحت |
| native D1/R2 | exit 0؛ 75 migrations، صفر FK violations، حذف وإعادة استيراد ناجحان |

الجولة النهائية الكاملة استخدمت نفس ملفات root وworkspaces التي يستدعيها `test:unit`، مع `--test-concurrency=6` وسجل خروج مستقل لكل مجموعة؛ الجولة الافتراضية السابقة توقفت دون ملخص ولم تُحتسب ضمن النتائج.

اختبارات التغيير تشمل فصل النموذج/التنفيذ، أسعار العضويات وPRO waiver، override صفر، النقل والـlead time، المخزون والتحقق في checkout، ترحيل legacy ممتلئ، حذف graph كامل، shared images، فشل R2 وإعادة المحاولة، فشل D1 والكتابة المتزامنة، orphan dry-run/confirmation، حماية historical images، وحذف نسخ buckets القديمة.

Fixture دورة المنتج الكاملة تتضمن 2 models، 3 colors، 5 images، 39 specs، 2 warranty plans، 5 content blocks، 10 usage steps، 3 transport methods لكل نموذج، Local Delivery، cart وorder history. التصدير ثم الحذف ثم استيراد التصدير أعاد البنية والأسعار والوسائط بمفاتيح جديدة. واختبار منفصل أعاد استيراد **TXT نفسه حرفيًا** بعد الحذف دون duplicate slug/ID/option.

الدليل على Cloudflare workerd مع bindings D1/R2 الأصلية محليًا: [native-d1-r2.json](evidence/product-architecture/native-d1-r2.json). كشفت هذه الطبقة حدود compound SELECT في D1؛ عُدّل ترحيل suffixes إلى VALUES وفحص مراجع الصور إلى EXISTS، ثم نجحت الدورة كاملة. الدليل التفصيلي للمحتوى والعلاقات: [lifecycle.json](evidence/product-architecture/lifecycle.json).

لإعادة الفحوص من جذر المستودع، اضبط `NODE_OPTIONS` ليحمّل المسار المطلق لـ`tests/fixtures/offline.cjs` ثم شغّل:

```sh
npx --no-install tsc --noEmit
npx --no-install tsc --noEmit -p worker/tsconfig.json
npx --no-install tsc --noEmit -p tests/tsconfig.json
npm run check:workspaces
npm run test:unit
npm run lint
npm run build
node --import tsx scripts/verify-product-architecture.ts
```

السكربت الأخير يحتاج Python 3 وMiniflare/esbuild الموجودة ضمن أدوات المشروع، ويشغّل fixture worker على localhost فقط، دون نشر أو وصول لحسابات Cloudflare.

**17. تأكيد فصل المفاهيم**

**Pre-order / Direct / Air / Sea / Land لا تُنشأ كـProduct Options بواسطة الصيغة الجديدة أو ProductForm.** النماذج الحقيقية وحدها هي options؛ التوفر والنقل علاقات منفصلة. صيغة legacy مقبولة للتحويل، ولا تُعاد كتابتها كخيارات توفر.

**18. تأكيد الحذف وما أثبته التنفيذ**

في دورة native D1/R2 المحلية، أثبتت استعلامات ما بعد الحذف: **0 product rows، و0 child relations في الجداول الـ27**. فحص R2 أثبت **0 ملفات داخلية مملوكة غير مستخدمة متبقية** بعد اكتمال jobs الخمسة، و`r2_cleanup_pending=0`. بقي order item التاريخي، ونجح استيراد التصدير مجددًا مع UUID جديد و5 ملفات مستعادة، دون مخالفات FK. انتقل cache generation من 24 إلى 57.

عند فشل R2 تكون هذه النتيجة النهائية مؤجلة حتى اكتمال retry؛ API يعلن العدد المتبقي ولا يدّعي أن الملفات انتهت. الملفات المشتركة أو المستخدمة في التاريخ تُحفظ. **لم يُثبت صفر البقايا في الإنتاج بعد**: ذلك يتطلب نشر التغيير، وإجراء dry-run الفعلي وعرضه، ثم تأكيد منفصل قبل تنظيف البقايا القديمة. نجاح إخفاء المنتج من الواجهة وحده لم يُستخدم دليلًا على صحة الحذف.
