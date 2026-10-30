import type { PolicyDocument } from './types';

/**
 * سياسة الخصوصية — ONE OF THE TWO DOCUMENTS A CUSTOMER ACCEPTS AT CHECKOUT
 * (policyOps.ts CHECKOUT_POLICY_KEYS = ['terms', 'privacy']).
 *
 * THAT IS WHY IT IS WRITTEN AS AN INVENTORY AND NOT AS A REASSURANCE. A
 * privacy policy that says "we take your privacy seriously" and lists nothing
 * is worthless in the one moment it matters — when a customer asks what
 * exactly is held about them. So chapter 3 names the categories this codebase
 * actually stores, and chapter 7 names the processors it actually calls.
 *
 * EVERY CLAIM BELOW IS READ OFF CODE, and the hard cases are the ones where
 * the honest answer is smaller than the comfortable one:
 *
 *   sealbox.ts      KYC name / date of birth / document number are encrypted
 *                   at rest with a managed, versioned key. Article 6.2 calls
 *                   this SERVER-SIDE ENCRYPTION WITH MANAGED KEYS and says in
 *                   the same breath that it is NOT end-to-end — because the
 *                   module's own header refuses that description, and a
 *                   customer who reads "encrypted" and imagines the shop
 *                   cannot read it has been misled by omission.
 *   routes/kyc.ts   evidence images live in private storage reachable only
 *                   through an audited admin route; the public file handler
 *                   404s that prefix. And uploading a document is NOT
 *                   verification: only a human admin decision verifies a case.
 *                   Article 6.4 says there is no face recognition, no external
 *                   identity vendor and no government-database check, because
 *                   customers assume all three.
 *   routes/chats.ts only participants may read a conversation and there is no
 *                   moderator backdoor. Article 5.5 states it as the property
 *                   of the system it is, and then states the exception
 *                   honestly: a party may submit a conversation as evidence.
 *   ratelimit.ts    identifiers in the rate-limit table are HASHED, so a
 *                   failed-login table does not become a list of who tried to
 *                   sign in. Article 4.4 says so, because it is the kind of
 *                   decision a customer never learns about otherwise.
 *   telegram.ts     an OTP is never stored in clear and never logged — only a
 *                   salted verifier. Article 4.3.
 *   securityPolicy.ts / the third parties in chapter 7 are the ones the site
 *   emailSend.ts /  really loads or calls: the infrastructure provider, the
 *   wasender.ts /   mail sender, the WhatsApp transport (which drives a REAL
 *   google.ts       account the shop owns — worth stating, because the number
 *                   a customer sees is the shop's phone, not a cloud API), the
 *                   Telegram bot, Google sign-in and the web-font host.
 *   src/lib/        the Meta Pixel — the one advertising script. MAIN SITE
 *   metaPixel.ts /  only (never a store subdomain, never Print Cloud), a
 *   src/components/ PageView alone, from an ALLOWLIST of public pages, with
 *   MetaPixel.tsx   autoConfig off and no advanced matching. Articles 7.5–7.7
 *                   and 12.6 say exactly that, so a new event, a new page on
 *                   the list or advanced matching is a new version of this
 *                   document, not a code change alone.
 *
 * WHAT IS DELIBERATELY ABSENT. Apart from the Meta Pixel on the main site
 * (version 4, below), there is no advertising network in this codebase, no
 * third-party analytics script and no sale of data, so article 7.8 states
 * those as absences rather than leaving a customer to assume the usual — and
 * articles 7.5–7.7 name the one exception in full rather than letting the
 * absences hide it. Cloudflare Web Analytics, which the EDGE injects and this
 * codebase does not load (worker/lib/securityPolicy.ts), has never been named
 * apart from the infrastructure provider of article 7.1; version 4 leaves that
 * as it was. There is NO consent banner and NO on-site switch for the pixel,
 * so 7.7 and 12.10 say so in those words and point at what the visitor really
 * controls: the browser and their Meta account settings. There is also NO
 * self-service deletion endpoint, so chapter 9
 * describes erasure as a request handled by a human — which is what actually
 * happens. Promising a button that does not exist is the failure this corpus
 * cannot afford.
 *
 * RETENTION PERIODS ARE PLACEHOLDERS. The code keeps orders, ledger rows,
 * acceptances and audit rows indefinitely; how long the owner INTENDS to keep
 * them is a decision, not a fact readable from a schema.
 *
 * VERSION 2 — WHY IT MOVED. Two corrections a customer could see on the
 * page; the archive keeps version 1 byte for byte.
 *   * THE NAME. The store is written «Levonis», in Latin script, in all three
 *     languages. 2 transliterated occurrences left the body here.
 *   * THE UNKNOWNS. 15 articles and 15 further lines in this document still state a
 *     fact the owner has not given, so ./render.ts WITHHOLDS them from the published
 *     text rather than show a customer a `{{TOKEN}}`. They are still authored
 *     below, and each one returns of its own accord the moment its value is
 *     written in and the version moves again.
 *
 * VERSION 3 — WHY IT MOVED. The archive keeps version 2 byte for byte.
 *   * THE FACTS. worker/lib/policies/facts.ts now states `BREACH_NOTIFICATION_HOURS`, `COMPETENT_COURT`, `GOVERNING_LAW_JURISDICTION`, `LEVONIS_SUPPORT_CONTACT`,
 *     so the clauses that carried them are published instead of withheld.
 *   * NO POINTER TO NOTHING. ./render.ts now also withholds a line that cites,
 *     by number, an article of this document that is itself withheld.
 *
 * VERSION 4 — WHY IT MOVED (owner, 2026-10-31). The archive keeps version 3
 * byte for byte.
 *   * THE META PIXEL. The owner is adding Meta's pixel to the main site and
 *     chose to disclose it rather than leave version 3 promising the
 *     opposite. Version 3 said: no advertising network (7.5); no marketing
 *     and no cross-site tracking cookie (12.1); no third-party advertising
 *     cookie and no sharing with an advertising network (12.6); no sharing
 *     for an advertising purpose (5.6); no advertising tracking (4.5); no
 *     code the Store did not supply runs in a page (11.2); nothing collected
 *     beyond service and legal need (1.5). Each is now narrowed to "apart
 *     from the Meta Pixel" or restated. The pixel itself is the new 7.5
 *     (where it runs), 7.6 (what Meta receives), 7.7 (purpose and Meta's
 *     role), the new purpose 4.7, 12.6 (its two cookies) and the new 12.10
 *     (no banner, no switch). Old 7.5 and 7.6 are now 7.8 and 7.9.
 *   * NOTHING PROMISED THAT DOES NOT EXIST. There is no consent banner and
 *     no on-site opt-out, so the text says so, and says what the browser and
 *     the Meta account settings can do instead.
 *   * THIS IS A CONSENT DOCUMENT. privacy is in CHECKOUT_POLICY_KEYS and
 *     QUICK_BUY_POLICY_KEYS, so this version asks every customer to accept
 *     again at their next order (13.2) and switches every Quick Buy profile
 *     off until its owner consents again (../quickBuy/profile.ts
 *     needsConsent). That is the point: a customer who accepted "there is no
 *     advertising network" has not accepted this. faq moved to 6 with it
 *     (its 9.4 said the same); faq is not a consent document.
 */
