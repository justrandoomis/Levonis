import type { PolicyDocument } from './types';

/**
 * شروط استخدام الموقع — THE RULES OF THE SURFACE, NOT OF THE SALE.
 *
 * WHY THIS IS NOT `terms`. The umbrella document next door governs the
 * CONTRACT: who the parties are, how a sale forms, liability, forum. This one
 * governs the SOFTWARE — the site, the subdomains, the accounts, the uploads,
 * the assistant, the automated access — and it binds a visitor who has never
 * bought anything. Merging them would mean a browser who placed no order is
 * asked to accept a sales contract, and a buyer arguing about a delivery is
 * shown a clause about scraping. Article 1.2 states the division out loud so
 * neither document is read for the other's subject.
 *
 * IT IS NOT A CHECKOUT DOCUMENT. `policyOps.ts CHECKOUT_POLICY_KEYS` is
 * ['terms', 'privacy'], and this key is deliberately not in it: consent to
 * site rules is by use, stated in article 1.5, not by a checkbox at the till.
 *
 * WHAT THE CODE PUT IN THE TEXT, and what a reader must not soften:
 *   hosts.ts + securityPolicy.ts   the same bundle is served on the apex AND
 *                                  on every merchant subdomain, and the
 *                                  session cookie is scoped to the parent
 *                                  domain. So chapter 4 says plainly that a
 *                                  merchant subdomain is Levonis software
 *                                  showing a merchant's TEXT, and that a
 *                                  merchant cannot run code there — which is
 *                                  the honest description AND the reason the
 *                                  platform can be responsible for the rails
 *                                  without being responsible for the words.
 *   usernames.ts / nameGuard.ts /  two separate lists protecting two separate
 *   decency.ts                     things — impersonation and decency — so
 *                                  article 5.3 refuses a name for the RIGHT
 *                                  reason, and 5.4 gives an appeal, because a
 *                                  false positive here is a real customer
 *                                  turned away under their own name.
 *   attachments.ts                 a declared MIME type is a claim, not a
 *                                  fact; every accepted format is recognised
 *                                  from its bytes or fails a structural test.
 *                                  Article 6.4 states the 8 MB / 40 MB limits
 *                                  because they ARE constants, and 6.6 states
 *                                  that only images are ever served inline.
 *   routes/support.ts              the assistant is DETERMINISTIC — an intent
 *                                  allowlist and keyword dictionaries, no
 *                                  model, no inference, reading only the
 *                                  signed-in user's own rows. Chapter 8 says
 *                                  exactly that, because "our AI assistant"
 *                                  would be a false statement about this
 *                                  codebase, and because a customer is
 *                                  entitled to know a machine cannot commit
 *                                  the shop to a date.
 *   ratelimit.ts                   the limiter is real and per-account as well
 *                                  as per-IP, so chapter 7 can state
 *                                  automated-access rules as enforcement
 *                                  rather than as a request.
 *
 * NO UPTIME NUMBER APPEARS HERE. There is no SLA in this codebase and no
 * status page to measure one against; article 9.2 promises effort and names
 * maintenance instead of inventing a percentage the owner cannot defend.
 */
