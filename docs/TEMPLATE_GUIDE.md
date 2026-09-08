# دليل تعبئة قالب المنتج — Levonis Product Template Guide

هذا الدليل يُعطى لأي جهة خارجية (شخص أو محادثة خارجية) تساعد في تعبئة
ملف قالب المنتج النصي (`.txt`). القالب يُعالَج بمحلل حتمي على الخادم —
**لا يوجد أي ذكاء اصطناعي في هذا المسار**، لذلك كل ما تكتبه يُطبق حرفياً.

This guide is handed to any external party (a person or an external chat)
helping to fill the product template `.txt` file. The template is processed
by a deterministic parser on the server — **there is NO AI anywhere in this
pipeline**, so everything you write is applied literally.

---

## القواعد الذهبية / Golden rules

1. **تحقق من الحقائق. لا تختلق شيئاً أبداً.**
   لا تخترع مواصفات، أسعاراً، أرقام موديلات، مدد ضمان أو أي معلومة.
   المعلومة غير المؤكدة أسوأ من المعلومة الغائبة.
   **Verify facts. Never fabricate anything** — no invented specs, prices,
   model numbers, warranty durations, or any other detail. A wrong value is
   worse than a missing one.

2. **المجهول = `__NULL__` أو اتركه فارغاً.**
   إذا لم تعرف قيمة حقل رقمي قابل للإهمال اكتب `__NULL__`. إذا لم تعرف
   نصاً اتركه فارغاً (`key=`). لا تخمّن.
   **Unknown = `__NULL__`** for nullable numbers, or leave text empty.
   Never guess.

3. **الأسعار أعداد صحيحة بالدينار العراقي فقط.**
   بدون فواصل، بدون كسور، بدون عملات أخرى. `750000` صحيح؛ `750,000` خطأ.
   الصفر قيمة صريحة (يعني فعلاً صفر) — لا تستخدمه بمعنى «غير معروف».
   **Prices are integer IQD only.** `750000` is right; `750,000` is wrong.
   Zero is an explicit value (really zero) — never use it to mean "unknown".

4. **املأ كل اللغات التي تعرفها.**
   العربية هي اللغة المصدر (`*_ar`) وهي الأهم. أضف الإنكليزية (`*_en`)
   والكردية السورانية (`*_ckb`) لكل حقل تعرف ترجمته الصحيحة. لا تترجم
   آلياً ولا تخترع ترجمة — الحقل الفارغ يظهر لاحقاً كترجمة ناقصة ليكملها
   فريق المتجر.
   **Fill every language you actually know.** Arabic (`*_ar`) is the source
   and matters most; add English (`*_en`) and Sorani Kurdish (`*_ckb`)
   wherever you know the correct wording. Do not machine-translate or
   invent — an empty field is honestly tracked as a missing translation.

5. **أرقام الموديلات تُنسخ حرفياً.**
   انسخ رقم الموديل كما يكتبه المصنّع بالضبط (حروف كبيرة/صغيرة، شرطات).
   **Exact model numbers**, copied character-for-character from the
   manufacturer.

6. **الوسائط: ضع روابط المصدر فقط.**
   لا ترفع ملفات ولا تولّد صوراً — ضع رابط الصورة/الفيديو الأصلي في
   `images.N.url` (أو `images.N.source_url` للرابط الخارجي الأصلي)
   وفريق المتجر يتولى التنزيل والرفع.
   **Media as source URLs only** — paste the original image/video URLs;
   the store team handles downloading and rehosting.

7. **لا تلمس الأسطر التي لا تفهمها.**
   الحقول المحذوفة من الملف تحافظ على قيمتها الحالية عند التحديث؛
   `__CLEAR__` يمسح القيمة فعلاً — لا تستخدمه إلا عن قصد.
   **Leave lines you do not understand alone.** Omitted keys keep their
   current values on update; `__CLEAR__` really erases — only use it
   deliberately.

## كيف يعمل الملف / How the file works

- كل سطر: `key=value`. الأسطر التي تبدأ بـ `#` تعليقات وتُتجاهل.
  Every line is `key=value`; `#` lines are comments.
- نص متعدد الأسطر: `key=<<<END` ثم الأسطر ثم `END` وحده في سطر.
  Multiline text: `key=<<<END`, the lines, then `END` alone on a line.
- المجموعات المتكررة مفهرسة: `options.1.name_ar` ثم `options.2.name_ar`.
  صفوف المواصفات: `spec_groups.1.rows.2.value_ar`.
  Repeatable groups are indexed from 1; spec rows nest as shown.
- **السعر الأساسي هو الأرخص، وكل ما فوقه زيادة.** `price_iqd` = أرخص صنف
  قابل للبيع؛ الخيار أو اللون زيادة فوقه: `options.2.regular_adjust_iqd=60000`
  أو مباشرةً `options.2.regular_price_iqd=+60000` (الإشارة تعني «زيادة»).
  رقم بلا إشارة ما زال مقبولًا كسعر ثابت، ويُعاد التعبير عنه كزيادة عند
  الاستيراد **دون تغيير ما يدفعه الزبون** (التصدير يكتبه بهذا الشكل أيضًا).
  The base price is the CHEAPEST sellable item; options and colours are
  increases over it (`regular_adjust_iqd`, or a signed `+N` on the price
  key). A plain fixed number is still accepted and re-expressed as an
  increase on import — the resolved prices never change. (The rewrite runs
  only when the file carries `options.*`/`colors.*` rows; `+N` on the price
  line wins over an untouched `*_adjust_iqd=__NULL__` line beneath it.)
