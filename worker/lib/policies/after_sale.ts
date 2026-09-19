import type { PolicyDocument } from './types';

/**
 * AFTER-SALE SERVICES — what the shop does once the box is open, and what it
 * charges for.
 *
 * THE DANGEROUS DOCUMENT IS THE ONE THAT PROMISES A SERVICE THE CODE CANNOT
 * PERFORM. There is no paid-repair pipeline in this worker: there are support
 * tickets (worker/routes/support.ts, states open / waiting_customer /
 * waiting_staff / resolved, with a REAL priority flag for PRO), and there is
 * the warranty claim thread (worker/routes/devices.ts). So article 7.6
 * describes paid repair as what it actually is — a request, a written
 * quotation, and work that starts only on written acceptance — rather than
 * inventing a repair-booking flow that a customer would then ask for.
 *
 * Everything with a number the code does not hold is a double-brace placeholder: hours,
 * response times, fees, lead times. The support assistant already refuses to
 * promise a delivery date it cannot see; this document holds the same line.
 *
 * ARTICLE 7.11 IS THE POINT OF THE DOCUMENT for the owner: naming what is NOT
 * an after-sale service — teaching CAD, designing a model, a machine bought
 * elsewhere — is what keeps a support channel from becoming an unpaid design
 * studio. Levonis does sell design and printing, and it sells them under their
 * own terms; that is said here so the refusal does not read as a brush-off.
 */