export const site_terms: PolicyDocument = {
  key: 'site_terms',
  version: 1,
  effective_at: '2026-01-01',
  title: {
    ar: 'شروط استخدام الموقع',
    en: 'Website Terms of Use',
    ckb: 'مەرجەکانی بەکارهێنانی ماڵپەڕ',
  },
  body: {
    ar: `## 1. التمهيد

### 1.1 الغرض من هذه الوثيقة
تحكم هذه الوثيقة استخدام موقع ليفونيس وتطبيقاته ونطاقاته الفرعية: ما يجوز للزائر فعله، وما لا يجوز، وما يملكه المتجر من محتوى، وما يرفعه الزبون، وكيف يعمل المساعد داخل الموقع، وما مسؤولية المتجر عن استمرار الخدمة.

### 1.2 علاقتها بالشروط والأحكام العامة
الشروط والأحكام العامة تحكم **العقد**: من الطرفان، وكيف ينعقد البيع، وحدود المسؤولية، والاختصاص. وهذه الوثيقة تحكم **البرمجية**: الموقع والحساب والرفع والوصول الآلي. من يتصفح دون شراء تلزمه هذه الوثيقة وحدها. وعند التعارض في مسألة تعاقدية، تسري الشروط والأحكام العامة.

### 1.3 الأطراف
«المتجر» هو {{LEVONIS_LEGAL_NAME}}، و«المستخدم» هو كل من يفتح الموقع، سواء أنشأ حساباً أم لا.

### 1.4 النص المعتمد
النص العربي هو النص المعتمد، وعند اختلاف الترجمة يُعمل به.

### 1.5 القبول بالاستعمال
استعمال الموقع قبول بهذه الوثيقة. ولا تُطلب الموافقة عليها عند الدفع، لأن الدفع يخضع للشروط والأحكام العامة ولسياسة الخصوصية.

### 1.6 النطاقات المشمولة
تسري هذه الوثيقة على النطاق الرئيسي، وعلى كل نطاق فرعي للتجار داخل مجتمع ليفو، وعلى أي واجهة رسمية أخرى يعلنها المتجر.

## 2. الأهلية والحساب

### 2.1 من يجوز له الاستعمال
التصفح متاح للجميع. وإنشاء حساب والشراء يخضعان لشروط الأهلية في وثيقة التسجيل والحسابات.

### 2.2 الحساب شخصي
بيانات الدخول شخصية ولا تُشارَك. وما يقع من فعل عبر حساب يُنسب إلى صاحبه ما لم يُثبت خلاف ذلك.

### 2.3 لا التفاف على التسجيل
لا يجوز إنشاء حسابات آلية، ولا حسابات بأسماء وهمية بقصد التحايل على حد أو قيد أو مكافأة.

## 3. ملكية المحتوى

### 3.1 محتوى المتجر
التصميم والشيفرة والنصوص والصور والشعارات والترتيب والاسم التجاري ملك للمتجر أو مرخَّص له، ومحمي بموجب {{GOVERNING_LAW_JURISDICTION}}.

### 3.2 ما يجوز للمستخدم
يجوز التصفح والقراءة والطباعة الشخصية ومشاركة روابط الصفحات العامة.

### 3.3 ما لا يجوز
لا يجوز نسخ المحتوى أو إعادة نشره تجارياً، ولا استعماله لتدريب نماذج آلية، ولا استخراج قاعدة بيانات المنتجات أو الأسعار، ولا إزالة إشارات الملكية.

### 3.4 المواصفات الفنية للمنتجات
جداول المواصفات وصفحات المقارنة ونتائجها جزء من محتوى المتجر. ويجوز الاستشهاد بها مع ذكر المصدر، ولا يجوز استخراجها آلياً بالجملة.

## 4. نطاقات التجار

### 4.1 ما هو النطاق الفرعي للتاجر
هو الموقع نفسه، برمجية المتجر ذاتها، وهو يعرض **نصوص التاجر**: اسم متجره، ونبذته، ووصف منتجاته، وروابطه.

### 4.2 التاجر لا يشغّل شيفرة
لا يستطيع التاجر رفع شيفرة ولا تشغيلها على نطاقه الفرعي. ما يتحكم فيه نص يعرضه الموقع، لا برنامج.

### 4.3 المسؤولية عن النص
التاجر مسؤول عما يكتبه. والمتجر مسؤول عن البنية التي تعرضه وعن إزالة ما يخالف هذه الوثيقة عند العلم به.

### 4.4 الجلسة مشتركة
جلسة الزائر واحدة على النطاق الرئيسي والنطاقات الفرعية، وهذا مقصود حتى يعمل السلة والدفع والطلبات على نطاق التاجر. ولا يمنح ذلك التاجر أي وصول إلى بيانات الزائر.

## 5. الأسماء والهوية داخل الموقع

### 5.1 اسم المستخدم والاسم المعروض
يُختار اسم المستخدم والاسم المعروض وفق قائمتين مستقلتين: قائمة تمنع انتحال صفة المنصة، وقائمة تمنع الألفاظ غير اللائقة.

### 5.2 منع الانتحال
لا يجوز حجز اسم يوحي بأن صاحبه المتجر أو موظفوه أو الدعم الرسمي.

### 5.3 اللياقة
تُرفض الأسماء التي تحمل ألفاظاً نابية، وتُقاس المطابقة على نحو يتجنب رفض كلمة سليمة تحتوي حروفاً مشابهة صدفة.

### 5.4 حق الاعتراض
من رُفض اسمه وله فيه وجه، يعترض عبر القناة المعتمدة خلال {{ACCOUNT_APPEAL_DAYS}}، ويُبتّ خلال {{DISPUTE_RESPONSE_DAYS}}. الرفض بالخطأ يُصحَّح دون رسوم.

### 5.5 الاسم ليس نطاقاً
اسم المستخدم داخل المنصة شيء، ورابط متجر التاجر شيء آخر، ولا يمنح أحدهما الآخر.

## 6. ما يرفعه المستخدم

### 6.1 ما يجوز رفعه
تُقبل الصور، وملفات النماذج ثلاثية الأبعاد المعتمدة، والمستندات المسموح بها، ضمن الطلبات والتقييمات وطلبات الطباعة والدعم.

### 6.2 إقرار المستخدم
بالرفع يقرّ المستخدم أن له حقاً في الملف، وأنه لا ينتهك حق غيره، وأنه لا يحتوي محتوى محظوراً قانوناً.

### 6.3 الترخيص الممنوح للمتجر
يمنح المستخدم المتجر ترخيصاً محدوداً باستعمال الملف لغرض تنفيذ الخدمة المطلوبة فقط: التسعير، والتصنيع، والدعم، وحفظ السجل. ولا يُستعمل في دعاية ولا يُنشر دون إذن منفصل.

### 6.4 الحدود
الحد الأقصى للصورة 8 ميغابايت، ولملف النموذج 40 ميغابايت، وعدد المرفقات محدود حسب الصفحة.

### 6.5 فحص الملفات
نوع الملف المعلن من المتصفح ادعاء لا حقيقة. يتحقق المتجر من الملف من بنيته نفسها، ويرفض ما لا يطابق الصيغة التي ادّعاها.

### 6.6 طريقة العرض
لا يُعرض داخل الصفحة إلا الصور. وملفات النماذج والمستندات تُسلَّم كمرفق يُنزَّل، ولا تُفسَّر داخل المتصفح.

### 6.7 ما لا يُقبل
لا تُقبل الملفات التنفيذية ولا النصوص البرمجية ولا الأرشيفات، ولا ملف يُقصد به اختبار أمان الموقع.

## 7. الاستعمال المحظور والوصول الآلي

### 7.1 الاستعمال المحظور
- محاولة الوصول إلى حساب أو بيانات لا تخص المستخدم.
- اختبار ثغرات أو اختراق أو تجاوز ضوابط الأمان.
- إرسال محتوى ضار أو برمجيات خبيثة.
- التحايل على حدود المعدل أو حدود المكافآت.
- إساءة استعمال قنوات الدعم بالإغراق المتعمد.

### 7.2 الوصول الآلي
لا يُسمح بالجمع الآلي للبيانات ولا بالزحف ولا بالاستخراج، إلا لمحركات البحث العامة بما يسمح به ملف الاستبعاد المنشور.

### 7.3 حدود المعدل
للموقع حدود معدل تُطبَّق على عنوان الشبكة وعلى الحساب معاً. تجاوزها يعطي رفضاً مؤقتاً، وتكراره المتعمد يُعامل معاملة الاستعمال المحظور.

### 7.4 الإبلاغ عن ثغرة
من وجد ثغرة أمنية فليبلّغ عبر {{SECURITY_CONTACT}} ولا ينشرها ولا يستغلها. المتجر يقرّ بالإبلاغ ولا يلاحق من أبلغ بحسن نية ولم يمس بيانات غيره.

## 8. المساعد داخل الموقع

### 8.1 ما هو
المساعد داخل الموقع أداة حتمية تعمل بقواعد مكتوبة وقائمة نوايا محددة وقواميس كلمات لكل لغة. ليس نموذج ذكاء اصطناعي، ولا يستنتج، ولا يتصل بخدمة خارجية للإجابة.

### 8.2 مما يجيب
يجيب من بيانات الحساب نفسه — طلبات المستخدم، وضمانه، ونقاطه، ومحفظته — ومن الكتالوج العام والوثائق المنشورة. ولا يقرأ بيانات مستخدم آخر.

### 8.3 ما لا يفعله
- لا يعد بموعد تسليم لا يراه في سجل الطلب.
- لا يعطي قراراً في مطالبة ضمان ولا في استرداد.
- لا يخمّن عند الالتباس، بل يعرض خيارات توضيح أو يحيل إلى موظف.

### 8.4 قيمة جوابه
جواب المساعد بيان بما هو مسجَّل، لا التزام جديد على المتجر. وما يلزم المتجر هو المسجَّل في الطلب وفي الوثائق المنشورة.

### 8.5 معرّف غير مملوك
إذا سأل المستخدم عن رقم طلب ليس في حسابه، كان الجواب واحداً في كل الأحوال، ولا يكشف وجود ذلك الطلب من عدمه.

## 9. توفر الخدمة

### 9.1 الخدمة كما هي متاحة
يُقدَّم الموقع بحالته المتاحة. ولا يضمن المتجر خلوّه من كل خلل ولا استمراره دون انقطاع.

### 9.2 الصيانة والانقطاع
قد تتوقف الخدمة كلياً أو جزئياً للصيانة أو لسبب خارج عن إرادة المتجر. ويسعى المتجر إلى الإعلان المسبق عن الصيانة المخطَّطة. ولا تتضمن هذه الوثيقة نسبة توفر متعاقداً عليها.

### 9.3 أثر الانقطاع على الطلبات
الانقطاع لا يلغي طلباً مؤكداً ولا يسقط حقاً ناشئاً عنه. والمدد المنصوص عليها في وثائق المتجر تُحسب من التسجيل الفعلي على الخادم.

### 9.4 روابط خارجية
قد يحيل الموقع إلى مواقع أخرى. والمتجر لا يسيطر عليها ولا يسأل عن محتواها.

## 10. الإيقاف والإنهاء

### 10.1 إيقاف الوصول
للمتجر تقييد الوصول أو إيقاف حساب عند مخالفة هذه الوثيقة، مع بيان السبب.

### 10.2 ما لا يمسه الإيقاف
إيقاف الوصول لا يسقط حق الزبون في طلب قائم، ولا في ضمان جهازه، ولا في رصيد محفظته، ولا في الحصول على بياناته.

### 10.3 الاعتراض
يُقدَّم الاعتراض خلال {{ACCOUNT_APPEAL_DAYS}} عبر القناة المعتمدة ويُبتّ خلال {{DISPUTE_RESPONSE_DAYS}}.

## 11. أحكام ختامية

### 11.1 التعديل
تُعدَّل هذه الوثيقة بنسخة جديدة منشورة، وتسري على الاستعمال بعد تاريخ نفاذها.

### 11.2 استقلال البنود
بطلان بند لا يبطل سواه.

### 11.3 القانون والاختصاص
يسري {{GOVERNING_LAW_JURISDICTION}}، وتختص {{COMPETENT_COURT}}.

### 11.4 القناة المعتمدة
{{LEVONIS_SUPPORT_CONTACT}} — أوقات العمل {{LEVONIS_SUPPORT_HOURS}}. العنوان: {{LEVONIS_ADDRESS}}.`,
    en: `## 1. Preliminary

### 1.1 Purpose
This document governs use of the Levonis website, its applications and its subdomains: what a visitor may do, what they may not, what content the Store owns, what a customer uploads, how the in-site assistant works, and the Store's responsibility for continuity of service.

### 1.2 Relationship to the General Terms and Conditions
The General Terms govern the **contract**: who the parties are, how a sale forms, limits of liability, and forum. This document governs the **software**: the site, the account, uploads and automated access. Someone who browses without buying is bound by this document alone. On a contractual question, the General Terms prevail.

### 1.3 Parties
"the Store" is {{LEVONIS_LEGAL_NAME}}; "the User" is anyone who opens the site, whether or not they have created an account.

### 1.4 Authoritative text
The Arabic text is authoritative and prevails where a translation differs.

### 1.5 Acceptance by use
Using the site is acceptance of this document. Acceptance is not requested at checkout, because payment is governed by the General Terms and by the Privacy Policy.

### 1.6 Covered domains
This document applies to the main domain, to every merchant subdomain inside Levo community, and to any other official interface the Store announces.

## 2. Eligibility and account

### 2.1 Who may use the site
Browsing is open to everyone. Creating an account and purchasing are subject to the eligibility conditions in the Registration and Accounts policy.

### 2.2 The account is personal
Sign-in credentials are personal and are not shared. Acts performed through an account are attributed to its holder unless the contrary is shown.

### 2.3 No circumvention of registration
Automated accounts, and accounts under fictitious names created to evade a limit, a restriction or a reward rule, are not permitted.

## 3. Ownership of content

### 3.1 Store content
The design, code, texts, images, logos, arrangement and trade name belong to the Store or are licensed to it, and are protected under {{GOVERNING_LAW_JURISDICTION}}.

### 3.2 What the User may do
Browse, read, print for personal use, and share links to public pages.

### 3.3 What the User may not do
Copy or republish content commercially, use it to train automated models, extract the product or price database, or remove ownership notices.

### 3.4 Product specifications
Specification tables, comparison pages and their results are part of the Store's content. They may be cited with attribution; they may not be extracted automatically in bulk.

## 4. Merchant subdomains

### 4.1 What a merchant subdomain is
It is the same site — the same Store software — displaying **the merchant's text**: their store name, their bio, their product descriptions and their links.

### 4.2 A merchant runs no code
A merchant cannot upload or execute code on their subdomain. What they control is text that the site renders, not a program.

### 4.3 Responsibility for the text
The merchant is responsible for what they write. The Store is responsible for the infrastructure that displays it and for removing what breaches this document once it is aware.

### 4.4 The session is shared
A visitor's session is one session across the main domain and the subdomains. This is deliberate, so that cart, checkout and orders work on a merchant's domain. It grants the merchant no access whatsoever to the visitor's data.

## 5. Names and identity on the site

### 5.1 Username and display name
A username and a display name are checked against two independent lists: one preventing impersonation of the platform, and one preventing indecent words.

### 5.2 No impersonation
No name may be reserved that suggests its holder is the Store, its staff, or official support.

### 5.3 Decency
Names carrying obscene words are refused, and matching is performed so as to avoid refusing an innocent word that happens to contain similar letters.

### 5.4 Right of appeal
Anyone whose name is refused and who has grounds may appeal through the approved channel within {{ACCOUNT_APPEAL_DAYS}}, decided within {{DISPUTE_RESPONSE_DAYS}}. A refusal made in error is corrected without charge.

### 5.5 A name is not a domain
A platform username and a merchant store address are different identifiers; neither grants the other.

## 6. User uploads

### 6.1 What may be uploaded
Images, approved 3D model files and permitted documents, within orders, reviews, print requests and support.

### 6.2 The User's undertaking
By uploading, the User confirms they hold rights in the file, that it infringes no third-party right, and that it contains no content prohibited by law.

### 6.3 Licence granted to the Store
The User grants the Store a limited licence to use the file solely to perform the requested service: pricing, manufacture, support and record keeping. It is not used in advertising and is not published without separate permission.

### 6.4 Limits
The maximum is 8 MB for an image and 40 MB for a model file; the number of attachments is limited per page.

### 6.5 File inspection
A file type declared by the browser is a claim, not a fact. The Store verifies a file from its own structure and refuses anything that does not match the format it claimed.

### 6.6 How files are served
Only images are ever displayed inside a page. Model files and documents are delivered as downloadable attachments and are never interpreted inside the browser.

### 6.7 What is not accepted
Executables, scripts and archives are not accepted, nor is any file intended to test the site's security.

## 7. Prohibited use and automated access

### 7.1 Prohibited use
- Attempting to reach an account or data that is not the User's.
- Probing for vulnerabilities, intrusion, or circumventing security controls.
- Sending harmful content or malicious software.
- Circumventing rate limits or reward limits.
- Abusing support channels by deliberate flooding.

### 7.2 Automated access
Automated collection, crawling and extraction are not permitted, except by general search engines to the extent allowed by the published exclusion file.

### 7.3 Rate limits
The site applies rate limits to the network address and to the account alike. Exceeding them produces a temporary refusal; deliberate repetition is treated as prohibited use.

### 7.4 Reporting a vulnerability
Anyone who finds a security vulnerability should report it to {{SECURITY_CONTACT}} and neither publish nor exploit it. The Store acknowledges reports and does not pursue anyone who reported in good faith without touching another person's data.

## 8. The in-site assistant

### 8.1 What it is
The in-site assistant is a deterministic tool driven by written rules, a fixed list of intents and per-language keyword dictionaries. It is not an AI model, it does not infer, and it does not call an external service to answer.

### 8.2 What it answers from
It answers from the account's own data — the User's orders, warranty, points and wallet — and from the public catalogue and published documents. It never reads another user's data.

### 8.3 What it does not do
- It does not promise a delivery date it cannot see in the order record.
- It does not decide a warranty claim or a refund.
- It does not guess when input is ambiguous; it offers clarifying choices or refers the matter to a member of staff.

### 8.4 The status of its answers
An assistant answer is a statement of what is recorded, not a new obligation on the Store. What binds the Store is what is recorded on the order and in the published documents.

### 8.5 An identifier that is not yours
If the User asks about an order number that is not in their account, the answer is the same in every case and never reveals whether that order exists.

## 9. Availability

### 9.1 Provided as available
The site is provided as it stands. The Store does not warrant that it is free of every defect or that it will run without interruption.

### 9.2 Maintenance and outages
Service may stop in whole or in part for maintenance or for reasons outside the Store's control. The Store endeavours to announce planned maintenance in advance. This document contains no contracted availability percentage.

### 9.3 Effect of an outage on orders
An outage does not cancel a confirmed order or extinguish a right arising from it. Periods stated in the Store's documents run from what is actually recorded on the server.

### 9.4 External links
The site may link to other sites. The Store neither controls them nor answers for their content.

## 10. Suspension and termination

### 10.1 Suspending access
The Store may restrict access or suspend an account on breach of this document, stating the reason.

### 10.2 What suspension does not touch
Suspending access does not extinguish the Customer's rights in an existing order, in the warranty on their device, in their wallet balance, or in obtaining their own data.

### 10.3 Appeal
An appeal is made within {{ACCOUNT_APPEAL_DAYS}} through the approved channel and decided within {{DISPUTE_RESPONSE_DAYS}}.

## 11. Final provisions

### 11.1 Amendment
This document is amended by publishing a new version, which applies to use after its effective date.

### 11.2 Severability
The invalidity of one provision does not invalidate the others.

### 11.3 Governing law and forum
{{GOVERNING_LAW_JURISDICTION}} applies and {{COMPETENT_COURT}} has jurisdiction.

### 11.4 Approved channel
{{LEVONIS_SUPPORT_CONTACT}} — working hours {{LEVONIS_SUPPORT_HOURS}}. Address: {{LEVONIS_ADDRESS}}.`,
    ckb: `## 1. پێشەکی

### 1.1 مەبەستی ئەم بەڵگەنامەیە
ئەم بەڵگەنامەیە بەکارهێنانی ماڵپەڕی لێڤۆنیس و ئەپەکانی و ژێردۆمەینەکانی ڕێک دەخات: سەردانکەر چی دەتوانێت بیکات، چی ناتوانێت، فرۆشگا خاوەنی چ ناوەڕۆکێکە، کڕیار چی بار دەکات، یاریدەدەری ناو ماڵپەڕ چۆن کار دەکات، و بەرپرسیارێتی فرۆشگا لە بەردەوامی خزمەتگوزاری چییە.

### 1.2 پەیوەندی بە مەرج و ڕێسا گشتییەکانەوە
مەرجە گشتییەکان **گرێبەست** ڕێک دەخەن: لایەنەکان کێن، فرۆشتن چۆن دروست دەبێت، سنووری بەرپرسیارێتی، و دەسەڵاتی دادوەری. ئەم بەڵگەنامەیە **نەرمەکاڵا** ڕێک دەخات: ماڵپەڕ، هەژمار، بارکردن و دەستڕاگەیشتنی خۆکار. ئەوەی بەبێ کڕین دەگەڕێت تەنها بە ئەم بەڵگەنامەیە پابەندە. لە پرسێکی گرێبەستیدا، مەرجە گشتییەکان سەرچاوەن.

### 1.3 لایەنەکان
«فرۆشگا» {{LEVONIS_LEGAL_NAME}}ـە، و «بەکارهێنەر» هەر کەسێکە کە ماڵپەڕەکە دەکاتەوە، جا هەژماری دروست کردبێت یان نا.

### 1.4 دەقی بنەڕەت
دەقی عەرەبی بنەڕەتە و لە کاتی جیاوازی وەرگێڕاندا کاری پێدەکرێت.

### 1.5 پەسەندکردن بە بەکارهێنان
بەکارهێنانی ماڵپەڕ پەسەندکردنی ئەم بەڵگەنامەیەیە. لە کاتی پارەداندا داوای پەسەندکردنی ناکرێت، چونکە پارەدان بە مەرجە گشتییەکان و سیاسەتی تایبەتمەندێتی ڕێک دەخرێت.

### 1.6 دۆمەینە داپۆشراوەکان
ئەم بەڵگەنامەیە لەسەر دۆمەینی سەرەکی، لەسەر هەموو ژێردۆمەینێکی بازرگان لە ناو کۆمەڵگەی لێڤۆ، و لەسەر هەر ڕووکارێکی فەرمیی تری کە فرۆشگا ڕایدەگەیەنێت جێبەجێ دەبێت.

## 2. شایستەیی و هەژمار

### 2.1 کێ دەتوانێت بەکاری بهێنێت
گەڕان بۆ هەمووان کراوەیە. دروستکردنی هەژمار و کڕین بە مەرجەکانی شایستەیی لە بەڵگەنامەی تۆمارکردن و هەژمارەکان ڕێک دەخرێن.

### 2.2 هەژمار کەسییە
زانیاری چوونەژوورەوە کەسییە و هاوبەش ناکرێت. ئەو کردارانەی لە ڕێگەی هەژمارێکەوە دەکرێن بۆ خاوەنەکەی دەگەڕێنەوە مەگەر پێچەوانەکەی بسەلمێنرێت.

### 2.3 بەدەوری تۆمارکردندا نەڕۆیشتن
هەژماری خۆکار، و هەژمار بە ناوی خەیاڵی بۆ بەدەوری سنوور یان سنووردارکردن یان ڕێسای خەڵاتدا ڕۆیشتن، ڕێپێدراو نین.

## 3. خاوەندارێتی ناوەڕۆک

### 3.1 ناوەڕۆکی فرۆشگا
دیزاین، کۆد، دەقەکان، وێنەکان، لۆگۆکان، ڕێکخستن و ناوی بازرگانی موڵکی فرۆشگان یان مۆڵەتی پێدراون، و بەپێی {{GOVERNING_LAW_JURISDICTION}} پارێزراون.

### 3.2 بەکارهێنەر چی دەتوانێت
گەڕان، خوێندنەوە، چاپی کەسی، و هاوبەشکردنی بەستەری لاپەڕە گشتییەکان.

### 3.3 بەکارهێنەر چی ناتوانێت
لەبەرگرتنەوە یان دووبارە بڵاوکردنەوەی ناوەڕۆک بە شێوەی بازرگانی، بەکارهێنانی بۆ ڕاهێنانی مۆدێلی خۆکار، دەرهێنانی بنکەدراوەی بەرهەم یان نرخ، یان لابردنی ئاماژەکانی خاوەندارێتی.

### 3.4 تایبەتمەندییە تەکنیکییەکانی بەرهەمەکان
خشتەی تایبەتمەندییەکان، لاپەڕەکانی بەراورد و ئەنجامەکانیان بەشێکن لە ناوەڕۆکی فرۆشگا. دەکرێت بە ئاماژەدان بە سەرچاوە باسیان لێ بکرێت؛ ناکرێت بە کۆمەڵ و بە خۆکاری دەربهێنرێن.

## 4. ژێردۆمەینی بازرگانەکان

### 4.1 ژێردۆمەینی بازرگان چییە
هەمان ماڵپەڕە — هەمان نەرمەکاڵای فرۆشگا — کە **دەقی بازرگانەکە** پیشان دەدات: ناوی فرۆشگاکەی، کورتەی، وەسفی بەرهەمەکانی، و بەستەرەکانی.

### 4.2 بازرگان هیچ کۆدێک ناخات بەکار
بازرگان ناتوانێت کۆد بار بکات یان لەسەر ژێردۆمەینەکەی جێبەجێی بکات. ئەوەی کۆنترۆڵی دەکات دەقە کە ماڵپەڕ پیشانی دەدات، نەک پڕۆگرام.

### 4.3 بەرپرسیارێتی لەسەر دەق
بازرگان بەرپرسە لەوەی دەینووسێت. فرۆشگا بەرپرسە لەو ژێرخانەی پیشانی دەدات و لە لابردنی ئەوەی ئەم بەڵگەنامەیە پێشێل دەکات کاتێک ئاگادار دەبێت.

### 4.4 دانیشتن هاوبەشە
دانیشتنی سەردانکەر یەک دانیشتنە بەسەر دۆمەینی سەرەکی و ژێردۆمەینەکاندا. ئەمە بە مەبەستە، تا سەبەتە و پارەدان و داواکارییەکان لەسەر دۆمەینی بازرگان کار بکەن. هیچ دەستڕاگەیشتنێک بە داتای سەردانکەر بە بازرگان نادات.

## 5. ناو و ناسنامە لە ناو ماڵپەڕ

### 5.1 ناوی بەکارهێنەر و ناوی پیشاندراو
ناوی بەکارهێنەر و ناوی پیشاندراو بەرامبەر دوو لیستی سەربەخۆ دەپشکنرێن: یەکێکیان ڕێگری لە خۆدەرخستن وەک پلاتفۆرم دەکات، و ئەویتریان ڕێگری لە وشەی ناشیاو دەکات.

### 5.2 قەدەغەکردنی خۆدەرخستن
هیچ ناوێک نابێت حیجز بکرێت کە ئاماژە بدات خاوەنەکەی فرۆشگا یان کارمەندەکانی یان پشتگیری فەرمییە.

### 5.3 شیاوی
ئەو ناوانەی وشەی ناشیاو هەڵدەگرن ڕەت دەکرێنەوە، و پێکهاتن بەو شێوەیە دەپێورێت کە ڕێگر بێت لە ڕەتکردنەوەی وشەیەکی بێگەرد کە بە ڕێکەوت پیتی هاوشێوەی تێدایە.

### 5.4 مافی ناڕەزایی
هەر کەسێک ناوەکەی ڕەت کرایەوە و بەڵگەی هەبوو، دەتوانێت لە ماوەی {{ACCOUNT_APPEAL_DAYS}} لە ڕێگەی کەناڵی پەسەندکراوەوە ناڕەزایی دەرببڕێت، و لە ماوەی {{DISPUTE_RESPONSE_DAYS}} بڕیاری لەسەر دەدرێت. ڕەتکردنەوەی بە هەڵە بەبێ کرێ ڕاست دەکرێتەوە.

### 5.5 ناو دۆمەین نییە
ناوی بەکارهێنەری پلاتفۆرم و ناونیشانی فرۆشگای بازرگان دوو ناسێنەری جیاوازن؛ هیچیان ئەویتریان نابەخشێت.

## 6. ئەوەی بەکارهێنەر بار دەکات

### 6.1 چی دەکرێت بار بکرێت
وێنە، فایلی مۆدێلی سێ ڕەهەندی پەسەندکراو و بەڵگەنامەی ڕێپێدراو، لە ناو داواکاری و هەڵسەنگاندن و داواکاری چاپ و پشتگیریدا.

### 6.2 بەڵێنی بەکارهێنەر
بە بارکردن، بەکارهێنەر پشتڕاست دەکاتەوە کە مافی لە فایلەکەدا هەیە، کە مافی لایەنی سێیەم پێشێل ناکات، و کە ناوەڕۆکی بە یاسا قەدەغەکراوی تێدا نییە.

### 6.3 ئەو مۆڵەتەی بە فرۆشگا دەدرێت
بەکارهێنەر مۆڵەتێکی سنووردار بە فرۆشگا دەدات بۆ بەکارهێنانی فایلەکە تەنها بۆ ئەنجامدانی ئەو خزمەتگوزارییەی داوا کراوە: نرخاندن، بەرهەمهێنان، پشتگیری و پاراستنی تۆمار. لە ڕیکلامدا بەکارناهێنرێت و بەبێ مۆڵەتێکی جیاواز بڵاو ناکرێتەوە.

### 6.4 سنوورەکان
زۆرترین بڕ بۆ وێنە 8 مێگابایت و بۆ فایلی مۆدێل 40 مێگابایتە؛ ژمارەی هاوپێچەکان بەپێی لاپەڕەکە سنووردارە.

### 6.5 پشکنینی فایل
جۆری فایل کە لەلایەن وێبگەڕەوە ڕاگەیەنراوە بانگەشەیەکە نەک ڕاستییەک. فرۆشگا فایلەکە لە پێکهاتەی خۆیەوە پشتڕاست دەکاتەوە و ئەوەی لەگەڵ ئەو فۆرماتەی بانگەشەی کردووە ناگونجێت ڕەت دەکاتەوە.

### 6.6 شێوازی پیشاندان
تەنها وێنە لە ناو لاپەڕەدا پیشان دەدرێت. فایلی مۆدێل و بەڵگەنامەکان وەک هاوپێچی داگیراو دەگەیەنرێن و هەرگیز لە ناو وێبگەڕدا لێکنادرێنەوە.

### 6.7 چی وەرناگیرێت
فایلی جێبەجێکار، سکریپت و ئەرشیف وەرناگیرێن، هەروەها هیچ فایلێک کە مەبەستی تاقیکردنەوەی ئاسایشی ماڵپەڕەکە بێت.

## 7. بەکارهێنانی قەدەغەکراو و دەستڕاگەیشتنی خۆکار

### 7.1 بەکارهێنانی قەدەغەکراو
- هەوڵدان بۆ گەیشتن بە هەژمار یان داتایەک کە هی بەکارهێنەر نییە.
- گەڕان بەدوای کەلێندا، دەستدرێژی، یان بەدەوری کۆنترۆڵەکانی ئاسایشدا ڕۆیشتن.
- ناردنی ناوەڕۆکی زیانبەخش یان نەرمەکاڵای خراپەکار.
- بەدەوری سنووری ڕێژە یان سنووری خەڵاتدا ڕۆیشتن.
- خراپبەکارهێنانی کەناڵەکانی پشتگیری بە لافاوی مەبەستدار.

### 7.2 دەستڕاگەیشتنی خۆکار
کۆکردنەوەی خۆکار، خشۆکان و دەرهێنان ڕێپێدراو نین، جگە لە بزوێنەری گەڕانی گشتی بەو ئەندازەیەی فایلی دوورخستنەوەی بڵاوکراوە ڕێگەی پێدەدات.

### 7.3 سنووری ڕێژە
ماڵپەڕ سنووری ڕێژە لەسەر ناونیشانی تۆڕ و لەسەر هەژمار پێکەوە جێبەجێ دەکات. تێپەڕاندنیان ڕەتکردنەوەیەکی کاتی دروست دەکات؛ دووبارەکردنەوەی بە مەبەست وەک بەکارهێنانی قەدەغەکراو مامەڵەی لەگەڵ دەکرێت.

### 7.4 ڕاپۆرتکردنی کەلێن
هەر کەسێک کەلێنێکی ئاسایشی دۆزییەوە با لە ڕێگەی {{SECURITY_CONTACT}} ڕایبگەیەنێت و نە بڵاوی بکاتەوە و نە کەڵکی لێ وەربگرێت. فرۆشگا دانی بە ڕاپۆرتەکاندا دەنێت و شوێن ئەو کەسە ناکەوێت کە بە نیازی باش ڕایگەیاندووە و دەستی لە داتای کەسی تر نەداوە.

## 8. یاریدەدەری ناو ماڵپەڕ

### 8.1 چییە
یاریدەدەری ناو ماڵپەڕ ئامرازێکی دیاریکراوە کە بە ڕێسای نووسراو، لیستێکی جێگیری مەبەستەکان و فەرهەنگی وشە بۆ هەر زمانێک کار دەکات. مۆدێلی ژیری دەستکرد نییە، لێکدانەوە ناکات، و بۆ وەڵامدانەوە پەیوەندی بە خزمەتگوزارییەکی دەرەکییەوە ناکات.

### 8.2 لە چی وەڵام دەداتەوە
لە داتای خودی هەژمارەکە — داواکاری و گەرەنتی و خاڵ و جزدانی بەکارهێنەر — و لە کەتەلۆگی گشتی و بەڵگەنامە بڵاوکراوەکان. هەرگیز داتای بەکارهێنەرێکی تر ناخوێنێتەوە.

### 8.3 چی ناکات
- بەڵێنی بەرواری گەیاندن نادات کە لە تۆماری داواکارییەکەدا نەیبینێت.
- بڕیار لە داواکاری گەرەنتی یان گەڕاندنەوەی پارە نادات.
- لە کاتی ناڕوونیدا مەزەندە ناکات، بەڵکو هەڵبژاردەی ڕوونکەرەوە پێشکەش دەکات یان بابەتەکە بۆ کارمەندێک دەنێرێت.

### 8.4 بەهای وەڵامەکانی
وەڵامی یاریدەدەر ڕاگەیاندنی ئەوەیە کە تۆمار کراوە، نەک ئەرکێکی نوێ لەسەر فرۆشگا. ئەوەی فرۆشگا پابەند دەکات ئەوەیە کە لەسەر داواکارییەکە و لە بەڵگەنامە بڵاوکراوەکاندا تۆمار کراوە.

### 8.5 ناسێنەرێک کە هی تۆ نییە
ئەگەر بەکارهێنەر پرسیاری ژمارەی داواکارییەک بکات کە لە هەژمارەکەیدا نییە، وەڵامەکە لە هەموو حاڵەتێکدا یەکسانە و هەرگیز ئاشکرا ناکات ئایا ئەو داواکارییە بوونی هەیە یان نا.

## 9. بەردەستبوونی خزمەتگوزاری

### 9.1 وەک خۆی پێشکەش دەکرێت
ماڵپەڕ بەو دۆخەی هەیەتی پێشکەش دەکرێت. فرۆشگا گەرەنتی ناکات کە لە هەموو کەموکوڕییەک بەتاڵە یان بەبێ پچڕان کار دەکات.

### 9.2 چاککردن و پچڕان
لەوانەیە خزمەتگوزاری بە تەواوی یان بەشێکی بۆ چاککردن یان بە هۆکارێکی دەرەوەی دەسەڵاتی فرۆشگا بوەستێت. فرۆشگا هەوڵ دەدات چاککردنی پلاندراو پێشوەخت ڕابگەیەنێت. ئەم بەڵگەنامەیە هیچ ڕێژەیەکی بەردەستبوونی گرێبەستکراوی تێدا نییە.

### 9.3 کاریگەری پچڕان لەسەر داواکارییەکان
پچڕان داواکارییەکی پەسەندکراو هەڵناوەشێنێتەوە و مافێکی لێوەهاتوو لەناو نابات. ئەو ماوانەی لە بەڵگەنامەکانی فرۆشگادا هاتوون لە ئەوەی بەکردەوە لەسەر ڕاژە تۆمار کراوە دەژمێردرێن.

### 9.4 بەستەری دەرەکی
لەوانەیە ماڵپەڕ بەستەر بۆ ماڵپەڕی تر بدات. فرۆشگا نە کۆنترۆڵیان دەکات و نە بەرپرسە لە ناوەڕۆکیان.

## 10. ڕاگرتن و کۆتاییهێنان

### 10.1 ڕاگرتنی دەستڕاگەیشتن
فرۆشگا دەتوانێت لە کاتی پێشێلکردنی ئەم بەڵگەنامەیەدا دەستڕاگەیشتن سنووردار بکات یان هەژمارێک ڕابگرێت، لەگەڵ ڕوونکردنەوەی هۆکارەکە.

### 10.2 ڕاگرتن دەستی بۆ چی نابات
ڕاگرتنی دەستڕاگەیشتن مافەکانی کڕیار لە داواکارییەکی هەبوو، لە گەرەنتی ئامێرەکەی، لە باڵانسی جزدانەکەی، یان لە وەرگرتنی داتای خۆی لەناو نابات.

### 10.3 ناڕەزایی
ناڕەزایی لە ماوەی {{ACCOUNT_APPEAL_DAYS}} لە ڕێگەی کەناڵی پەسەندکراوەوە پێشکەش دەکرێت و لە ماوەی {{DISPUTE_RESPONSE_DAYS}} بڕیاری لەسەر دەدرێت.

## 11. حوکمە کۆتاییەکان

### 11.1 گۆڕانکاری
ئەم بەڵگەنامەیە بە بڵاوکردنەوەی وەشانێکی نوێ دەگۆڕدرێت، کە لەسەر بەکارهێنانی دوای بەرواری کارپێکردنی جێبەجێ دەبێت.

### 11.2 سەربەخۆیی بڕگەکان
پووچبوونەوەی بڕگەیەک بڕگەکانی تر پووچ ناکاتەوە.

### 11.3 یاسا و دەسەڵاتی دادوەری
{{GOVERNING_LAW_JURISDICTION}} جێبەجێ دەبێت و {{COMPETENT_COURT}} دەسەڵاتی هەیە.

### 11.4 کەناڵی پەسەندکراو
{{LEVONIS_SUPPORT_CONTACT}} — کاتەکانی کار {{LEVONIS_SUPPORT_HOURS}}. ناونیشان: {{LEVONIS_ADDRESS}}.`,
  },
};