- **التوفر حسب المنتج.** اترك `options.N.availability_type` فارغًا؛ فرق البيع
  المباشر زيادة على المنتج (`direct_surcharge_iqd`) وكل طريقة طلب مسبق زيادة
  (`transports.N.commission_iqd`، وتُقبل بكلمة الواجهة `surcharge_iqd`) —
  لا حاجة لخيارَين منفصلَين «بيع مباشر» و«طلب مسبق» لنفس النسخة.
  Availability follows the product: leave the option's type empty; the
  direct-sale premium and each pre-order route are product-level increases.
- لربط لون بخيار: أعطِ الخيار `id` ثابتاً واستخدمه في `colors.N.option_id`،
  أو استخدم `colors.N.option_index=2` للإشارة إلى `options.2` في نفس الملف.
  To link a color to an option use ids, or `option_index` within one file.
- العلامة التجارية والكتالوجات تُكتب بالـ slug: قيمة غير معروفة لا تُنشأ
  تلقائياً أبداً — تظهر كـ "needs review" ليقررها المشرف.
  Brand/catalogs are written as slugs; unknown values are never silently
  created — they surface as needs-review items for the admin.
- **مستوى المخزون**: اترك `inventory_mode` فارغًا وسيُشتق من مكان الأرقام —
  مخزون على اللون ⇒ `COLOR`، على الخيار ⇒ `OPTION`، وإلا `BASE` — وهي نفس
  القاعدة التي يطبّقها نموذج المنتج. اكتبه صراحةً فقط إن أردت مستوىً محدَّدًا.
  Leave `inventory_mode` empty and it follows where the stock numbers are —
  the same rule the product form applies. State it only to force a level.
- **لون بلا كود لا يُقبل**: `colors.N.hex` يجب أن يكون `#RRGGBB` حقيقيًا
  (نفس ما يشترطه النموذج). الملف بلون بلا كود **يُرفض بالاسم** ولا يُكتب منه
  شيء. A colour needs a real `#RRGGBB`; a file without one is refused by name
  and nothing is written.
- **مفتاح غير معروف لا يُبتلع**: أي مفتاح لا يعرفه القالب — بما فيها
  `compare_at_iqd` الذي أُزيل — يظهر في `unknown_keys` في نتيجة الفحص
  **وفي نتيجة الاستيراد**، فلا يمرّ سطر بصمت. Unknown keys (including the
  removed `compare_at_iqd`) are listed in `unknown_keys` at check time AND at
  import time — no line is swallowed.
- **نتيجة الاستيراد تُقرأ من قاعدة البيانات لا من الملف**: بعد الكتابة يعيد
  الخادم قراءة المنتج ويقارن المطلوب بالمخزَّن؛ إن اختلف قسمٌ واحد تُرفض
  النتيجة باسم القسم والحقل بدل أن تقول «تم». The import result is read back
  from the database, not counted from the file: any section that did not
  persist is named, and the answer is a failure, not a success.

## مثال قصير مكتمل / Short worked example

```
template_version=2
name_ar=فتيل طباعة PLA أزرق 1.75 ملم — 1 كغم
name_en=Blue PLA Filament 1.75 mm — 1 kg
name_ckb=فیلامێنتی PLA شین 1.75 ملم — 1 کگم
description_ar=<<<END
فتيل PLA عالي الجودة بقطر 1.75 ملم.
مناسب لأغلب الطابعات المكتبية.
END
description_en=High-quality 1.75 mm PLA filament for most desktop printers.
description_ckb=
price_iqd=25000
pro_price_iqd=__NULL__
original_price_iqd=__NULL__
product_cost_iqd=__NULL__
brand=esun
catalogs=filaments
selling_type=direct_sale
stock=__NULL__
images.1.url=https://example.com/media/pla-blue-front.jpg
images.1.alt_ar=بكرة فتيل PLA زرقاء
images.1.alt_en=Blue PLA filament spool
images.1.primary=true
spec_groups.1.title_ar=المواصفات
spec_groups.1.title_en=Specifications
spec_groups.1.rows.1.label_ar=قطر الفتيل
spec_groups.1.rows.1.label_en=Filament diameter
spec_groups.1.rows.1.value_ar=1.75
spec_groups.1.rows.1.value_en=1.75
spec_groups.1.rows.1.unit=mm
```

لاحظ / Note:

- `description_ckb=` تُركت فارغة لأن الترجمة الكردية غير متوفرة — لم نخترعها.
  Left empty because no Kurdish translation was available — not invented.