export const privacy: PolicyDocument = {
  key: 'privacy',
  version: 4,
  effective_at: '2026-10-31',
  title: {
    ar: 'سياسة الخصوصية',
    en: 'Privacy Policy',
    ckb: 'سیاسەتی تایبەتمەندێتی',
  },
  body: {
    ar: `## 1. التمهيد

### 1.1 الغرض من هذه الوثيقة
تبيّن هذه الوثيقة ما يجمعه Levonis من بيانات، ولماذا، وأين يُحفظ، ومن يطّلع عليه، وكم يبقى، وما حقوق الزبون فيه وكيف يمارسها.

### 1.2 المسؤول عن البيانات
{{LEVONIS_LEGAL_NAME}}، العنوان {{LEVONIS_ADDRESS}}، القناة المعتمدة {{LEVONIS_SUPPORT_CONTACT}}، ومسؤول البيانات {{DATA_PROTECTION_CONTACT}}.

### 1.3 النص المعتمد
النص العربي هو النص المعتمد، وعند اختلاف الترجمة يُعمل به.

### 1.4 القبول
هذه الوثيقة إحدى وثيقتين يُطلب قبولهما عند إتمام الطلب، والأخرى هي الشروط والأحكام العامة. ويُحفظ القبول موثقاً بنسخته ولغته وتاريخه.

### 1.5 مبدأ الوثيقة
لا يجمع المتجر بياناً لا يحتاجه لتنفيذ خدمة أو للوفاء بالتزام قانوني. والغرض الوحيد خارج هذين هو الإعلان المذكور في المادة 4.7، ولأجله يرسل الموقع الرئيسي إلى Meta ما تذكره المادة 7.6. وكل بند أدناه يذكر البيان والغرض منه معاً، فما لا غرض له لا يُجمع.

## 2. المصادر

### 2.1 ما يقدمه الزبون
ما يُدخله في التسجيل، وفي العنوان، وفي الطلب، وفي التذكرة، وفي المطالبة، وفي التقييم، وفي طلب الطباعة، وفي ملف الهوية إن تقدّم إلى PRO.

### 2.2 ما ينشأ عن الاستعمال
سجل الطلبات، وقيود المحفظة والنقاط، وسجل المراسلات داخل المنصة، وسجل الدخول، وسجلات التدقيق الإدارية.

### 2.3 ما يقدمه طرف ثالث
ما يرده من مزود تسجيل الدخول بجوجل عند اختيار الزبون ذلك، وما يرده من شركة التوصيل عن حالة الشحنة.

## 3. فئات البيانات

### 3.1 بيانات الحساب
اسم المستخدم، والاسم المعروض، والبريد الإلكتروني أو رقم الهاتف، ولغة الواجهة، وتاريخ الإنشاء، وحالة التحقق من المعرّف.

### 3.2 بيانات الاتصال والتسليم
اسم المستلم، ورقم الهاتف، والمحافظة، والعنوان التفصيلي، وملاحظات التسليم.

### 3.3 بيانات الطلب والدفع
سطور الطلب، والأسعار المطبقة، ووسيلة الدفع، وحالة الطلب والتحصيل، والفواتير. ولا يخزّن المتجر بيانات بطاقة دفع كاملة.

### 3.4 بيانات المحفظة والنقاط
قيود الرصيد والنقاط: سببها وتاريخها ومقدارها وحالتها.

### 3.5 بيانات الجهاز والضمان
موديل الجهاز، والرقم التسلسلي، وتاريخ الشراء، ومطالبات الضمان ومرفقاتها.

### 3.6 المراسلات
تذاكر الدعم وردودها، ومراسلات مطالبة الضمان، ومحادثات مجتمع ليفو بين الزبون والتاجر.

### 3.7 المحتوى المرفوع
الصور، وملفات النماذج ثلاثية الأبعاد، والمستندات التي يرفعها الزبون مع طلب أو تقييم أو تذكرة.

### 3.8 بيانات الهوية لعضوية PRO
الاسم الكامل، وتاريخ الميلاد، ورقم المستند، وصور الإثبات. وهذه الفئة وحدها تخضع للمادة 6.

### 3.9 البيانات التقنية
عنوان الشبكة، ونوع المتصفح، ووقت الطلب، ومعرّف الجلسة، وسجلات حدود المعدل والأمان.

## 4. أغراض المعالجة

### 4.1 تنفيذ الخدمة
إنشاء الحساب، ومعالجة الطلب، والتحصيل، والتوصيل، والفوترة، والضمان، والدعم، والنقاط والمكافآت.

### 4.2 الالتزام القانوني والمحاسبي
حفظ الفواتير والقيود المالية وسجلات القبول، بما يقتضيه {{GOVERNING_LAW_JURISDICTION}}.

### 4.3 الأمان ومنع الاحتيال
رموز التحقق لا تُخزَّن نصاً صريحاً ولا تُسجَّل في السجلات؛ يُحفظ منها قيمة تحقق مشتقة فقط. وتُستعمل سجلات الدخول والحدود لكشف محاولات الاستيلاء على الحسابات.

### 4.4 حدود المعدل
تُحفظ مفاتيح حدود المعدل بصيغة مُجزَّأة لا بصيغة المعرّف نفسه، حتى لا يتحول جدول المحاولات الفاشلة إلى قائمة بمن حاول الدخول.

### 4.5 التحسين
قياس ما يُستعمل من صفحات المتجر بصورة مجمَّعة، دون بيع بيانات. أما قياس إعلانات المتجر فغرض مستقل تبيّنه المادة 4.7.

### 4.6 الإشعارات
إرسال ما يخص الطلب والضمان والحساب عبر القنوات التي اختارها الزبون. والرسائل التسويقية تخضع للمادة 8.

### 4.7 الإعلان على فيسبوك وإنستغرام
قياس أثر إعلانات المتجر على فيسبوك وإنستغرام، وعرض إعلاناته هناك على الجمهور المعنيّ بها، بواسطة بكسل Meta في الموقع الرئيسي. وما يرسله وإلى من مبيَّن في المواد 7.5 إلى 7.7.

## 5. من يطّلع على البيانات

### 5.1 داخل المتجر
الموظفون المخوّلون بقدر ما تقتضيه المهمة، وكل اطلاع إداري على بيانات حساسة يُسجَّل في سجل التدقيق مع الفاعل والوقت.

### 5.2 التاجر في مجتمع ليفو
يرى التاجر ما يلزم لتنفيذ طلبه: اسم المستلم، ورقم الهاتف، وعنوان التسليم، وسطور طلبه. ولا يرى بقية طلبات الزبون ولا محفظته ولا نقاطه ولا هويته.

### 5.3 شركة التوصيل
ترى بيانات الشحنة والمستلم بقدر التسليم فقط.

### 5.4 الجهات الرسمية
عند طلب قانوني مكتوب من جهة مختصة، وبالقدر المطلوب.

### 5.5 المحادثات
محادثة مجتمع ليفو لا يقرؤها إلا طرفاها. لا يوجد في النظام باب خلفي يتيح للموظف قراءتها. والاستثناء الوحيد أن يقدّم أحد الطرفين المحادثة بنفسه دليلاً في نزاع.

### 5.6 لا بيع للبيانات
لا يبيع المتجر بيانات الزبائن ولا يؤجّرها. والمشاركة الوحيدة لغرض إعلاني هي بكسل Meta في الصفحات العامة من الموقع الرئيسي، في حدود المواد 7.5 إلى 7.7.

## 6. بيانات الهوية لعضوية PRO

### 6.1 اختيارية
لا تُطلب هذه البيانات إلا ممن يتقدم لعضوية PRO أو لمن يلزمه إثبات هوية لغرض منصوص عليه.

### 6.2 التشفير
الاسم وتاريخ الميلاد ورقم المستند تُحفظ مشفَّرة في قاعدة البيانات بمفتاح يديره المتجر. وهذا تشفير من جانب الخادم بمفاتيح مُدارة، **وليس تشفيراً طرفياً**: المتجر قادر تقنياً على فكّه عند الحاجة المشروعة، ولا يُوصف بغير ذلك.

### 6.3 صور الإثبات
تُحفظ في مخزن خاص غير عام، ولا يصل إليها إلا مسار إداري مدقَّق. ولا تُخدَم عبر روابط الملفات العامة إطلاقاً.

### 6.4 ما لا يجري
- لا يُجرى تعرّف على الوجه.
- لا تُرسَل الهوية إلى شركة تحقق خارجية.
- لا يُجرى استعلام من قاعدة بيانات حكومية.
- رفع المستند ليس تحققاً؛ التحقق قرار موظف مخوّل يُسجَّل باسمه وبوقته.

### 6.5 الحذف بعد الغرض
تُحذف صور الإثبات بعد {{KYC_EVIDENCE_RETENTION_MONTHS}} من البتّ في الطلب، ويبقى من الحالة قرارها وتاريخه ومن اتخذه، للاحتجاج به.

## 7. المعالِجون من الغير

### 7.1 البنية التحتية
يُشغَّل الموقع وقاعدة بياناته ومخزن ملفاته على بنية سحابية لدى مزود البنية التحتية، ويجري التخزين والمعالجة على خوادمه.

### 7.2 البريد الإلكتروني
تُرسَل رسائل الحساب والفواتير عبر مزود إرسال بريد، ويطّلع على عنوان المستلم ومحتوى الرسالة بقدر الإرسال.

### 7.3 واتساب
تُرسل رسائل واتساب عبر مزود وسيط يشغّل **حساب واتساب يملكه المتجر نفسه**. فالرقم الذي يصل الزبون رقم المتجر، لا واجهة برمجية لطرف ثالث.

### 7.4 تلغرام وجوجل
رسائل تلغرام تُرسَل إلى المحادثة الخاصة بالزبون وحدها ولا تُوجَّه إلى مجموعة. وتسجيل الدخول بجوجل يجري بتحقق من رمز هوية لدى جوجل عند اختيار الزبون ذلك، ويطّلع جوجل على واقعة الدخول.

### 7.5 بكسل Meta: أين يعمل
يحمِّل الموقع الرئيسي levonis-iq.com بكسل Meta، وهو شيفرة تقدّمها شركة Meta Platforms. ولا يُحمَّل في النطاقات الفرعية لمتاجر التجار، مثل ali3d.levonis-iq.com، ولا في تطبيق Print Cloud.
- يُبلِّغ من صفحات التسوق والتصفح العامة وحدها: الصفحة الرئيسية، وقوائم المنتجات وصفحاتها، والفئات، والمقارنة، والطابعات المستعملة، والحزم، والسلة، وإتمام الطلب، وصفحات المجتمع التي يتصفحها أي أحد (المتاجر والصنّاع والمشاريع والملفات الشخصية العامة)، والأدوات، ومرشد الطابعات، وصفحات السياسات.
- لا يُبلِّغ بشيء من أي صفحة أخرى، ومنها صفحات الحساب، والإعدادات، والمحفظة، والطلبات، وتتبع الطلب، والمحادثات، وتسجيل الدخول، والإدارة، ولوحة التاجر، والضمان والإيصال، والصفحات التي تُفتح برابط خاص.

### 7.6 بكسل Meta: ما تتلقاه Meta
الحدث الوحيد المُرسَل هو مشاهدة صفحة («PageView»). وجمع الأحداث التلقائي لدى Meta (نقرات الأزرار وبيانات الصفحة الوصفية) معطَّل، ولا تُستعمل المطابقة المتقدمة: لا يرسل الموقع إلى Meta اسماً ولا بريداً إلكترونياً ولا رقم هاتف ولا معرّف حساب. ومع كل مشاهدة صفحة تتلقى Meta:
- عنوان الصفحة كاملاً، بما فيه ما يلي علامة «?».
- الصفحة المُحيلة.
- الوقت.
- معلومات المتصفح والجهاز.
- عنوان الشبكة (IP) للزائر، كما تراه خوادم Meta.
- معرّفات Meta الخاصة بها، من ملفات تعريف الارتباط في المادة 12.6.
وإذا كان الزائر مسجِّلاً دخوله إلى فيسبوك أو إنستغرام في المتصفح نفسه، فقد تربط Meta الزيارة بذلك الحساب وفق سياساتها هي.

### 7.7 بكسل Meta: الغرض ودور Meta
الغرض قياس أثر إعلانات المتجر على فيسبوك وإنستغرام، وعرض إعلاناته هناك على الجمهور المعنيّ بها. لا تُباع بيانات، ولا تبني المنصة بنفسها ملفاً إعلانياً. وMeta ليست معالِجاً يعمل لحساب المتجر: فهي تعالج هذه البيانات بصفتها مسؤولاً مستقلاً عنها، وفق شروطها وسياسة الخصوصية الخاصة بها، خارج العراق. ولا يطلب الموقع موافقة على البكسل ولا يوفّر مفتاحاً لإيقافه؛ وما بيد الزائر مبيَّن في المادة 12.10.

### 7.8 ما لا يوجد
عدا بكسل Meta في المواد 7.5 إلى 7.7، لا توجد شبكة إعلانات، ولا أداة تحليلات من طرف ثالث داخل الصفحات، ولا مشاركة بيانات لغرض تسويقي خارجي.

### 7.9 نقل البيانات خارج العراق
قد تُعالَج البيانات على خوادم خارج العراق بحكم طبيعة هذه الخدمات. ويلتزم المتجر، في المعالِجين المذكورين في المواد 7.1 إلى 7.4، باختيار مزودين يوفرون حماية مناسبة تعاقدياً. أما ما يرسله بكسل Meta فتعالجه Meta خارج العراق وفق شروطها وسياسة الخصوصية الخاصة بها، كما تبيّن المادة 7.7.

## 8. الإشعارات والتسويق

### 8.1 الإشعارات التشغيلية
إشعارات الطلب والدفع والتوصيل والضمان والأمان جزء من الخدمة، ولا يمكن إيقافها مع بقاء الخدمة.

### 8.2 الرسائل التسويقية
لا تُرسَل إلا بموافقة، ويوقفها الزبون متى شاء من إعدادات حسابه أو عبر القناة المعتمدة، ولا يؤثر الإيقاف على إشعارات المادة 8.1.

### 8.3 قناة واحدة لكل غرض
يختار الزبون قناة الإشعار — بريد أو واتساب أو تلغرام — ويغيّرها من حسابه.

## 9. حقوق الزبون

### 9.1 الاطلاع
للزبون أن يطلب بياناً بما هو محفوظ عنه، ويُجاب خلال {{DATA_REQUEST_DAYS}}.

### 9.2 التصحيح
له تصحيح بياناته، وأكثرها قابل للتعديل مباشرة من حسابه.

### 9.3 نسخة من البيانات
له طلب نسخة بصيغة مقروءة آلياً، عبر القناة المعتمدة.

### 9.4 الحذف
لا يوجد في الموقع زر حذف ذاتي للحساب. يُقدَّم الطلب عبر القناة المعتمدة ويُنفَّذ خلال {{ACCOUNT_CLOSURE_PROCESSING_DAYS}}، بعد إغلاق الطلبات القائمة وتسوية الأرصدة.

### 9.5 حدود الحذف
لا يُحذف ما يلزم حفظه قانوناً أو محاسبياً: الفواتير، والقيود المالية، وسجلات قبول الوثائق، وسجلات التدقيق. ويُقيَّد الوصول إليها ويُفصل عن البيانات القابلة للحذف.

### 9.6 سحب الموافقة
لسحب الموافقة أثر مستقبلي فقط، ولا يبطل معالجة جرت قبله على أساس مشروع.

### 9.7 الشكوى
تُقدَّم الشكوى إلى {{DATA_PROTECTION_CONTACT}}، ويُردّ عليها خلال {{DISPUTE_RESPONSE_DAYS}}، دون إخلال بحق الزبون في اللجوء إلى {{COMPETENT_COURT}}.

## 10. مدد الحفظ

### 10.1 الحساب
تُحفظ بيانات الحساب ما دام قائماً، وتُحذف أو تُجهَّل بعد إغلاقه وفق المادة 9.5.

### 10.2 الطلبات والفواتير
{{ORDER_RECORD_RETENTION_YEARS}}.

### 10.3 المحفظة والنقاط
{{WALLET_RECORD_RETENTION_YEARS}}.

### 10.4 قبول الوثائق
{{POLICY_ACCEPTANCE_RETENTION_YEARS}} — وتُحفظ مع نسخة الوثيقة المقبولة ولغتها حتى تبقى قابلة للقراءة بعد سنوات.

### 10.5 المحادثات والتذاكر
{{CHAT_RETENTION_YEARS}}.

### 10.6 سجلات التدقيق
{{AUDIT_LOG_RETENTION_YEARS}}.

### 10.7 السجلات التقنية
{{TECHNICAL_LOG_RETENTION_DAYS}}.

## 11. الأمان

### 11.1 النقل
كل الاتصال بالموقع مشفَّر أثناء النقل، والمتصفح مُلزَم باستعمال الاتصال المؤمَّن.

### 11.2 الحماية داخل الصفحة
يطبّق الموقع سياسة محتوى لا يُنفَّذ بموجبها في الصفحة إلا شيفرة المتجر نفسه وشيفرات الخدمات الخارجية التي يحمّلها عن قصد، مثل تسجيل الدخول بجوجل وبكسل Meta؛ أما الشيفرة المحقونة في الصفحة فلا تُنفَّذ. والغرض ألا يُستغل نص يكتبه تاجر أو زبون في المساس بزائر.

### 11.3 الجلسة
الجلسة مشتركة بين النطاق الرئيسي ونطاقات التجار حتى يعمل الشراء عليها، ولا يمنح ذلك التاجر أي اطلاع على بيانات الزائر.

### 11.4 كلمة المرور
لا تُحفظ كلمة المرور نصاً صريحاً، ولا يستطيع الموظف قراءتها.

### 11.5 حدود ما يُوعد به
لا يوجد نظام محصَّن مطلقاً. ويلتزم المتجر عند وقوع خرق يمس بيانات الزبائن بإبلاغ المتأثرين خلال {{BREACH_NOTIFICATION_HOURS}} ساعة من العلم به، مع بيان ما وقع وما يُنصح به.

## 12. ملفات تعريف الارتباط والتخزين المحلي

### 12.1 ما يستعمله المتجر
يستعمل الموقع والتطبيق ملف تعريف ارتباط واحداً للجلسة، وقدراً محدوداً من التخزين المحلي داخل متصفح الزبون. وفي الموقع الرئيسي تضع شيفرة Meta أيضاً ملفات الإعلان المذكورة في المادة 12.6؛ وعداها لا يوجد في المنصة ملف تعريف ارتباط للتسويق.

### 12.2 ملف الجلسة
ملف تعريف ارتباط الجلسة هو ما يبقي الزبون داخلاً إلى حسابه بين صفحة وأخرى. وهو ملف ضروري لتشغيل الخدمة: لا يمكن تصفح الحساب ولا إتمام طلب بدونه، ولذلك لا يُطلب فيه رضا منفصل.

### 12.3 صفات ملف الجلسة
لا يُقرأ ملف الجلسة من برامج الصفحة، ولا يُرسل إلا عبر اتصال مشفّر، ولا يُرسل مع طلبات واردة من مواقع أخرى. وهذه القيود موضوعة لمنع سرقة الجلسة.

### 12.4 متى ينتهي
ينتهي ملف الجلسة بانتهاء مدتها أو بخروج الزبون أو بإنهاء جلساته من حسابه، وأحكام ذلك في وثيقة التسجيل والحسابات.

### 12.5 التخزين المحلي
يُحفظ داخل المتصفح قدر يسير من التفضيلات، مثل طريقة عرض قائمة وصيغة عملة يفضّل الزبون رؤيتها. وهذه بيانات راحة لا تُرسل إلى المتجر ولا تُربط بهوية ولا تُستعمل في تتبع.

### 12.6 ملفات Meta الإعلانية
في الموقع الرئيسي تضع شيفرة Meta ملفات تعريف ارتباط من الطرف الأول على نطاق الموقع: \u200E_fbp، وهو معرّف للمتصفح يبقى حتى 90 يوماً ويتجدد مع الزيارات اللاحقة؛ و\u200E_fbc، وهو معرّف النقر على الإعلان، ويُوضع حين يصل الزائر من رابط إعلان لـ Meta يحمل fbclid، ويبقى حتى 90 يوماً. وعدا هذين لا يزرع المتجر ملف تعريف ارتباط إعلانياً، ولا يبيع بيانات تصفح، ولا يبني ملفاً إعلانياً عن الزبون، ولا يشارك سلوكه في المنصة مع شبكة إعلانات غير Meta، ولا مع Meta إلا في حدود المادة 7.6.

### 12.7 حذفها
لصاحب الجهاز أن يحذف ملفات تعريف الارتباط والتخزين المحلي من إعدادات متصفحه في أي وقت. وأثر حذف ملف الجلسة هو الخروج من الحساب ولا أكثر. وحذف \u200E_fbp أو \u200E_fbc لا أثر له في استعمال المتجر.

### 12.8 منع الملفات
من منع ملفات تعريف الارتباط في متصفحه تعذّر عليه الدخول إلى حسابه، لأن الدخول نفسه يقوم عليها. ولا يُعد ذلك عطلاً في الخدمة. أما منع شيفرة Meta أو ملفاتها وحدها فلا يؤثر في استعمال المتجر.

### 12.9 روابط الغير
قد تتضمن المنصة روابط إلى مواقع لا يديرها المتجر. وما يزرعه ذلك الموقع في جهازك بعد مغادرتك المنصة تحكمه سياسته هو لا هذه الوثيقة.

### 12.10 لا نافذة موافقة ولا مفتاح إيقاف
لا يعرض الموقع نافذة لطلب الموافقة على بكسل Meta وملفاته، ولا يوفّر مفتاحاً خاصاً به لإيقافها. وما بيد الزائر هو متصفحه — منع ملفات تعريف الارتباط والشيفرات الخارجية أو حذفها، وفق المادتين 12.7 و12.8 — وتفضيلات الإعلانات في إعدادات حسابه لدى Meta.

## 13. أحكام ختامية

### 13.1 الأطفال
لا يوجّه المتجر خدماته إلى من هم دون {{MIN_ACCOUNT_AGE_YEARS}}، ولا يجمع بياناتهم عن قصد. وما يصل منها يُحذف عند العلم.

### 13.2 التعديل
تُعدَّل هذه الوثيقة بنسخة جديدة، ويُطلب قبول النسخة الجديدة عند الطلب التالي، وتبقى النسخة المقبولة سابقاً محفوظة قابلة للقراءة.

### 13.3 التعارض
عند التعارض في مسألة بيانات بين هذه الوثيقة وغيرها من وثائق المتجر، تسري هذه الوثيقة.

### 13.4 القانون والاختصاص
تسري على هذه الوثيقة {{GOVERNING_LAW_JURISDICTION}}، والاختصاص ل{{COMPETENT_COURT}}.`,
    en: `## 1. Preliminary

### 1.1 Purpose
This document sets out what data Levonis collects, why, where it is held, who sees it, how long it is kept, and what rights the Customer has in it and how to exercise them.

### 1.2 Data controller
{{LEVONIS_LEGAL_NAME}}, address {{LEVONIS_ADDRESS}}, approved channel {{LEVONIS_SUPPORT_CONTACT}}, data contact {{DATA_PROTECTION_CONTACT}}.

### 1.3 Authoritative text
The Arabic text is authoritative and prevails where a translation differs.

### 1.4 Acceptance
This is one of the two documents whose acceptance is required to place an order; the other is the General Terms and Conditions. Acceptance is recorded with its version, its language and its date.

### 1.5 Principle
The Store does not collect data it does not need to perform a service or to meet a legal obligation. The one purpose beyond these is the advertising of article 4.7, for which the main site sends Meta what article 7.6 lists. Every provision below names the data and its purpose together; anything with no purpose is not collected.

## 2. Sources

### 2.1 Provided by the Customer
What they enter at registration, in an address, in an order, in a ticket, in a claim, in a review, in a print request, and in an identity file if they apply for PRO.

### 2.2 Generated by use
Order history, wallet and points records, in-platform correspondence, sign-in records, and administrative audit records.

### 2.3 Provided by a third party
What the Google sign-in provider returns when the Customer chooses it, and what the delivery company returns about a shipment's status.

## 3. Categories of data

### 3.1 Account data
Username, display name, email address or phone number, interface language, creation date, and the verification status of the identifier.

### 3.2 Contact and delivery data
Recipient name, phone number, governorate, detailed address, and delivery notes.

### 3.3 Order and payment data
Order lines, applied prices, payment method, order and collection status, and invoices. The Store does not store full payment-card data.

### 3.4 Wallet and points data
Balance and points records: their reason, date, amount and state.

### 3.5 Device and warranty data
Device model, serial number, purchase date, warranty claims and their attachments.

### 3.6 Correspondence
Support tickets and replies, warranty-claim messages, and Levo community conversations between Customer and merchant.

### 3.7 Uploaded content
Images, 3D model files and documents uploaded by the Customer with an order, a review or a ticket.

### 3.8 Identity data for PRO membership
Full name, date of birth, document number, and evidence images. This category alone is governed by chapter 6.

### 3.9 Technical data
Network address, browser type, request time, session identifier, and rate-limit and security records.

## 4. Purposes of processing

### 4.1 Performing the service
Creating the account, processing the order, collection, delivery, invoicing, warranty, support, and points and rewards.

### 4.2 Legal and accounting obligations
Retaining invoices, financial records and acceptance records as required by {{GOVERNING_LAW_JURISDICTION}}.

### 4.3 Security and fraud prevention
One-time codes are never stored in clear and never written to logs; only a derived verifier is kept. Sign-in and limit records are used to detect account-takeover attempts.

### 4.4 Rate limits
Rate-limit keys are stored hashed rather than as the identifier itself, so that a table of failed attempts does not become a list of who tried to sign in.

### 4.5 Improvement
Measuring, in aggregate, which store pages are used — with no sale of data. Measuring the Store's advertising is a separate purpose, set out in article 4.7.

### 4.6 Notifications
Sending order, warranty and account messages through the channels the Customer chose. Marketing messages are governed by chapter 8.

### 4.7 Advertising on Facebook and Instagram
Measuring the effect of the Store's advertising on Facebook and Instagram, and showing the Store's ads to relevant audiences there, through the Meta Pixel on the main site. What it sends, and to whom, is set out in articles 7.5 to 7.7.

## 5. Who sees the data

### 5.1 Inside the Store
Authorised staff, to the extent the task requires. Every administrative access to sensitive data is written to the audit record with the actor and the time.

### 5.2 A merchant in Levo community
The merchant sees what is needed to fulfil their own order: recipient name, phone number, delivery address and their own order lines. They do not see the Customer's other orders, wallet, points or identity.

### 5.3 The delivery company
It sees shipment and recipient data to the extent required for delivery.

### 5.4 Authorities
On a written legal request from a competent authority, to the extent required.

### 5.5 Conversations
A Levo community conversation is readable only by its two parties. There is no back door in the system that lets a staff member read it. The single exception is that a party may themselves submit a conversation as evidence in a dispute.

### 5.6 No sale of data
The Store does not sell or rent customer data. The one sharing for an advertising purpose is the Meta Pixel on the public pages of the main site, within the limits of articles 7.5 to 7.7.

## 6. Identity data for PRO membership

### 6.1 Optional
This data is requested only from those applying for PRO membership, or where identity proof is required for a stated purpose.

### 6.2 Encryption
Name, date of birth and document number are stored encrypted in the database under a key managed by the Store. This is server-side encryption with managed keys and is **not end-to-end encryption**: the Store is technically able to decrypt it for a legitimate need, and it is not described otherwise.

### 6.3 Evidence images
They are held in a private, non-public store reachable only through an audited administrative path. They are never served through public file links.

### 6.4 What does not happen
- No face recognition is performed.
- Identity is not sent to an external verification company.
- No government database is queried.
- Uploading a document is not verification; verification is the decision of an authorised staff member, recorded with their name and the time.

### 6.5 Deletion after purpose
Evidence images are deleted {{KYC_EVIDENCE_RETENTION_MONTHS}} after the application is decided; what remains of the case is its decision, its date and who took it, so that it can be relied on.

## 7. Third-party processors

### 7.1 Infrastructure
The site, its database and its file store run on cloud infrastructure at the infrastructure provider, and storage and processing take place on its servers.

### 7.2 Email
Account messages and invoices are sent through an email provider, which sees the recipient address and the message content to the extent required to send.

### 7.3 WhatsApp
WhatsApp messages are sent through an intermediary provider that drives **a WhatsApp account the Store itself owns**. The number the Customer sees is therefore the Store's own number, not a third-party programming interface.

### 7.4 Telegram and Google
Telegram messages go only to the Customer's own private chat and are never routed to a group. Google sign-in verifies an identity token with Google when the Customer chooses it, and Google learns of the sign-in event.

### 7.5 The Meta Pixel: where it runs
The main site, levonis-iq.com, loads the Meta Pixel, a script supplied by Meta Platforms. It is not loaded on merchants' store subdomains, such as ali3d.levonis-iq.com, or in the Print Cloud application.
- It reports only from public shopping and browsing pages: the home page, product listings and product pages, categories, compare, used printers, bundles, the cart, checkout, the community pages anyone can browse (stores, makers, projects and public profiles), tools, the printer finder and the policy pages.
- It reports nothing from any other page, including the account, settings, wallet, orders, order tracking, chats, sign-in, administration, the merchant dashboard, warranty and receipt pages, and pages opened by a private link.

### 7.6 The Meta Pixel: what Meta receives
The only event sent is a page view ("PageView"). Meta's automatic event collection (button clicks, page metadata) is switched off, and no advanced matching is used: the site sends Meta no name, email address, phone number or account identifier. With each page view, Meta receives:
- The page address, including its query string.
- The referring page.
- The time.
- Browser and device information.
- The visitor's IP address, as Meta's servers see it.
- Meta's own identifiers, from the cookies in article 12.6.
If the visitor is signed in to Facebook or Instagram in the same browser, Meta may link the visit to that account under Meta's own policies.

### 7.7 The Meta Pixel: purpose and Meta's role
The purpose is measuring the effect of the Store's advertising on Facebook and Instagram and showing the Store's ads to relevant audiences there. No data is sold, and the platform builds no advertising profile of its own. Meta is not a processor acting for the Store: it processes this data as a separate controller, under its own terms and privacy policy, outside Iraq. The site asks no consent for the pixel and has no switch to turn it off; what the visitor controls is set out in article 12.10.

### 7.8 What does not exist
Apart from the Meta Pixel of articles 7.5 to 7.7, there is no advertising network, no third-party analytics tool inside the pages, and no sharing of data for external marketing.

### 7.9 Transfers outside Iraq
Data may be processed on servers outside Iraq by the nature of these services. For the processors of articles 7.1 to 7.4, the Store undertakes to select providers offering appropriate contractual protection. What the Meta Pixel sends is processed by Meta outside Iraq under Meta's own terms and privacy policy, as article 7.7 states.

## 8. Notifications and marketing

### 8.1 Operational notifications
Order, payment, delivery, warranty and security notifications are part of the service and cannot be switched off while the service continues.

### 8.2 Marketing messages
These are sent only with consent, the Customer may stop them at any time from account settings or through the approved channel, and stopping them does not affect the notifications in article 8.1.

### 8.3 One channel per purpose
The Customer chooses a notification channel — email, WhatsApp or Telegram — and changes it from their account.

## 9. Customer rights

### 9.1 Access
The Customer may request a statement of what is held about them, answered within {{DATA_REQUEST_DAYS}}.

### 9.2 Rectification
They may correct their data; most of it is editable directly from their account.

### 9.3 A copy of the data
They may request a copy in a machine-readable format through the approved channel.

### 9.4 Erasure
There is no self-service account-deletion button on the site. The request is made through the approved channel and carried out within {{ACCOUNT_CLOSURE_PROCESSING_DAYS}}, after open orders are closed and balances settled.

### 9.5 Limits of erasure
What must be kept by law or for accounting is not deleted: invoices, financial records, document-acceptance records and audit records. Access to them is restricted and they are separated from the erasable data.

### 9.6 Withdrawing consent
Withdrawal has effect for the future only and does not invalidate processing carried out before it on a lawful basis.

### 9.7 Complaints
A complaint is made to {{DATA_PROTECTION_CONTACT}} and answered within {{DISPUTE_RESPONSE_DAYS}}, without prejudice to the Customer's right to apply to {{COMPETENT_COURT}}.

## 10. Retention periods

### 10.1 Account
Account data is kept while the account exists, and is deleted or anonymised after closure under article 9.5.

### 10.2 Orders and invoices
{{ORDER_RECORD_RETENTION_YEARS}}.

### 10.3 Wallet and points
{{WALLET_RECORD_RETENTION_YEARS}}.

### 10.4 Document acceptances
{{POLICY_ACCEPTANCE_RETENTION_YEARS}} — kept together with the accepted version of the document and its language, so that it remains readable years later.

### 10.5 Conversations and tickets
{{CHAT_RETENTION_YEARS}}.

### 10.6 Audit records
{{AUDIT_LOG_RETENTION_YEARS}}.

### 10.7 Technical logs
{{TECHNICAL_LOG_RETENTION_DAYS}}.

## 11. Security

### 11.1 In transit
All communication with the site is encrypted in transit, and the browser is required to use the secured connection.

### 11.2 In-page protection
The site applies a content policy under which only the Store's own code and the scripts of the outside services it deliberately loads, such as Google sign-in and the Meta Pixel, can run in a page; code injected into a page cannot. Its purpose is that text written by a merchant or a customer cannot be used to harm a visitor.

### 11.3 The session
The session is shared between the main domain and merchant domains so that purchasing works there; this grants the merchant no access to visitor data.

### 11.4 Passwords
A password is never stored in clear and cannot be read by a staff member.

### 11.5 The limit of what is promised
No system is absolutely secure. Should a breach affecting customer data occur, the Store undertakes to notify those affected within {{BREACH_NOTIFICATION_HOURS}} hours of becoming aware, stating what happened and what is advised.

## 12. Cookies and local storage

### 12.1 What the Store uses
The site and the application use one session cookie and a limited amount of local storage inside the customer's browser. On the main site, Meta's script also sets the advertising cookies of article 12.6; apart from them, there is no marketing cookie on the platform.

### 12.2 The session cookie
The session cookie is what keeps the customer signed in from one page to the next. It is strictly necessary to operate the service: the account cannot be browsed and an order cannot be completed without it, and for that reason no separate consent is sought for it.

### 12.3 The attributes of the session cookie
The session cookie is not readable by page scripts, is sent only over an encrypted connection, and is not sent with requests arriving from other sites. These restrictions exist to prevent session theft.

### 12.4 When it ends
The session cookie ends when the session expires, when the customer signs out, or when they end their sessions from their account; the provisions on that are in the Registration and Accounts document.

### 12.5 Local storage
A small amount of preference data is kept inside the browser, such as the chosen layout of a list and the currency format the customer prefers to see. This is convenience data: it is not sent to the Store, is not linked to an identity and is not used for tracking.

### 12.6 Meta's advertising cookies
On the main site, Meta's script sets first-party cookies on the site's domain: _fbp, a browser identifier kept for up to 90 days and renewed on later visits; and _fbc, the ad click identifier, set when the visitor arrives from a Meta ad link carrying fbclid and kept for up to 90 days. Apart from these two, the Store places no advertising cookie, does not sell browsing data, does not build an advertising profile of the customer, and shares their behaviour on the platform with no advertising network other than Meta, and with Meta only to the extent of article 7.6.

### 12.7 Deleting them
The holder of the device may delete cookies and local storage from their browser settings at any time. The effect of deleting the session cookie is being signed out, and nothing more. Deleting _fbp or _fbc has no effect on using the store.

### 12.8 Blocking cookies
A person who blocks cookies in their browser will be unable to sign in to their account, because signing in rests upon them. That is not a fault in the service. Blocking only Meta's script or its cookies does not affect using the store.

### 12.9 Third-party links
The platform may contain links to sites the Store does not operate. What such a site places on your device after you leave the platform is governed by its own policy and not by this document.

### 12.10 No consent banner and no switch
The site shows no consent banner for the Meta Pixel and its cookies, and has no switch of its own to turn them off. What the visitor controls is their browser — blocking or deleting cookies and outside scripts, articles 12.7 and 12.8 — and the ad preferences in their Meta account settings.

## 13. Final provisions

### 13.1 Children
The Store does not direct its services to anyone under {{MIN_ACCOUNT_AGE_YEARS}} and does not knowingly collect their data. Any such data received is deleted once known.

### 13.2 Amendment
This document is amended by a new version; acceptance of the new version is requested at the next order, and the previously accepted version remains stored and readable.

### 13.3 Conflict
On a data question, this document prevails over the Store's other documents.

### 13.4 Governing law and forum
This document is governed by {{GOVERNING_LAW_JURISDICTION}}, and {{COMPETENT_COURT}} have jurisdiction.`,
    ckb: `## 1. پێشەکی

### 1.1 مەبەستی ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە ڕوون دەکاتەوە Levonis چ داتایەک کۆدەکاتەوە، بۆچی، لە کوێ دەیپارێزێت، کێ دەیبینێت، چەند دەمێنێتەوە، و کڕیار چ مافێکی تێدایە و چۆن بەکاری دەهێنێت.

### 1.2 بەرپرسی داتا
{{LEVONIS_LEGAL_NAME}}، ناونیشان {{LEVONIS_ADDRESS}}، کەناڵی پەسەندکراو {{LEVONIS_SUPPORT_CONTACT}}، و پەیوەندیی داتا {{DATA_PROTECTION_CONTACT}}.

### 1.3 دەقی بنەڕەت
دەقی عەرەبی بنەڕەتە و لە کاتی جیاوازی وەرگێڕاندا کاری پێدەکرێت.

### 1.4 پەسەندکردن
ئەمە یەکێکە لەو دوو بەڵگەنامەیەی پەسەندکردنیان بۆ دانانی داواکارییەک پێویستە؛ ئەویتریان مەرج و ڕێسا گشتییەکانن. پەسەندکردن بە وەشان و زمان و بەرواریەوە تۆمار دەکرێت.

### 1.5 بنەمای بەڵگەنامەکە
فرۆشگا ئەو داتایە کۆناکاتەوە کە پێویستی پێی نییە بۆ ئەنجامدانی خزمەتگوزارییەک یان بۆ جێبەجێکردنی ئەرکێکی یاسایی. تاکە مەبەستێک لە دەرەوەی ئەم دووانە ڕیکلامە بەپێی بڕگەی 4.7، کە لە پێناویدا ماڵپەڕی سەرەکی ئەوەی لە بڕگەی 7.6دا هاتووە بۆ Meta دەنێرێت. هەر بڕگەیەکی خوارەوە داتاکە و مەبەستەکەی پێکەوە دەڵێت؛ ئەوەی مەبەستی نییە کۆناکرێتەوە.

## 2. سەرچاوەکان

### 2.1 ئەوەی کڕیار دەیدات
ئەوەی لە تۆمارکردن، لە ناونیشان، لە داواکاری، لە بلیت، لە داواکاری گەرەنتی، لە هەڵسەنگاندن، لە داواکاری چاپ، و لە فایلی ناسنامەدا — ئەگەر داوای PRO بکات — دەینووسێت.

### 2.2 ئەوەی لە بەکارهێنانەوە دروست دەبێت
مێژووی داواکارییەکان، تۆمارەکانی جزدان و خاڵ، نامەنووسینی ناو پلاتفۆرم، تۆماری چوونەژوورەوە، و تۆمارە کارگێڕییەکانی پشکنین.

### 2.3 ئەوەی لایەنی سێیەم دەیدات
ئەوەی دابینکەری چوونەژوورەوەی گووگڵ دەیگەڕێنێتەوە کاتێک کڕیار هەڵیدەبژێرێت، و ئەوەی کۆمپانیای گەیاندن دەربارەی دۆخی بارەکە دەیگەڕێنێتەوە.

## 3. پۆلەکانی داتا

### 3.1 داتای هەژمار
ناوی بەکارهێنەر، ناوی پیشاندراو، ئیمەیڵ یان ژمارەی مۆبایل، زمانی ڕووکار، بەرواری دروستکردن، و دۆخی پشتڕاستکردنەوەی ناسێنەر.

### 3.2 داتای پەیوەندی و گەیاندن
ناوی وەرگر، ژمارەی مۆبایل، پارێزگا، ناونیشانی وردەکاری، و تێبینییەکانی گەیاندن.

### 3.3 داتای داواکاری و پارەدان
هێڵەکانی داواکاری، نرخە جێبەجێکراوەکان، ڕێگەی پارەدان، دۆخی داواکاری و وەرگرتن، و پسوولەکان. فرۆشگا داتای تەواوی کارتی پارەدان هەڵناگرێت.

### 3.4 داتای جزدان و خاڵ
تۆمارەکانی باڵانس و خاڵ: هۆکار و بەروار و بڕ و دۆخیان.

### 3.5 داتای ئامێر و گەرەنتی
مۆدێلی ئامێر، ژمارەی زنجیرەیی، بەرواری کڕین، داواکارییەکانی گەرەنتی و هاوپێچەکانیان.

### 3.6 نامەنووسین
بلیتەکانی پشتگیری و وەڵامەکانیان، نامەکانی داواکاری گەرەنتی، و گفتوگۆکانی کۆمەڵگەی لێڤۆ لە نێوان کڕیار و بازرگاندا.

### 3.7 ناوەڕۆکی بارکراو
وێنە، فایلی مۆدێلی سێ ڕەهەندی، و ئەو بەڵگەنامانەی کڕیار لەگەڵ داواکاری یان هەڵسەنگاندن یان بلیتێکدا بار دەکات.

### 3.8 داتای ناسنامە بۆ ئەندامێتی PRO
ناوی تەواو، بەرواری لەدایکبوون، ژمارەی بەڵگەنامە، و وێنەی بەڵگە. تەنها ئەم پۆلە بە بەشی 6 ڕێک دەخرێت.

### 3.9 داتای تەکنیکی
ناونیشانی تۆڕ، جۆری وێبگەڕ، کاتی داواکاری، ناسێنەری دانیشتن، و تۆمارەکانی سنووری ڕێژە و ئاسایش.

## 4. مەبەستەکانی پرۆسێسکردن

### 4.1 ئەنجامدانی خزمەتگوزاری
دروستکردنی هەژمار، پرۆسێسکردنی داواکاری، وەرگرتنی پارە، گەیاندن، پسوولەکردن، گەرەنتی، پشتگیری، و خاڵ و خەڵات.

### 4.2 ئەرکی یاسایی و ژمێریاری
پاراستنی پسوولە و تۆماری دارایی و تۆماری پەسەندکردن، بەو ئەندازەیەی {{GOVERNING_LAW_JURISDICTION}} داوای دەکات.

### 4.3 ئاسایش و ڕێگریکردن لە فێڵ
کۆدی یەکجارە هەرگیز بە دەقی ڕوون هەڵناگیرێت و لە تۆمارەکاندا نانووسرێت؛ تەنها بەهایەکی پشتڕاستکەرەوەی لێوەرگیراو دەپارێزرێت. تۆمارەکانی چوونەژوورەوە و سنوورەکان بۆ دۆزینەوەی هەوڵی داگیرکردنی هەژمار بەکاردێن.

### 4.4 سنووری ڕێژە
کلیلەکانی سنووری ڕێژە بە شێوەی هاش هەڵدەگیرێن نەک وەک خودی ناسێنەرەکە، تا خشتەی هەوڵە سەرنەکەوتووەکان نەبێتە لیستی ئەوانەی هەوڵی چوونەژوورەوەیان داوە.

### 4.5 باشترکردن
پێوانەکردنی ئەوەی کام لاپەڕەی فرۆشگا بەکاردێت بە شێوەی کۆکراوە، بەبێ فرۆشتنی داتا. پێوانەکردنی ڕیکلامەکانی فرۆشگا مەبەستێکی جیایە و بڕگەی 4.7 باسی دەکات.

### 4.6 ئاگادارکردنەوەکان
ناردنی ئەوەی پەیوەندی بە داواکاری و گەرەنتی و هەژمارەوە هەیە لە ڕێگەی ئەو کەناڵانەی کڕیار هەڵیبژاردوون. نامەی بازاڕگەری بە بەشی 8 ڕێک دەخرێت.

### 4.7 ڕیکلام لە فەیسبووک و ئینستاگرام
پێوانەکردنی کاریگەریی ڕیکلامەکانی فرۆشگا لە فەیسبووک و ئینستاگرام، و پیشاندانی ڕیکلامەکانی لەوێ بۆ ئەو بینەرانەی پەیوەندییان پێیەوە هەیە، لە ڕێگەی پیکسڵی Meta لە ماڵپەڕی سەرەکیدا. ئەوەی دەینێرێت و بۆ کێ دەینێرێت، لە بڕگەکانی 7.5 تا 7.7دا ڕوون کراوەتەوە.

## 5. کێ داتاکە دەبینێت

### 5.1 لە ناو فرۆشگا
کارمەندە مۆڵەتپێدراوەکان بەو ئەندازەیەی ئەرکەکە داوای دەکات. هەر دەستڕاگەیشتنێکی کارگێڕی بە داتای هەستیار لە تۆماری پشکنیندا بە کردار و کاتەوە دەنووسرێت.

### 5.2 بازرگان لە کۆمەڵگەی لێڤۆ
بازرگان ئەوە دەبینێت کە بۆ جێبەجێکردنی داواکارییەکەی پێویستە: ناوی وەرگر، ژمارەی مۆبایل، ناونیشانی گەیاندن، و هێڵەکانی داواکارییەکەی خۆی. داواکارییەکانی تری کڕیار، جزدان، خاڵ یان ناسنامەی نابینێت.

### 5.3 کۆمپانیای گەیاندن
داتای بارەکە و وەرگر تەنها بەو ئەندازەیەی بۆ گەیاندن پێویستە دەبینێت.

### 5.4 دەسەڵاتە فەرمییەکان
لە کاتی داواکارییەکی یاساییی نووسراوەوە لە لایەنێکی پسپۆڕەوە، و بەو ئەندازەیەی داوا کراوە.

### 5.5 گفتوگۆکان
گفتوگۆی کۆمەڵگەی لێڤۆ تەنها لەلایەن دوو لایەنەکەیەوە دەخوێنرێتەوە. هیچ دەرگایەکی پشتەوە لە سیستەمەکەدا نییە کە ڕێگە بە کارمەندێک بدات بیخوێنێتەوە. تاکە جیاوازی ئەوەیە کە لایەنێک خۆی گفتوگۆکە وەک بەڵگە لە ناکۆکییەکدا پێشکەش بکات.

### 5.6 فرۆشتنی داتا نییە
فرۆشگا داتای کڕیاران نافرۆشێت و بە کرێی نادات. تاکە هاوبەشکردنێک کە بۆ مەبەستی ڕیکلامی هەیە ئەوەیە کە پیکسڵی Meta لە پەڕە گشتییەکانی ماڵپەڕی سەرەکییەوە دەینێرێت، لە سنووری بڕگەکانی 7.5 تا 7.7دا.

## 6. داتای ناسنامە بۆ ئەندامێتی PRO

### 6.1 هەڵبژاردەیی
ئەم داتایە تەنها لەوانە داوا دەکرێت کە داوای ئەندامێتی PRO دەکەن، یان لەوانەی بۆ مەبەستێکی دیاریکراو بەڵگەی ناسنامەیان پێویستە.

### 6.2 شێوەکردن
ناو، بەرواری لەدایکبوون و ژمارەی بەڵگەنامە بە شێوەکراوی لە بنکەدراوەدا هەڵدەگیرێن بە کلیلێک کە فرۆشگا بەڕێوەی دەبات. ئەمە شێوەکردنی لای ڕاژەیە بە کلیلی بەڕێوەبراو، و **شێوەکردنی سەرتاسەری نییە**: فرۆشگا لە ڕووی تەکنیکییەوە دەتوانێت بۆ پێویستییەکی یاسایی بیکاتەوە، و بە جۆرێکی تر وەسف ناکرێت.

### 6.3 وێنەکانی بەڵگە
لە کۆگایەکی تایبەتی نا-گشتیدا هەڵدەگیرێن کە تەنها ڕێڕەوێکی کارگێڕی پشکنراو پێی دەگات. هەرگیز لە ڕێگەی بەستەری فایلی گشتییەوە پێشکەش ناکرێن.

### 6.4 چی ڕوونادات
- هیچ ناسینەوەیەکی ڕوخسار ئەنجام نادرێت.
- ناسنامە بۆ کۆمپانیایەکی پشتڕاستکردنەوەی دەرەکی نانێردرێت.
- هیچ بنکەدراوەیەکی حکومی پرسیاری لێ ناکرێت.
- بارکردنی بەڵگەنامە پشتڕاستکردنەوە نییە؛ پشتڕاستکردنەوە بڕیاری کارمەندێکی مۆڵەتپێدراوە کە بە ناو و کاتیەوە تۆمار دەکرێت.

### 6.5 سڕینەوە دوای مەبەست
وێنەکانی بەڵگە {{KYC_EVIDENCE_RETENTION_MONTHS}} دوای بڕیاردان لەسەر داواکارییەکە دەسڕدرێنەوە؛ ئەوەی لە کەیسەکە دەمێنێتەوە بڕیارەکەی و بەرواری و ئەو کەسەیە کە وەریگرتووە، تا بتوانرێت پشتی پێ ببەسترێت.

## 7. پرۆسێسکەرانی لایەنی سێیەم

### 7.1 ژێرخان
ماڵپەڕ و بنکەدراوەکەی و کۆگای فایلەکانی لەسەر ژێرخانی هەوری لای دابینکەری ژێرخان کار دەکەن، و هەڵگرتن و پرۆسێسکردن لەسەر ڕاژەکانی ئەو ڕوودەدات.

### 7.2 ئیمەیڵ
نامەکانی هەژمار و پسوولەکان لە ڕێگەی دابینکەرێکی ئیمەیڵەوە دەنێردرێن، کە ناونیشانی وەرگر و ناوەڕۆکی نامەکە بەو ئەندازەیەی بۆ ناردن پێویستە دەبینێت.

### 7.3 واتساپ
نامەکانی واتساپ لە ڕێگەی دابینکەرێکی نێوەندگیرەوە دەنێردرێن کە **هەژمارێکی واتساپ کە خودی فرۆشگا خاوەنیەتی** بەڕێوە دەبات. بۆیە ئەو ژمارەیەی کڕیار دەیبینێت ژمارەی خودی فرۆشگایە، نەک ڕووکارێکی پڕۆگرامسازیی لایەنی سێیەم.

### 7.4 تێلێگرام و گووگڵ
نامەکانی تێلێگرام تەنها بۆ گفتوگۆی تایبەتی خودی کڕیار دەچن و هەرگیز بۆ گروپێک ئاڕاستە ناکرێن. چوونەژوورەوەی گووگڵ تۆکنێکی ناسنامە لای گووگڵ پشتڕاست دەکاتەوە کاتێک کڕیار هەڵیدەبژێرێت، و گووگڵ لە ڕووداوی چوونەژوورەوەکە ئاگادار دەبێت.

### 7.5 پیکسڵی Meta: لە کوێ کار دەکات
ماڵپەڕی سەرەکی (levonis-iq.com) پیکسڵی Meta بار دەکات، کە کۆدێکە کۆمپانیای Meta Platforms دابینی دەکات. لە ژێردۆمەینەکانی فرۆشگای بازرگانان، وەک ali3d.levonis-iq.com، و لە بەرنامەی Print Cloud بار ناکرێت.
- تەنها بینینی ئەم پەڕە گشتییانەی کڕین و سەیرکردن ڕاپۆرت دەکات: پەڕەی سەرەکی، لیستەکانی بەرهەم و پەڕەکانی بەرهەم، پۆلەکان، بەراوردکردن، پرینتەرە بەکارهاتووەکان، پاکێجەکان، سەبەتە، تەواوکردنی داواکاری، ئەو پەڕانەی کۆمەڵگە کە هەر کەسێک دەتوانێت سەیریان بکات (فرۆشگاکان، دروستکەران، پڕۆژەکان و پرۆفایلە گشتییەکان)، ئامرازەکان، دۆزەرەوەی پرینتەر، و پەڕەکانی سیاسەت.
- بینینی هیچ پەڕەیەکی تر ڕاپۆرت ناکات، لەوانە: هەژمار، ڕێکخستنەکان، جزدان، داواکارییەکان، بەدواداچوونی داواکاری، گفتوگۆکان، چوونەژوورەوە، بەشی بەڕێوەبردن، داشبۆردی بازرگان، پەڕەکانی گەرەنتی و پسوولە، و ئەو پەڕانەی بە بەستەرێکی تایبەت دەکرێنەوە.

### 7.6 پیکسڵی Meta: Meta چی وەردەگرێت
تاکە ڕووداوێک کە دەنێردرێت بینینی پەڕەیە («PageView»). کۆکردنەوەی خۆکاری ڕووداوەکان لای Meta (کرتەکردن لەسەر دوگمەکان و زانیاریی وەسفیی پەڕە) کوژێنراوەتەوە، و هاوتاکردنی پێشکەوتوو بەکار ناهێنرێت: ماڵپەڕەکە هیچ ناو، ئیمەیڵ، ژمارەی مۆبایل یان ناسێنەری هەژمارێک بۆ Meta نانێرێت. لەگەڵ هەر بینینێکی پەڕە، Meta ئەمانە وەردەگرێت:
- ناونیشانی تەواوی پەڕەکە، تەنانەت ئەو بەشەی دوای نیشانەی «?» دێت.
- ئەو پەڕەیەی سەردانکەر لێیەوە هاتووە.
- کاتەکە.
- زانیاریی وێبگەڕ و ئامێر.
- ناونیشانی تۆڕی (IP) سەردانکەر، وەک ڕاژەکانی Meta دەیبینن.
- ناسێنەرە تایبەتەکانی خودی Meta، لەو کوکییانەی لە بڕگەی 12.6دا هاتوون.
ئەگەر سەردانکەر لە هەمان وێبگەڕدا چووبێتە ناو هەژماری فەیسبووک یان ئینستاگرامەکەی، لەوانەیە Meta سەردانەکە بەو هەژمارەوە ببەستێتەوە، بەپێی سیاسەتەکانی خۆی.

### 7.7 پیکسڵی Meta: مەبەست و ڕۆڵی Meta
مەبەستەکە پێوانەکردنی کاریگەریی ڕیکلامەکانی فرۆشگایە لە فەیسبووک و ئینستاگرام، و پیشاندانی ڕیکلامەکانی فرۆشگا لەوێ بۆ ئەو بینەرانەی پەیوەندییان پێیەوە هەیە. هیچ داتایەک نافرۆشرێت، و پلاتفۆرمەکە خۆی هیچ پرۆفایلێکی ڕیکلامی دروست ناکات. Meta پرۆسێسکەرێک نییە کە بۆ فرۆشگا کار بکات: ئەم داتایە وەک بەرپرسێکی سەربەخۆی داتا، بەپێی مەرجەکان و سیاسەتی تایبەتمەندێتیی خۆی، لە دەرەوەی عێراق پرۆسێس دەکات. ماڵپەڕەکە بۆ ئەم پیکسڵە داوای ڕەزامەندی ناکات و هیچ دوگمەیەکی بۆ کوژاندنەوەی نییە؛ ئەوەی بە دەستی سەردانکەرە لە بڕگەی 12.10دا هاتووە.

### 7.8 چی بوونی نییە
جگە لە پیکسڵی Meta کە بڕگەکانی 7.5 تا 7.7 باسی دەکەن، هیچ تۆڕێکی ڕیکلام، هیچ ئامرازێکی شیکاری لایەنی سێیەم لە ناو لاپەڕەکاندا، و هیچ هاوبەشکردنی داتا بۆ بازاڕگەریی دەرەکی بوونی نییە.

### 7.9 گواستنەوەی داتا بۆ دەرەوەی عێراق
لەوانەیە داتا بەهۆی سروشتی ئەم خزمەتگوزارییانەوە لەسەر ڕاژەی دەرەوەی عێراق پرۆسێس بکرێت. بۆ پرۆسێسکەرانی بڕگەکانی 7.1 تا 7.4، فرۆشگا پابەندە بە هەڵبژاردنی دابینکەرانێک کە پاراستنی گونجاوی گرێبەستی پێشکەش دەکەن. ئەوەی پیکسڵی Meta دەینێرێت، Meta لە دەرەوەی عێراق بەپێی مەرجەکان و سیاسەتی تایبەتمەندێتیی خۆی پرۆسێسی دەکات، وەک بڕگەی 7.7 دەڵێت.

## 8. ئاگادارکردنەوە و بازاڕگەری

### 8.1 ئاگادارکردنەوە کارگێڕییەکان
ئاگادارکردنەوەی داواکاری، پارەدان، گەیاندن، گەرەنتی و ئاسایش بەشێکن لە خزمەتگوزارییەکە و ناتوانرێن بکوژێنرێنەوە لەگەڵ بەردەوامبوونی خزمەتگوزارییەکە.

### 8.2 نامەی بازاڕگەری
تەنها بە ڕەزامەندی دەنێردرێن، کڕیار هەر کاتێک بیەوێت لە ڕێکخستنەکانی هەژمارەکەی یان لە ڕێگەی کەناڵی پەسەندکراوەوە دەیانوەستێنێت، و وەستاندنیان کاریگەری لەسەر ئاگادارکردنەوەکانی بڕگەی 8.1 نییە.

### 8.3 یەک کەناڵ بۆ هەر مەبەستێک
کڕیار کەناڵی ئاگادارکردنەوە هەڵدەبژێرێت — ئیمەیڵ یان واتساپ یان تێلێگرام — و لە هەژمارەکەیەوە دەیگۆڕێت.

## 9. مافەکانی کڕیار

### 9.1 دەستڕاگەیشتن
کڕیار دەتوانێت داوای ڕاپۆرتێکی ئەوە بکات کە دەربارەی هەڵگیراوە، و لە ماوەی {{DATA_REQUEST_DAYS}} وەڵام دەدرێتەوە.

### 9.2 ڕاستکردنەوە
دەتوانێت داتاکانی ڕاست بکاتەوە؛ زۆربەی لە هەژمارەکەیەوە ڕاستەوخۆ دەگۆڕدرێن.

### 9.3 کۆپییەک لە داتاکە
دەتوانێت لە ڕێگەی کەناڵی پەسەندکراوەوە داوای کۆپییەک بە فۆرماتێکی خوێندراوە بە ئامێر بکات.

### 9.4 سڕینەوە
هیچ دوگمەیەکی سڕینەوەی خۆکاری هەژمار لە ماڵپەڕەکەدا نییە. داواکارییەکە لە ڕێگەی کەناڵی پەسەندکراوەوە پێشکەش دەکرێت و لە ماوەی {{ACCOUNT_CLOSURE_PROCESSING_DAYS}} جێبەجێ دەکرێت، دوای داخستنی داواکارییە کراوەکان و یەکلاییکردنەوەی باڵانسەکان.

### 9.5 سنووری سڕینەوە
ئەوەی بە یاسا یان بۆ ژمێریاری دەبێت بپارێزرێت ناسڕدرێتەوە: پسوولەکان، تۆمارە داراییەکان، تۆمارەکانی پەسەندکردنی بەڵگەنامە، و تۆمارەکانی پشکنین. دەستڕاگەیشتن پێیان سنووردار دەکرێت و لە داتای سڕینەوەپێکراو جیا دەکرێنەوە.

### 9.6 پاشەکشەکردن لە ڕەزامەندی
پاشەکشە تەنها کاریگەری بۆ داهاتوو هەیە و ئەو پرۆسێسکردنە پووچ ناکاتەوە کە پێشتر لەسەر بنەمایەکی یاسایی ئەنجام دراوە.

### 9.7 سکاڵا
سکاڵا بۆ {{DATA_PROTECTION_CONTACT}} پێشکەش دەکرێت و لە ماوەی {{DISPUTE_RESPONSE_DAYS}} وەڵام دەدرێتەوە، بەبێ زیانگەیاندن بە مافی کڕیار بۆ ڕووکردنە {{COMPETENT_COURT}}.

## 10. ماوەکانی پاراستن

### 10.1 هەژمار
داتای هەژمار تا ئەو کاتەی هەژمارەکە هەیە دەپارێزرێت، و دوای داخستنی بەپێی بڕگەی 9.5 دەسڕدرێتەوە یان بێناو دەکرێت.

### 10.2 داواکارییەکان و پسوولەکان
{{ORDER_RECORD_RETENTION_YEARS}}.

### 10.3 جزدان و خاڵ
{{WALLET_RECORD_RETENTION_YEARS}}.

### 10.4 پەسەندکردنی بەڵگەنامەکان
{{POLICY_ACCEPTANCE_RETENTION_YEARS}} — لەگەڵ وەشانی پەسەندکراوی بەڵگەنامەکە و زمانەکەی هەڵدەگیرێن، تا دوای چەند ساڵێک هێشتا خوێندراوە بن.

### 10.5 گفتوگۆکان و بلیتەکان
{{CHAT_RETENTION_YEARS}}.

### 10.6 تۆمارەکانی پشکنین
{{AUDIT_LOG_RETENTION_YEARS}}.

### 10.7 تۆمارە تەکنیکییەکان
{{TECHNICAL_LOG_RETENTION_DAYS}}.

## 11. ئاسایش

### 11.1 لە کاتی گواستنەوەدا
هەموو پەیوەندییەک لەگەڵ ماڵپەڕەکە لە کاتی گواستنەوەدا شێوەکراوە، و وێبگەڕ پابەندە بە بەکارهێنانی پەیوەندیی پارێزراو.

### 11.2 پاراستن لە ناو لاپەڕە
ماڵپەڕ سیاسەتێکی ناوەڕۆک جێبەجێ دەکات کە بەپێی ئەو تەنها کۆدی خودی فرۆشگا و کۆدی ئەو خزمەتگوزارییە دەرەکییانەی بە ئەنقەست باریان دەکات، وەک چوونەژوورەوەی گووگڵ و پیکسڵی Meta، لە پەڕەدا جێبەجێ دەبن؛ کۆدێک کە بخرێتە ناو پەڕەکەوە جێبەجێ نابێت. مەبەست ئەوەیە ئەو دەقەی بازرگانێک یان کڕیارێک دەینووسێت نەتوانرێت بۆ زیانگەیاندن بە سەردانکەرێک بەکاربهێنرێت.

### 11.3 دانیشتن
دانیشتن لە نێوان دۆمەینی سەرەکی و دۆمەینی بازرگانەکاندا هاوبەشە تا کڕین لەسەریان کار بکات؛ ئەمە هیچ دەستڕاگەیشتنێک بە داتای سەردانکەر بە بازرگان نادات.

### 11.4 وشەی نهێنی
وشەی نهێنی هەرگیز بە دەقی ڕوون هەڵناگیرێت و کارمەند ناتوانێت بیخوێنێتەوە.

### 11.5 سنووری ئەوەی بەڵێنی پێدەدرێت
هیچ سیستەمێک بە تەواوی پارێزراو نییە. ئەگەر پێشێلکارییەک ڕوویدا کە کاریگەری لەسەر داتای کڕیاران هەبێت، فرۆشگا پابەندە بە ئاگادارکردنەوەی کاریگەربووەکان لە ماوەی {{BREACH_NOTIFICATION_HOURS}} کاتژمێر لە ئاگاداربوونیەوە، لەگەڵ ڕوونکردنەوەی ئەوەی ڕوویداوە و ئەوەی ڕاسپاردە دەکرێت.

## 12. کوکی و هەڵگرتنی ناوخۆیی

### 12.1 فرۆشگا چی بەکار دەهێنێت
ماڵپەڕ و بەرنامەکە یەک کوکی دانیشتن و بڕێکی سنووردار لە هەڵگرتنی ناوخۆیی لەناو وێبگەڕی کڕیاردا بەکار دەهێنن. لە ماڵپەڕی سەرەکیدا، کۆدی Meta ئەو کوکییە ڕیکلامییانەش دادەنێت کە لە بڕگەی 12.6دا هاتوون؛ جگە لەوان هیچ کوکییەکی بازاڕگەری لە پلاتفۆرمەکەدا نییە.

### 12.2 کوکی دانیشتن
کوکی دانیشتن ئەوەیە کە کڕیار لە پەڕەیەکەوە بۆ پەڕەیەکی تر لە هەژمارەکەیدا چووەتەژوورەوە دەهێڵێتەوە. بۆ کارپێکردنی خزمەتگوزارییەکە بەتەواوی پێویستە: بەبێ ئەو نە هەژمارەکە دەگەڕدرێت و نە داواکارییەک تەواو دەکرێت، و لەبەر ئەوە ڕەزامەندییەکی جیاوازی بۆ داوا ناکرێت.

### 12.3 تایبەتمەندییەکانی کوکی دانیشتن
کوکی دانیشتن لەلایەن بەرنامەکانی پەڕەکەوە ناخوێندرێتەوە، تەنها لە ڕێگەی پەیوەندییەکی کۆدکراوەوە دەنێردرێت، و لەگەڵ ئەو داواکارییانەدا نانێردرێت کە لە ماڵپەڕی ترەوە دێن. ئەم سنوورانە بۆ ڕێگریکردن لە دزینی دانیشتن دانراون.

### 12.4 کەی کۆتایی دێت
کوکی دانیشتن بە تەواوبوونی ماوەکەی یان بە چوونەدەرەوەی کڕیار یان بە کۆتاییپێهێنانی دانیشتنەکانی لە هەژمارەکەیەوە کۆتایی دێت، و حوکمەکانی ئەوە لە بەڵگەنامەی تۆمارکردن و هەژمارەکاندان.

### 12.5 هەڵگرتنی ناوخۆیی
بڕێکی کەم لە داتای پەسەند لەناو وێبگەڕدا هەڵدەگیرێت، وەک شێوازی پیشاندانی لیستێک و شێوەی ئەو دراوەی کڕیار پێی خۆشە بیبینێت. ئەمە داتای ئاسانکارییە: بۆ فرۆشگا نانێردرێت، بە ناسنامەوە نابەسترێت و لە بەدواداچووندا بەکار ناهێنرێت.

### 12.6 کوکییە ڕیکلامییەکانی Meta
لە ماڵپەڕی سەرەکیدا، کۆدی Meta کوکیی لایەنی یەکەم لەسەر دۆمەینی ماڵپەڕەکە دادەنێت: \u200E_fbp، کە ناسێنەری وێبگەڕە و تا 90 ڕۆژ دەمێنێتەوە و بە سەردانەکانی دواتر نوێ دەبێتەوە؛ و \u200E_fbc، کە ناسێنەری کرتەکردنە لەسەر ڕیکلام و کاتێک دادەنرێت کە سەردانکەر لە ڕێگەی بەستەری ڕیکلامێکی Meta دێت کە fbclid هەڵدەگرێت، و تا 90 ڕۆژ دەمێنێتەوە. جگە لەم دووانە، فرۆشگا هیچ کوکییەکی ڕیکلامی دانانێت، داتای گەڕان نافرۆشێت، پرۆفایلێکی ڕیکلامی بۆ کڕیار دروست ناکات، و ڕەفتاری کڕیار لە پلاتفۆرمەکەدا لەگەڵ هیچ تۆڕێکی ڕیکلامی جگە لە Meta هاوبەش ناکات، ئەویش تەنها بە ئەندازەی بڕگەی 7.6.

### 12.7 سڕینەوەیان
خاوەنی ئامێرەکە دەتوانێت هەر کاتێک کوکی و هەڵگرتنی ناوخۆیی لە ڕێکخستنەکانی وێبگەڕەکەیەوە بسڕێتەوە. کاریگەری سڕینەوەی کوکی دانیشتن چوونەدەرەوەیە لە هەژمارەکە، و هیچی تر. سڕینەوەی \u200E_fbp یان \u200E_fbc هیچ کاریگەرییەکی لەسەر بەکارهێنانی فرۆشگا نییە.

### 12.8 ڕێگریکردن لە کوکی
ئەو کەسەی لە وێبگەڕەکەیدا ڕێگری لە کوکی دەکات ناتوانێت بچێتە ناو هەژمارەکەیەوە، چونکە خودی چوونەژوورەوە لەسەریان دەوەستێت. ئەمە تێکچوونێک لە خزمەتگوزارییەکەدا نییە. بەڵام ڕێگریکردن تەنها لە کۆدی Meta یان لە کوکییەکانی، کاریگەری لەسەر بەکارهێنانی فرۆشگا نییە.

### 12.9 بەستەری لایەنی سێیەم
لەوانەیە پلاتفۆرمەکە بەستەری ئەو ماڵپەڕانەی تێدا بێت کە فرۆشگا بەڕێوەیان نابات. ئەوەی ئەو ماڵپەڕە دوای بەجێهێشتنی پلاتفۆرمەکە لەسەر ئامێرەکەت دایدەنێت بە سیاسەتی خۆی ڕێک دەخرێت نەک بەم بەڵگەنامەیە.

### 12.10 نە پەنجەرەی ڕەزامەندی و نە دوگمەی کوژاندنەوە
ماڵپەڕەکە هیچ پەنجەرەیەک بۆ داوای ڕەزامەندی لەسەر پیکسڵی Meta و کوکییەکانی پیشان نادات، و هیچ دوگمەیەکی خۆی بۆ کوژاندنەوەیان نییە. ئەوەی بە دەستی سەردانکەرە وێبگەڕەکەیەتی — ڕێگریکردن لە کوکی و کۆدی دەرەکی یان سڕینەوەیان، بەپێی بڕگەکانی 12.7 و 12.8 — و ڕێکخستنەکانی ڕیکلام لە هەژمارەکەیدا لای Meta.

## 13. حوکمە کۆتاییەکان

### 13.1 منداڵان
فرۆشگا خزمەتگوزارییەکانی ئاڕاستەی ئەوانە ناکات کە تەمەنیان لە {{MIN_ACCOUNT_AGE_YEARS}} کەمترە، و بە ئەنقەست داتایان کۆناکاتەوە. هەر داتایەکی لەو جۆرە کە بگات، لە کاتی زانینیدا دەسڕدرێتەوە.

### 13.2 گۆڕانکاری
ئەم بەڵگەنامەیە بە وەشانێکی نوێ دەگۆڕدرێت؛ پەسەندکردنی وەشانە نوێیەکە لە داواکاری دواتردا داوا دەکرێت، و وەشانی پێشتر پەسەندکراو هەڵگیراو و خوێندراوە دەمێنێتەوە.

### 13.3 ناکۆکی
لە پرسێکی داتادا، ئەم بەڵگەنامەیە بەسەر بەڵگەنامەکانی تری فرۆشگادا سەرچاوەیە.

### 13.4 یاسا و دەسەڵاتی دادوەری
{{GOVERNING_LAW_JURISDICTION}} جێبەجێ دەبێت و {{COMPETENT_COURT}} دەسەڵاتی هەیە.`,
  },
};