export const after_sale: PolicyDocument = {
  key: 'after_sale',
  version: 1,
  effective_at: '2026-01-01',
  title: {
    ar: 'خدمات ما بعد البيع',
    en: 'After-Sale Services',
    ckb: 'خزمەتگوزاری دوای فرۆشتن',
  },
  body: {
    ar: `## وثيقة خدمات ما بعد البيع — المادة 7

هذه الوثيقة تبيّن ما يقدمه ليفونيس بعد التسليم: ما هو مجاني، وما هو مدفوع، وبأي قنوات، وفي أي أوقات، وما هو خارج الخدمة أصلًا. النص العربي هو النص المعتمد.

### 7.1 نطاق الوثيقة
- تسري هذه الوثيقة على الأجهزة والمنتجات المشتراة من المتجر الرسمي لليفونيس.
- لا تسري على جهاز اشتُري من مكان آخر، ولا على منتج تاجر مستقل داخل ليفو برو إلا في حدود ما يلتزم به التاجر نفسه.
- ما ورد هنا خدمة، لا تغطية. التغطية محلها وثيقة الضمان، المادة 5.

### 7.2 الخدمات المجانية
يقدم المتجر ما يأتي بلا أجر لمشتري الجهاز منه:

- المساندة في التنصيب الأول وتوصيل الجهاز وتشغيله لأول مرة.
- إرشاد المعايرة وضبط المستوى وأول عملية طباعة ناجحة.
- إرشاد تحديث الفيرموير الرسمي، وبيان ما يترتب على التحديث.
- إرشاد إعداد برنامج التقطيع المعتمد للجهاز: الملف التعريفي للطابعة، ودرجات الحرارة، والسرعات، وإعدادات المادة المباعة معه.
- بيان سبب عطل ظاهر وتوجيه الزبون إلى المسار الصحيح: ضمان، أو إصلاح مدفوع، أو قطعة غيار.
- الإجابة عن أسئلة الطلب والتوصيل والضمان والنقاط من داخل حساب الزبون.

هذه المساندة عن بُعد عبر القنوات المذكورة في المادة 7.4، وليست زيارة ميدانية.

### 7.3 حدود المساندة المجانية
- المساندة إرشاد لا نيابة: المتجر يشرح الخطوة، ويبقى تنفيذها على الزبون.
- تشخيص العطل عن بُعد مبني على ما يقدمه الزبون من صور ومقاطع وأوصاف. ما لا يظهر فيها لا يُشخَّص.
- المساندة المجانية لا تشمل ضبط إعدادات لنموذج بعينه، ولا تحسين جودة قطعة يطبعها الزبون لزبونه، ولا تشغيل مشاريع الزبون.
- عدد الجلسات ومدتها يخضع لتقدير معقول؛ ولا تتحول المساندة إلى خدمة تشغيل دائمة.

### 7.4 قنوات الدعم وأوقاتها
- القناة المعتمدة والموثقة: {{LEVONIS_SUPPORT_CONTACT}}.
- التذاكر داخل حساب الزبون: مسار مكتوب محفوظ، وهو المعتمد عند الخلاف.
- سجل رسائل المطالبة داخل مطالبة الضمان نفسها، لما يخص تلك المطالبة.
- المساعد الآلي داخل الموقع: يجيب عن أسئلة الحساب والطلب والضمان من بيانات الزبون نفسه فقط، ويحيل إلى موظف عند الاشتباه أو عدم الوضوح، ولا يعد بموعد ولا بقرار.
- أوقات العمل: {{LEVONIS_SUPPORT_HOURS}}. ما يصل خارجها يُعالج في أول وقت عمل تالٍ.
- ما يُتفق عليه خارج هذه القنوات لا يُحتج به على المتجر.

### 7.5 أوقات الاستجابة
- أول رد على التذكرة خلال {{SUPPORT_FIRST_RESPONSE_HOURS}} من فتحها ضمن أوقات العمل.
- تذاكر أعضاء PRO تُسجَّل بأولوية حقيقية في الطابور وتُقدَّم على غيرها، بهدف استجابة خلال {{PRO_PRIORITY_RESPONSE_HOURS}}.
- الأولوية تقديم في الدور فقط، ولا تعني نتيجة مختلفة ولا تغييرًا في الضمان أو في الأسعار.
- تظل التذكرة القديمة ظاهرة في الطابور حتى تُعالَج، فلا تُهمَل بسبب الأولويات.
- هذه أوقات مستهدفة معلنة، لا مواعيد مضمونة تعاقديًا.

### 7.6 الإصلاح المدفوع خارج الضمان
يُقدَّم الإصلاح المدفوع للأجهزة التي انتهى ضمانها، أو التي كان العطل فيها خارج التغطية أو أسقط الضمان، وفق التسلسل الآتي:

- يفتح الزبون طلبًا في القناة المعتمدة ويصف العطل ويرفق الصور والمقاطع.
- يوصل الزبون الجهاز أو القطعة إلى المتجر على حسابه.
- يُجري المتجر الفحص، ويستحق عليه أجر فحص قدره {{WARRANTY_INSPECTION_FEE_IQD}}، ويُحتسب من كلفة الإصلاح إذا نُفِّذ.
- يُصدر المتجر عرض سعر مكتوبًا يبيّن القطع والأجور والمدة المتوقعة، وصلاحيته {{REPAIR_QUOTE_VALIDITY_DAYS}}.
- لا يبدأ العمل إلا بموافقة الزبون الكتابية على عرض السعر داخل المسار المسجل.
- إذا رفض الزبون العرض أُعيد الجهاز إليه على حسابه بعد دفع أجر الفحص.
- يضمن المتجر عمل الإصلاح والقطعة المركّبة لمدة {{REPAIR_WORK_WARRANTY_DAYS}} من تاريخ التسليم، وفي حدود القطعة التي استُبدلت والعمل الذي نُفِّذ، لا الجهاز كله.
- الجهاز غير المستلَم خلال {{UNCOLLECTED_DEVICE_STORAGE_DAYS}} من إشعار الجاهزية يستحق عليه أجر خزن {{STORAGE_FEE_PER_DAY_IQD}} عن كل يوم.

### 7.7 قطع الغيار
- تُباع قطع الغيار المتوفرة بوصفها منتجات في المتجر، بأسعارها المعلنة ووفق الشروط نفسها التي تسري على أي منتج.
- القطعة غير المعروضة في المتجر تُطلب عبر القناة المعتمدة، ويُعطى الزبون سعرًا ومدة توريد تقديرية {{SPARE_PART_LEAD_TIME_DAYS}} قبل الطلب.
- المتجر غير ملزم بتوفير قطعة أوقف المصنّع إنتاجها، ولا بتوريد قطع لجهاز لم يُشترَ منه.
- تركيب القطعة على يد الزبون أو على يد جهة غير معتمدة أثناء سريان الضمان يُسقط الضمان وفق المادة 5.6.
- القطعة المباعة مفردة تحمل ضمان القطع المنصوص عليه في المادة 5 لمدة {{SPARE_PART_WARRANTY_MONTHS}} من تسليمها، ولا تُمدد.

### 7.8 الفيرموير وبرامج التقطيع
- يقدم المتجر إرشادًا لاستعمال الفيرموير الرسمي وبرامج التقطيع المعتمدة للجهاز.
- المتجر لا يضمن نتائج فيرموير غير رسمي ولا برنامجًا معدّلًا، وتركيب أي منهما مسؤولية الزبون وقد يُسقط الضمان.
- المتجر لا يوفر تراخيص برامج الطرف الثالث ولا يدعم مشكلاتها.
- ملفات الزبون ونماذجه وإعداداته مسؤوليته وحده، ويُنصح بالاحتفاظ بنسخة منها قبل أي تحديث أو صيانة.

### 7.9 الزيارة الميدانية والتركيب في الموقع
الزيارة الميدانية ليست خدمة قياسية ولا جزءًا من الضمان. تُقدَّم حيث يعلن المتجر توفرها ووفق أجرها المعلن {{ONSITE_VISIT_FEE_IQD}} وضمن المناطق {{ONSITE_SERVICE_AREAS}}. وما لم يُعلن ذلك كتابةً فالخدمة غير متاحة، ولا يُعد عدم توفرها إخلالًا بالبيع.

### 7.10 التدريب
- الإرشاد الأول على تشغيل الجهاز مجاني وفق المادة 7.2.
- ما زاد على ذلك من تدريب منظم على التصميم أو الإنتاج خدمة مدفوعة مستقلة، تُعرض بشروطها وأجورها إن توفرت.

### 7.11 ما لا يُعد خدمة ما بعد بيع
لا يشمل هذا الباب، ولا يُطلب من الدعم، ما يأتي:

- تعليم برامج التصميم ثلاثي الأبعاد وتدريس استعمالها.
- تصميم النماذج أو تعديلها أو إصلاح ملفات الزبون أو تحويل صيغها.
- إعداد ملفات الطباعة نيابةً عن الزبون أو تجهيز مشاريعه.
- صيانة أو تشخيص جهاز لم يُشترَ من ليفونيس، ولو كان من الصنف نفسه.
- دعم أجهزة أو ملحقات أو مواد من مصادر أخرى ركّبها الزبون على جهازه.
- التدخل في عمل الزبون التجاري مع زبائنه هو، أو ضمان جودة ما ينتجه.
- خدمات التصميم والطباعة التي يبيعها ليفونيس خدمات مستقلة لها شروطها وأسعارها، ولا تُقدَّم مجانًا بوصفها دعمًا.

### 7.12 سلوك التعامل
للمتجر إنهاء جلسة دعم أو تقييد قناة تواصل عند الإساءة اللفظية أو التهديد أو الإغراق المتعمد بالطلبات، مع بيان السبب وإتاحة الاعتراض، ودون أن يمس ذلك حق الزبون في الضمان أو في مطالباته القائمة.

### 7.13 السجلات
- ما يُسجَّل في تذكرة أو في مطالبة هو المرجع عند الخلاف: نصه وتاريخه ومرفقاته.
- مرفقات الزبون تُحفظ في مساحة خاصة لا يطلع عليها إلا هو وإدارة المتجر.
- المتجر يحتفظ بسجلات الدعم للمدة المبينة في وثيقة الخصوصية.

### 7.14 النفاذ واللغة
- عند تعارض هذه الوثيقة مع وثيقة الضمان في مسألة تغطية، فوثيقة الضمان هي المرجع.
- عند اختلاف الترجمات يُرجع إلى النص العربي.
- يسري تعديل هذه الوثيقة على الطلبات المقدمة بعد تاريخ نفاذه.
- عنوان الخدمة: {{LEVONIS_SERVICE_ADDRESS}}. القناة المعتمدة: {{LEVONIS_SUPPORT_CONTACT}}.`,

    en: `## After-Sale Services Document — Article 7

This document sets out what Levonis provides after delivery: what is free, what is charged for, through which channels, at what hours, and what is outside the service altogether. The Arabic text is the authoritative text.

### 7.1 Scope of this document
- This document applies to devices and products bought from the official Levonis store.
- It does not apply to a device bought elsewhere, nor to a product of an independent merchant inside Levo Pro except to the extent that the merchant itself undertakes.
- What is set out here is service, not cover. Cover belongs to the Warranty document, Article 5.

### 7.2 Free services
The store provides the following without charge to whoever bought the device from it:

- Assistance with the first installation, connecting the device and powering it up for the first time.
- Guidance on calibration, levelling and the first successful print.
- Guidance on updating the official firmware, and on what the update entails.
- Guidance on setting up the slicer approved for the device: the printer profile, temperatures, speeds, and the settings for the material sold with it.
- Explaining the cause of an apparent failure and directing the customer to the correct route: warranty, paid repair, or a spare part.
- Answering questions about orders, delivery, warranty and points from within the customer account.

This assistance is remote, through the channels named in Article 7.4, and is not a site visit.

### 7.3 Limits of free assistance
- Assistance is guidance, not substitution: the store explains the step, and carrying it out remains with the customer.
- Remote diagnosis rests on what the customer provides in photographs, footage and description. What does not appear in them is not diagnosed.
- Free assistance does not include tuning settings for one particular model, nor improving the quality of a part the customer prints for their own client, nor running the customer projects.
- The number and length of sessions are subject to reasonable judgement; assistance does not become a permanent operating service.

### 7.4 Support channels and their hours
- The approved, recorded channel: {{LEVONIS_SUPPORT_CONTACT}}.
- Tickets inside the customer account: a written, retained record, and the one relied upon in a dispute.
- The message record inside the warranty claim itself, for matters concerning that claim.
- The automated assistant on the site: it answers account, order and warranty questions from the customer own data only, refers to a member of staff where a matter is unclear or doubtful, and promises neither a date nor a decision.
- Working hours: {{LEVONIS_SUPPORT_HOURS}}. What arrives outside them is handled at the next working time.
- What is agreed outside these channels may not be relied upon against the store.

### 7.5 Response times
- A first reply to a ticket within {{SUPPORT_FIRST_RESPONSE_HOURS}} of it being opened, within working hours.
- Tickets from PRO members are recorded with a real priority in the queue and are taken ahead of others, targeting a response within {{PRO_PRIORITY_RESPONSE_HOURS}}.
- Priority is a place in the queue only; it means neither a different outcome nor any change to warranty or prices.
- An older ticket remains visible in the queue until it is handled, so that it is not starved by priorities.
- These are published target times, not contractually guaranteed dates.

### 7.6 Paid repair outside warranty
Paid repair is offered for devices whose warranty has ended, or whose failure was outside cover or voided the warranty, in the following sequence:

- The customer opens a request in the approved channel, describes the failure, and attaches photographs and footage.
- The customer delivers the device or the part to the store at their own expense.
- The store carries out the inspection and is entitled to an inspection fee of {{WARRANTY_INSPECTION_FEE_IQD}}, which is set against the cost of the repair where the repair goes ahead.
- The store issues a written quotation stating the parts, the labour and the expected period, valid for {{REPAIR_QUOTE_VALIDITY_DAYS}}.
- Work begins only on the written acceptance of the quotation by the customer inside the recorded channel.
- Where the customer declines the quotation, the device is returned to them at their expense after the inspection fee is paid.
- The store warrants the repair work and the fitted part for {{REPAIR_WORK_WARRANTY_DAYS}} from the date of handover, limited to the part that was replaced and the work that was carried out, not to the whole device.
- A device not collected within {{UNCOLLECTED_DEVICE_STORAGE_DAYS}} of the ready notice incurs a storage charge of {{STORAGE_FEE_PER_DAY_IQD}} per day.

### 7.7 Spare parts
- Available spare parts are sold as products in the store, at their published prices and under the same terms that apply to any product.
- A part not listed in the store is requested through the approved channel, and the customer is given a price and an estimated supply period of {{SPARE_PART_LEAD_TIME_DAYS}} before ordering.
- The store is not obliged to supply a part the manufacturer has discontinued, nor to supply parts for a device it did not sell.
- Fitting a part by the customer, or by a party not approved by the store, while the warranty is running voids the warranty under Article 5.6.
- A part sold on its own carries the parts warranty set out in Article 5 for {{SPARE_PART_WARRANTY_MONTHS}} from its delivery, and is not extendable.

### 7.8 Firmware and slicers
- The store provides guidance on using the official firmware and the slicers approved for the device.
- The store does not warrant the results of unofficial firmware or modified software; installing either is the responsibility of the customer and may void the warranty.
- The store does not supply third-party software licences and does not support their problems.
- The files, models and settings of the customer are their responsibility alone, and keeping a copy of them before any update or servicing is advised.

### 7.9 Site visits and on-site installation
A site visit is not a standard service and is not part of the warranty. It is provided where the store publishes its availability, at the published fee of {{ONSITE_VISIT_FEE_IQD}} and within the areas {{ONSITE_SERVICE_AREAS}}. Unless that is published in writing the service is not available, and its unavailability is not a breach of the sale.

### 7.10 Training
- The first guidance on operating the device is free under Article 7.2.
- Anything beyond that, in the form of structured training on design or production, is a separate paid service offered on its own terms and charges where available.

### 7.11 What is not an after-sale service
This chapter does not include, and support is not to be asked for, any of the following:

- Teaching three-dimensional design software and instruction in its use.
- Designing or modifying models, repairing customer files, or converting their formats.
- Preparing print files on behalf of the customer or setting up their projects.
- Servicing or diagnosing a device not bought from Levonis, even one of the same model.
- Supporting devices, accessories or materials from other sources that the customer has fitted to their machine.
- Intervening in the commercial work of the customer with their own clients, or warranting the quality of what they produce.
- Design and printing services sold by Levonis are separate services with their own terms and prices, and are not provided free of charge as support.

### 7.12 Conduct
The store may end a support session or restrict a contact channel in the face of verbal abuse, threats, or deliberate flooding with requests, stating the reason and allowing an objection, without that affecting the entitlement of the customer to the warranty or to their pending claims.

### 7.13 Records
- What is recorded in a ticket or a claim is the reference in a dispute: its text, its date and its attachments.
- Customer attachments are kept in a private area which only they and store management can open.
- The store retains support records for the period set out in the Privacy document.

### 7.14 Effect and language
- Where this document conflicts with the Warranty document on a question of cover, the Warranty document governs.
- Where translations differ, the Arabic text governs.
- An amendment to this document applies to requests filed after its effective date.
- Service address: {{LEVONIS_SERVICE_ADDRESS}}. Approved channel: {{LEVONIS_SUPPORT_CONTACT}}.`,

    ckb: `## بەڵگەنامەی خزمەتگوزاری دوای فرۆشتن — ماددەی 7

ئەم بەڵگەنامەیە ڕوون دەکاتەوە کە لێڤۆنیس دوای گەیاندن چی پێشکەش دەکات: چی بێبەرامبەرە، چی پارەی لەسەرە، بە چ کەناڵێک، لە چ کاتێکدا، و چی لە بنەڕەتدا لە دەرەوەی خزمەتگوزارییەکەیە. دەقی عەرەبی دەقی پەسەندکراوە.

### 7.1 بوارى ئەم بەڵگەنامەیە
- ئەم بەڵگەنامەیە لەسەر ئەو ئامێر و بەرهەمانە جێبەجێ دەبێت کە لە فرۆشگای فەرمی لێڤۆنیس کڕدراون.
- لەسەر ئامێرێک کە لە شوێنێکی تر کڕدراوە جێبەجێ نابێت، نە لەسەر بەرهەمی بازرگانێکی سەربەخۆ لەناو لێڤۆ پرۆ، تەنها لەو سنوورەی خودی بازرگانەکە پابەندی پێوە دەبێت.
- ئەوەی لێرە هاتووە خزمەتگوزارییە، نەک داپۆشین. داپۆشین شوێنەکەی بەڵگەنامەی گەرەنتییە، ماددەی 5.

### 7.2 خزمەتگوزارییە بێبەرامبەرەکان
فرۆشگا ئەمانە بەبێ کرێ بۆ ئەو کەسە پێشکەش دەکات کە ئامێرەکەی لێی کڕیوە:

- یارمەتیدان لە دانانی یەکەم جار و بەستنەوەی ئامێرەکە و کارپێکردنی بۆ یەکەم جار.
- ڕێنمایی کالیبرەکردن و ڕێکخستنی ئاست و یەکەم چاپی سەرکەوتوو.
- ڕێنمایی نوێکردنەوەی فێرموێری فەرمی، و ڕوونکردنەوەی ئەوەی لە نوێکردنەوەکە دەکەوێتەوە.
- ڕێنمایی ڕێکخستنی ئەو سلایسەرەی بۆ ئامێرەکە پەسەندکراوە: پرۆفایلی پرینتەر، پلەکانی گەرمی، خێراییەکان، و ڕێکخستنەکانی ئەو ماددەیەی لەگەڵیدا فرۆشراوە.
- ڕوونکردنەوەی هۆکاری تێکچوونێکی دیار و ئاڕاستەکردنی کڕیار بۆ ڕێگای ڕاست: گەرەنتی، یان چاککردنی پارەدراو، یان پارچەی یەدەگ.
- وەڵامدانەوەی پرسیارەکانی داواکاری و گەیاندن و گەرەنتی و خاڵەکان لەناو هەژماری کڕیارەوە.

ئەم پشتگیرییە لە دوورەوەیە بە کەناڵەکانی ماددەی 7.4، و سەردانی مەیدانی نییە.

### 7.3 سنووری پشتگیری بێبەرامبەر
- پشتگیری ڕێنماییە نەک جێگرەوەیی: فرۆشگا هەنگاوەکە ڕوون دەکاتەوە، و جێبەجێکردنی لەسەر کڕیار دەمێنێتەوە.
- دەستنیشانکردنی دوور لەسەر ئەوە دەوەستێت کە کڕیار لە وێنە و ڤیدیۆ و وەسفدا پێشکەشی دەکات. ئەوەی تێیاندا دەرناکەوێت دەستنیشان ناکرێت.
- پشتگیری بێبەرامبەر ڕێکخستنی ڕێکخستنەکان بۆ مۆدێلێکی دیاریکراو ناگرێتەوە، نە باشترکردنی کوالیتی ئەو پارچەیەی کڕیار بۆ کڕیارەکەی خۆی چاپی دەکات، نە بەڕێوەبردنی پڕۆژەکانی کڕیار.
- ژمارە و درێژی دانیشتنەکان ملکەچی هەڵسەنگاندنێکی گونجاون، و پشتگیری نابێتە خزمەتگوزارییەکی هەمیشەیی کارپێکردن.

### 7.4 کەناڵەکانی پشتگیری و کاتەکانیان
- کەناڵی پەسەندکراو و تۆمارکراو: {{LEVONIS_SUPPORT_CONTACT}}.
- بلیتەکان لەناو هەژماری کڕیار: تۆمارێکی نووسراوی پارێزراو، و ئەوەیە کە لە کاتی ناکۆکیدا پشتی پێ دەبەسترێت.
- تۆماری نامەکان لەناو خودی داواکاری گەرەنتی، بۆ ئەو بابەتانەی پەیوەندییان بەو داواکارییەوە هەیە.
- یاریدەدەری خۆکار لەناو ماڵپەڕ: تەنها لە زانیاری خودی کڕیارەوە وەڵامی پرسیاری هەژمار و داواکاری و گەرەنتی دەداتەوە، لە کاتی ناڕوونی یان گومان ئاڕاستەی کارمەند دەکات، و نە بەرواری بەڵێن دەدات نە بڕیار.
- کاتەکانی کارکردن: {{LEVONIS_SUPPORT_HOURS}}. ئەوەی لە دەرەوەیان دێت لە یەکەم کاتی کاری داهاتوودا مامەڵەی لەگەڵ دەکرێت.
- ئەوەی لە دەرەوەی ئەم کەناڵانە ڕێک دەکەوێت لە دژی فرۆشگا پشتی پێ نابەسترێت.

### 7.5 کاتەکانی وەڵامدانەوە
- یەکەم وەڵام بۆ بلیت لە ماوەی {{SUPPORT_FIRST_RESPONSE_HOURS}} دوای کردنەوەی، لەناو کاتەکانی کارکردن.
- بلیتی ئەندامانی PRO بە پێشینەییەکی ڕاستەقینە لە ڕیزدا تۆمار دەکرێن و پێش ئەوانی تر دەخرێن، بە ئامانجی وەڵامدانەوە لە ماوەی {{PRO_PRIORITY_RESPONSE_HOURS}}.
- پێشینەیی تەنها شوێنە لە ڕیزدا، و نە ئەنجامێکی جیاواز نە هیچ گۆڕانێک لە گەرەنتی یان نرخەکان دەگەیەنێت.
- بلیتی کۆنتر لە ڕیزدا دیار دەمێنێتەوە هەتا مامەڵەی لەگەڵ دەکرێت، بۆ ئەوەی بە پێشینەییەکان لەبیر نەکرێت.
- ئەمانە کاتی ئامانجداری ڕاگەیەنراون، نەک بەرواری گەرەنتیکراوی گرێبەستی.

### 7.6 چاککردنی پارەدراوی دەرەوەی گەرەنتی
چاککردنی پارەدراو بۆ ئەو ئامێرانە پێشکەش دەکرێت کە گەرەنتییەکەیان کۆتایی هاتووە، یان تێکچوونەکەیان لە دەرەوەی داپۆشین بووە یان گەرەنتییەکەی پووچ کردووەتەوە، بەم ڕیزبەندییە:

- کڕیار داواکارییەک لە کەناڵە پەسەندکراوەکەدا دەکاتەوە و تێکچوونەکە وەسف دەکات و وێنە و ڤیدیۆ هاوپێچ دەکات.
- کڕیار ئامێرەکە یان پارچەکە بە تێچووی خۆی دەگەیەنێتە فرۆشگا.
- فرۆشگا پشکنینەکە ئەنجام دەدات، و شایستەی کرێی پشکنینە بە بڕی {{WARRANTY_INSPECTION_FEE_IQD}}، کە لە تێچووی چاککردنەکە کەم دەکرێتەوە ئەگەر جێبەجێ کرا.
- فرۆشگا نرخنامەیەکی نووسراو دەردەکات کە پارچەکان و کرێی کار و ماوەی چاوەڕوانکراو ڕوون دەکاتەوە، و کاتی بەکارهێنانی {{REPAIR_QUOTE_VALIDITY_DAYS}} ە.
- کار تەنها بە پەسەندکردنی نووسراوی کڕیار بۆ نرخنامەکە لەناو ڕێچکە تۆمارکراوەکەدا دەست پێدەکات.
- ئەگەر کڕیار نرخنامەکەی ڕەت کردەوە، ئامێرەکەی بە تێچووی خۆی بۆ دەگەڕێندرێتەوە دوای دانی کرێی پشکنین.
- فرۆشگا کاری چاککردنەکە و ئەو پارچەیەی داندراوە بۆ ماوەی {{REPAIR_WORK_WARRANTY_DAYS}} لە بەرواری پێدانەوە گەرەنتی دەکات، لە سنووری ئەو پارچەیەی گۆڕدراوە و ئەو کارەی کراوە، نەک هەموو ئامێرەکە.
- ئەو ئامێرەی لە ماوەی {{UNCOLLECTED_DEVICE_STORAGE_DAYS}} دوای ئاگادارکردنەوەی ئامادەیی وەرنەگیرێت، کرێی هەڵگرتنی {{STORAGE_FEE_PER_DAY_IQD}} بۆ هەر ڕۆژێکی لەسەرە.

### 7.7 پارچەی یەدەگ
- ئەو پارچە یەدەگانەی بەردەستن وەک بەرهەم لە فرۆشگادا دەفرۆشرێن، بە نرخە ڕاگەیەنراوەکانیان و بەپێی هەمان ئەو مەرجانەی لەسەر هەر بەرهەمێک جێبەجێ دەبن.
- ئەو پارچەیەی لە فرۆشگادا نییە لە ڕێگەی کەناڵە پەسەندکراوەکەوە داوا دەکرێت، و نرخێک و ماوەی دابینکردنی خەمڵێنراوی {{SPARE_PART_LEAD_TIME_DAYS}} پێش داواکاری بە کڕیار دەدرێت.
- فرۆشگا پابەند نییە بە دابینکردنی پارچەیەک کە کارگە بەرهەمهێنانی ڕاگرتووە، نە بە دابینکردنی پارچە بۆ ئامێرێک کە خۆی نەیفرۆشتووە.
- دانانی پارچە لەلایەن کڕیار یان لەلایەن لایەنێکی نا پەسەندکراو لە کاتی کارکردنی گەرەنتیدا، گەرەنتی بەپێی ماددەی 5.6 پووچ دەکاتەوە.
- ئەو پارچەیەی بە تەنها دەفرۆشرێت گەرەنتی پارچەکانی ماددەی 5 هەڵدەگرێت بۆ ماوەی {{SPARE_PART_WARRANTY_MONTHS}} لە گەیاندنییەوە، و درێژ ناکرێتەوە.

### 7.8 فێرموێر و سلایسەرەکان
- فرۆشگا ڕێنمایی بەکارهێنانی فێرموێری فەرمی و ئەو سلایسەرانە دەدات کە بۆ ئامێرەکە پەسەندکراون.
- فرۆشگا ئەنجامی فێرموێری نافەرمی یان نەرمەکاڵای دەستکاریکراو گەرەنتی ناکات، و دانانی هەریەکێکیان بەرپرسیارێتی کڕیارە و لەوانەیە گەرەنتی پووچ بکاتەوە.
- فرۆشگا مۆڵەتی نەرمەکاڵای لایەنی سێیەم دابین ناکات و پشتگیری کێشەکانیان ناکات.
- فایل و مۆدێل و ڕێکخستنەکانی کڕیار تەنها بەرپرسیارێتی خۆیەتی، و ئامۆژگاری دەکرێت پێش هەر نوێکردنەوە یان چاکسازییەک کۆپییەکیان هەڵبگرێت.

### 7.9 سەردانی مەیدانی و دانانی لە شوێن
سەردانی مەیدانی خزمەتگوزارییەکی ستاندارد نییە و بەشێک لە گەرەنتی نییە. لەو شوێنانە پێشکەش دەکرێت کە فرۆشگا بەردەستبوونی ڕادەگەیەنێت، بە کرێی ڕاگەیەنراوی {{ONSITE_VISIT_FEE_IQD}} و لەناو ناوچەکانی {{ONSITE_SERVICE_AREAS}}. تا ئەوە بە نووسراوی ڕانەگەیەنرێت خزمەتگوزارییەکە بەردەست نییە، و بەردەست نەبوونی پێشێلکردنی فرۆشتنەکە نییە.

### 7.10 ڕاهێنان
- یەکەم ڕێنمایی لەسەر کارپێکردنی ئامێرەکە بێبەرامبەرە بەپێی ماددەی 7.2.
- زیاتر لەوە، وەک ڕاهێنانێکی ڕێکخراو لەسەر دیزاین یان بەرهەمهێنان، خزمەتگوزارییەکی پارەدراوی سەربەخۆیە کە بە مەرج و کرێی خۆی پێشکەش دەکرێت ئەگەر بەردەست بێت.

### 7.11 ئەوەی بە خزمەتگوزاری دوای فرۆشتن دانانرێت
ئەم بەشە ئەمانە ناگرێتەوە، و لە پشتگیری داوا ناکرێن:

- فێرکردنی نەرمەکاڵای دیزاینی سێ ڕەهەندی و وانەوتنەوەی بەکارهێنانی.
- دیزاینکردن یان دەستکاریکردنی مۆدێلەکان، چاککردنی فایلەکانی کڕیار، یان گۆڕینی فۆرماتەکانیان.
- ئامادەکردنی فایلی چاپ لە جیاتی کڕیار یان ڕێکخستنی پڕۆژەکانی.
- چاکسازی یان دەستنیشانکردنی ئامێرێک کە لە لێڤۆنیس نەکڕدراوە، تەنانەت ئەگەر هەمان مۆدێل بێت.
- پشتگیری ئامێر یان پێداویستی یان ماددەی سەرچاوەی تر کە کڕیار لەسەر ئامێرەکەی داناون.
- دەستێوەردان لە کاری بازرگانی کڕیار لەگەڵ کڕیارەکانی خۆی، یان گەرەنتیکردنی کوالیتی ئەوەی بەرهەمی دەهێنێت.
- ئەو خزمەتگوزارییانەی دیزاین و چاپ کە لێڤۆنیس دەیانفرۆشێت خزمەتگوزاری سەربەخۆن و مەرج و نرخی خۆیان هەیە، و وەک پشتگیری بە بێبەرامبەر پێشکەش ناکرێن.

### 7.12 ڕەفتاری مامەڵە
فرۆشگا دەتوانێت دانیشتنێکی پشتگیری کۆتایی پێ بهێنێت یان کەناڵێکی پەیوەندی سنووردار بکات لە کاتی جنێودان یان هەڕەشە یان لافاوی مەبەستداری داواکاریدا، لەگەڵ ڕوونکردنەوەی هۆکارەکە و ڕێگەدان بە ناڕەزایی، بەبێ ئەوەی دەست لە مافی کڕیار لە گەرەنتی یان لە داواکارییە کراوەکانی بدات.

### 7.13 تۆمارەکان
- ئەوەی لە بلیت یان لە داواکارییەکدا تۆمار دەکرێت سەرچاوەیە لە کاتی ناکۆکیدا: دەقەکەی و بەرواری و هاوپێچەکانی.
- هاوپێچەکانی کڕیار لە شوێنێکی تایبەتدا هەڵدەگیرێن کە تەنها خۆی و بەڕێوەبەرایەتی فرۆشگا دەیانبیننەوە.
- فرۆشگا تۆمارەکانی پشتگیری بۆ ئەو ماوەیە هەڵدەگرێت کە لە بەڵگەنامەی تایبەتمەندێتیدا هاتووە.

### 7.14 کارپێکردن و زمان
- ئەگەر ئەم بەڵگەنامەیە لەگەڵ بەڵگەنامەی گەرەنتی لە بابەتێکی داپۆشیندا ناکۆک بوو، بەڵگەنامەی گەرەنتی سەرچاوەیە.
- لە کاتی جیاوازی وەرگێڕانەکاندا دەقی عەرەبی بنەمایە.
- گۆڕانکاری لەم بەڵگەنامەیەدا لەسەر ئەو داواکارییانە جێبەجێ دەبێت کە دوای بەرواری کارپێکردنی پێشکەش دەکرێن.
- ناونیشانی خزمەتگوزاری: {{LEVONIS_SERVICE_ADDRESS}}. کەناڵی پەسەندکراو: {{LEVONIS_SUPPORT_CONTACT}}.`,
  },
};