- `pro_price_iqd=__NULL__` لأن المالك لم يحدد سعر PRO — النظام يطبق سياسة
  المتجر (الافتراضي: لا خصم مختلق). No PRO price was provided, so the store
  policy applies (default: no fabricated discount).
- حين يُحدَّد سعر PRIME/PRO للمنتج فإن **زيادة الخيار أو اللون تنتقل إليهما
  تلقائيًا** (أساسي 150,000 / 125,000 / 100,000 وخيار +25,000 → 175,000 /
  150,000 / 125,000). لا تكتب للخيار زيادة عضوية ثانية. Member prices carry the
  option/colour surcharge on their own — do not add a second one.
- `product_cost_iqd=__NULL__` الكلفة غير معروفة للجهة الخارجية — وهي على
  كل حال داخلية ولا تُعرض أبداً. Cost unknown to the external party; it is
  internal-only anyway.

## الضمان الممدد — للطابعات فقط / Extended warranty — printers only

كل طابعة تأتي بضمان أساسي ١٢ شهرًا من التسليم، ويمكن أن تعرض تمديدَين لا غير:
`+12` (فتصبح ٢٤ شهرًا إجمالًا) و`+24` (فتصبح ٣٦ شهرًا). يُشترى التمديد قبل إتمام
الطلب فقط. الرسم نسبة من سعر الطابعة الاعتيادي (`fee_percent`، مثال `7.5` أو
`10`؛ الموصى به ٧٫٥–١٠) تُقرَّب إلى دينار صحيح ولا تُعفى بالعضوية؛ `fee_iqd` رسم
ثابت يُستخدم فقط حين لا توجد نسبة. المنتج الذي ليس في كتالوج طابعات **لا يقبل**
هذه الأسطر (يُرفض الملف بـ`WARRANTY_NOT_PRINTER`) — لا تكتبها للمواد والقطع.
Every printer carries a 12-month base warranty from delivery and may offer
exactly two extensions: `+12` (24 months in total) and `+24` (36 in total),
bought before the order only. The fee is a percent of the printer's regular
price (`fee_percent`, e.g. `7.5` or `10`), rounded to an integer dinar and
never waived by membership; `fee_iqd` is the fixed fallback when no percent is
given. A product outside a printer catalog is refused these lines.

```
warranty_base_months=12
serialized=true
warranty_plans.1.id=wp_ext12
warranty_plans.1.title_ar=ضمان ممدد +12 شهرًا (24 شهرًا إجمالًا)
warranty_plans.1.title_en=Extended warranty +12 months (24 months total)
warranty_plans.1.duration_months=12
warranty_plans.1.duration_kind=extension
warranty_plans.1.fee_percent=7.5
warranty_plans.1.fee_iqd=0
warranty_plans.1.active=true
warranty_plans.2.id=wp_ext24
warranty_plans.2.title_ar=ضمان ممدد +24 شهرًا (36 شهرًا إجمالًا)
warranty_plans.2.title_en=Extended warranty +24 months (36 months total)
warranty_plans.2.duration_months=24
warranty_plans.2.duration_kind=extension
warranty_plans.2.fee_percent=10
warranty_plans.2.fee_iqd=0
warranty_plans.2.active=true
```

## قائمة تدقيق قبل التسليم / Pre-submission checklist

- [ ] كل سعر عدد صحيح بالدينار، وكل مجهول `__NULL__` وليس صفراً.
      Every price is integer IQD; unknowns are `__NULL__`, never 0.
- [ ] الاسم العربي موجود ودقيق. Arabic name present and accurate.
- [ ] أرقام الموديلات منسوخة حرفياً. Model numbers copied exactly.
- [ ] لا مواصفات أو مدد ضمان مخترعة. No invented specs or warranty terms.
- [ ] أسطر الضمان الممدد للطابعات فقط، وبمدتَي ١٢ أو ٢٤ ونسبة لكل خطة.
      Extended-warranty lines only on printers, +12/+24 only, a percent per plan.
- [ ] روابط الوسائط أصلية وتعمل. Media source URLs are original and working.
- [ ] كل اللغات المعروفة معبأة، والباقي فارغ بصدق.
      All known languages filled; the rest honestly left empty.

الملف الكامل بكل الحقول موجود في تنزيل «تنزيل قالب TXT» من نافذة الاستيراد
(`GET /api/admin/template/blank`) مع تعليق يشرح كل حقل. إذا اخترت نوع المنتج
في النافذة قبل التنزيل (`?type=printer|parts|filament|accessory`) يأتي القالب
ومعه **ورقة مواصفات ذلك النوع** — نفس القائمة التي يعرضها نموذج المنتج —
كأسطر تعليق تحذف علامة `#` عمّا تملؤه منها.

المجموعات المتكررة بلا عدد ثابت: `options.1` ثم `options.2` وهكذا (حتى ٥٠٠
عنصر لكل مجموعة). المرجع التقني الكامل: `docs/FIELD_MAPPING.md`.

The full commented field list ships in the TXT template download. Passing
`?type=` adds that product type's own specification sheet as commented lines,
and repeated groups have no fixed count — keep going with `options.2`,
`options.3`, … The technical reference is `docs/FIELD_MAPPING.md`.
