/**
 * Every visible string of the farm balancing console, in the three UI
 * languages, plus the curated labels for the configuration keys named in
 * docs/PRINTER_FARM.md §5. One interface, three literal tables: a key missing
 * from any language is a type error, not a blank label on the owner's screen.
 *
 * LABELS is keyed by dotted path with `*` for a catalog entry
 * (`printers.*.price`); `labelCandidates` in schema.ts decides the lookup
 * order and a key nobody curated falls back to a humanised form of its name.
 */
import type { Language } from '../../translations';

export interface FarmAdminStrings {
  // shell
  title: string;
  subtitle: string;
  version: (n: number) => string;
  schema: (n: number) => string;
  refresh: string;
  loading: string;
  loadFailed: string;
  retry: string;
  sectionsCount: (n: number) => string;
  privateChip: string;
  publicChip: string;
  fieldsCount: (n: number) => string;
  entriesCount: (n: number) => string;
  unsavedMark: string;

  // stored-config problems and conflicts
  problemsTitle: string;
  problemsBody: string;
  conflictTitle: string;
  conflictBody: (current: number) => string;
  reload: string;
  reloadNote: string;

  // section bar
  save: string;
  saving: string;
  noChanges: string;
  savedOk: (version: number) => string;
  saveFailed: string;
  invalidTitle: string;
  discard: string;
  resetDefaults: string;
  resetTitle: (section: string) => string;
  resetBody: string;
  typeReset: string;
  confirmReset: string;
  resetDone: (version: number) => string;
  cancel: string;
  working: string;
  close: string;

  // fields
  defaultIs: (v: string) => string;
  starsPreview: (stars: string) => string;
  percentPreview: (pct: number) => string;
  on: string;
  off: string;
  langAr: string;
  langEn: string;
  langCkb: string;
  addChip: string;
  chipPlaceholder: string;
  removeChip: (v: string) => string;
  addNumber: string;
  removeNumber: (i: number) => string;
  emptyList: string;
  shapeUnsupported: string;

  // catalogs
  keysFixed: string;
  addEntry: string;
  removeEntry: string;
  removeTitle: string;
  removeBody: (id: string) => string;
  remove: string;
  keyLabel: string;
  keyPlaceholder: string;
  keyInvalid: string;
  keyTaken: string;
  keyLocked: string;
  expandRow: (id: string) => string;
  collapseRow: (id: string) => string;
  newRow: string;
  rowN: (n: number) => string;

  // public preview
  publicTitle: string;
  publicBody: string;
  publicNone: string;
  publicLegendPublic: string;
  publicLegendPrivate: string;

  // players
  playersTitle: string;
  playersBody: string;
  userIdLabel: string;
  userIdPlaceholder: string;
  lookup: string;
  lookingUp: string;
  lookupFailed: string;
  noFarm: string;
  farmName: string;
  level: (n: number) => string;
  /** Both already formatted by the shared coin/int helpers (Latin digits). */
  xp: (xp: string, next: string) => string;
  reputation: string;
  coins: string;
  state: string;
  location: string;
  stats: string;
  statDelivered: string;
  statLate: string;
  statCancelled: string;
  statPrints: string;
  statFailures: string;
  statStreak: string;
  statLifetime: string;
  printers: string;
  printersNone: string;
  spools: string;
  jobsActive: string;
  jobsOffered: string;
  jobsRecent: string;
  jobsNone: string;
  ledger: string;
  ledgerNone: string;
  colId: string;
  colKind: string;
  colAmount: string;
  colNote: string;
  colDate: string;
  colState: string;
  colModel: string;
  colHealth: string;
  colQty: string;
  colReward: string;
  colTitle: string;
  colProduct: string;
  colMaterial: string;
  colTier: string;
  dash: string;

  // grant
  grantTitle: string;
  grantBody: string;
  amount: string;
  amountHint: string;
  amountInvalid: string;
  reason: string;
  reasonHint: string;
  reasonShort: string;
  idemKey: string;
  idemHint: string;
  regenerateKey: string;
  grantSubmit: string;
  deductSubmit: string;
  confirmGrantTitle: string;
  confirmGrantBody: (amount: string, who: string) => string;
  confirmDeductBody: (amount: string, who: string) => string;
  confirm: string;
  granted: (amount: string, balance: string) => string;
  replayed: (balance: string) => string;
  grantFailed: string;
  insufficient: string;

  // editor chrome
  unitCoins: string;
  showJson: string;
  hideJson: string;
  problemsInSection: (n: number) => string;
  refreshed: (version: number) => string;
  discarded: string;
  addItem: string;
  removeItem: (n: number) => string;
  xpTop: string;
  userLine: (name: string, username: string) => string;
  colColor: string;
  colGrams: string;
  colQuality: string;
  colNickname: string;
  colSlot: string;
  colDeadline: string;
  colCreated: string;
  colRef: string;
}

const ar: FarmAdminStrings = {
  title: 'مزرعة الطابعات — موازنة اللعبة',
  subtitle: 'كل رقم تعمل به اللعبة يُحرَّر هنا ويُطبَّق فورًا بلا نشر. الخادم يطبّع كل قسم قبل حفظه ويرفض ما لا يستطيع المحرّك العمل به.',
  version: (n) => `الإصدار ${n}`,
  schema: (n) => `المخطط ${n}`,
  refresh: 'تحديث من الخادم',
  loading: 'جارٍ تحميل الإعدادات…',
  loadFailed: 'تعذّر تحميل إعدادات المزرعة',
  retry: 'إعادة المحاولة',
  sectionsCount: (n) => `${n} قسمًا`,
  privateChip: 'خاص',
  publicChip: 'عام',
  fieldsCount: (n) => `${n} حقلًا`,
  entriesCount: (n) => `${n} عنصرًا`,
  unsavedMark: 'تغييرات غير محفوظة',

  problemsTitle: 'الإعدادات المخزّنة فيها مشاكل',
  problemsBody: 'يعمل المحرّك على النسخة المطبَّعة، لكن هذه القواعد لا تتحقّق. صحّحها واحفظ القسم المعنيّ.',
  conflictTitle: 'تغيّرت الإعدادات من جهة أخرى',
  conflictBody: (current) => `الإصدار على الخادم الآن ${current}. أعد التحميل قبل الحفظ؛ تعديلاتك غير المحفوظة تبقى في مكانها.`,
  reload: 'إعادة التحميل',
  reloadNote: 'إعادة التحميل تجلب النسخة الحالية وتحتفظ بالأقسام التي عدّلتها ولم تحفظها.',

  save: 'حفظ هذا القسم',
  saving: 'جارٍ الحفظ…',
  noChanges: 'لا تغييرات',
  savedOk: (version) => `تم الحفظ — الإصدار ${version}`,
  saveFailed: 'تعذّر الحفظ',
  invalidTitle: 'رفض الخادم هذا القسم',
  discard: 'تجاهل التعديلات',
  resetDefaults: 'إرجاع الافتراضي',
  resetTitle: (section) => `إرجاع «${section}» إلى الافتراضي؟`,
  resetBody: 'تُستبدل قيم هذا القسم كلها بقيم الشيفرة الافتراضية ويرتفع الإصدار. لا يمكن التراجع إلا بإعادة كتابة القيم يدويًا.',
  typeReset: 'اكتب RESET للتأكيد',
  confirmReset: 'إرجاع الافتراضي',
  resetDone: (version) => `أُعيد القسم إلى الافتراضي — الإصدار ${version}`,
  cancel: 'إلغاء',
  working: 'جارٍ…',
  close: 'إغلاق',

  defaultIs: (v) => `الافتراضي: ${v}`,
  starsPreview: (stars) => `= ${stars} ★`,
  percentPreview: (pct) => `= ${pct}%`,
  on: 'مفعّل',
  off: 'معطّل',
  langAr: 'عربي',
  langEn: 'English',
  langCkb: 'کوردی',
  addChip: 'إضافة',
  chipPlaceholder: 'مفتاح ثم Enter',
  removeChip: (v) => `إزالة ${v}`,
  addNumber: 'إضافة قيمة',
  removeNumber: (i) => `إزالة القيمة ${i}`,
  emptyList: 'القائمة فارغة',
  shapeUnsupported: 'شكل غير مدعوم في المحرّر — يُعرض كما هو',

  keysFixed: 'المفاتيح ثابتة في المحرّك: تُعدَّل القيم ولا تُضاف صفوف.',
  addEntry: 'إضافة صف',
  removeEntry: 'حذف الصف',
  removeTitle: 'حذف هذا الصف؟',
  removeBody: (id) => `سيُحذف «${id}» من القسم عند الحفظ. أي مرجع إليه في قسم آخر سيُرفض من الخادم حتى تصحّحه.`,
  remove: 'حذف',
  keyLabel: 'المفتاح',
  keyPlaceholder: 'مثال: a1_mini',
  keyInvalid: 'أحرف لاتينية وأرقام و _ و - فقط (حتى 40)',
  keyTaken: 'هذا المفتاح موجود',
  keyLocked: 'المفتاح مقفل — صفوف أخرى تشير إليه',
  expandRow: (id) => `فتح ${id}`,
  collapseRow: (id) => `طيّ ${id}`,
  newRow: 'جديد',
  rowN: (n) => `الصف ${n}`,

  publicTitle: 'ما يصل إلى اللاعب',
  publicBody: 'مقتطف للقراءة فقط من الخادم: الأقسام التي يستلمها العميل في /api/farm/config. الأقسام الخاصة لا تخرج من الخادم أبدًا.',
  publicNone: 'لم يُرجع الخادم مقتطفًا عامًا.',
  publicLegendPublic: 'يصل إلى اللاعب',
  publicLegendPrivate: 'خاص بالخادم',

  playersTitle: 'اللاعبون',
  playersBody: 'ابحث بمعرّف المستخدم لرؤية مزرعته كما هي على الخادم (بلا تحريك أي طباعة)، ولمنح أو خصم عملات المزرعة مع سبب مُسجَّل.',
  userIdLabel: 'معرّف المستخدم',
  userIdPlaceholder: 'usr_…',
  lookup: 'بحث',
  lookingUp: 'جارٍ البحث…',
  lookupFailed: 'تعذّر جلب اللاعب',
  noFarm: 'هذا اللاعب لم يفتح اللعبة بعد. المنحة تُنشئ مزرعته أولًا.',
  farmName: 'اسم المزرعة',
  level: (n) => `المستوى ${n}`,
  xp: (xp, next) => `${xp} / ${next} خبرة`,
  reputation: 'السمعة',
  coins: 'عملات المزرعة',
  state: 'الحالة',
  location: 'الموقع',
  stats: 'الإحصاءات',
  statDelivered: 'مُسلَّم',
  statLate: 'متأخر',
  statCancelled: 'ملغى',
  statPrints: 'طبعات',
  statFailures: 'أعطال',
  statStreak: 'سلسلة',
  statLifetime: 'أرباح إجمالية',
  printers: 'الطابعات',
  printersNone: 'لا طابعات',
  spools: 'البكرات',
  jobsActive: 'طلبات نشطة',
  jobsOffered: 'عروض معلّقة',
  jobsRecent: 'آخر الطلبات (سجل)',
  jobsNone: 'لا طلبات',
  ledger: 'آخر حركات الدفتر',
  ledgerNone: 'لا حركات',
  colId: 'المعرّف',
  colKind: 'النوع',
  colAmount: 'المبلغ',
  colNote: 'ملاحظة',
  colDate: 'التاريخ',
  colState: 'الحالة',
  colModel: 'الموديل',
  colHealth: 'الصحة',
  colQty: 'الكمية',
  colReward: 'المكافأة',
  colTitle: 'العنوان',
  colProduct: 'المنتج',
  colMaterial: 'المادة',
  colTier: 'الفئة',
  dash: '—',

  grantTitle: 'منح عملات مزرعة',
  grantBody: 'عملات المزرعة فقط — لا تُلمس نقاط ليفونيس هنا. القيمة السالبة خصم، ويرفضه الخادم إن لم يكفِ الرصيد. كل عملية تُسجَّل في التدقيق.',
  amount: 'المبلغ (عملات مزرعة)',
  amountHint: 'عدد صحيح غير صفري؛ السالب خصم',
  amountInvalid: 'أدخل عددًا صحيحًا غير صفري',
  reason: 'السبب',
  reasonHint: '٥ محارف على الأقل؛ يظهر في دفتر اللاعب وسجل التدقيق',
  reasonShort: 'السبب قصير جدًا (٥ محارف على الأقل)',
  idemKey: 'مفتاح التكرار',
  idemHint: 'يُولَّد لكل محاولة؛ إعادة الإرسال بالمفتاح نفسه لا تكرّر المنحة',
  regenerateKey: 'توليد مفتاح جديد',
  grantSubmit: 'منح',
  deductSubmit: 'خصم',
  confirmGrantTitle: 'تأكيد حركة العملات',
  confirmGrantBody: (amount, who) => `منح ${amount} عملة مزرعة إلى ${who}؟`,
  confirmDeductBody: (amount, who) => `خصم ${amount} عملة مزرعة من ${who}؟`,
  confirm: 'تأكيد',
  granted: (amount, balance) => `تمت الحركة ${amount} — رصيد اللاعب الآن ${balance}`,
  replayed: (balance) => `هذه المحاولة سُجِّلت من قبل بنفس المفتاح — الرصيد ${balance}`,
  grantFailed: 'تعذّرت الحركة',
  insufficient: 'رصيد اللاعب لا يكفي لهذا الخصم',

  unitCoins: 'عملة',
  showJson: 'عرض JSON',
  hideJson: 'إخفاء JSON',
  problemsInSection: (n) => `${n} مشكلة في القسم المخزّن`,
  refreshed: (version) => `تم التحديث من الخادم — الإصدار ${version}`,
  discarded: 'أُعيدت القيم المحفوظة',
  addItem: 'إضافة عنصر',
  removeItem: (n) => `إزالة العنصر ${n}`,
  xpTop: 'أعلى مستوى',
  userLine: (name, username) => `${name} · @${username}`,
  colColor: 'اللون',
  colGrams: 'الغرامات',
  colQuality: 'الجودة',
  colNickname: 'الاسم',
  colSlot: 'الموضع',
  colDeadline: 'الموعد',
  colCreated: 'أُنشئ',
  colRef: 'المرجع',
};

const en: FarmAdminStrings = {
  title: 'Printer Farm — game balancing',
  subtitle: 'Every number the game runs on is edited here and applies at once, no deploy. The server normalises each section before storing it and refuses what the engine cannot run on.',
  version: (n) => `Version ${n}`,
  schema: (n) => `Schema ${n}`,
  refresh: 'Refresh from the server',
  loading: 'Loading the configuration…',
  loadFailed: 'The farm configuration could not be loaded',
  retry: 'Retry',
  sectionsCount: (n) => `${n} sections`,
  privateChip: 'private',
  publicChip: 'public',
  fieldsCount: (n) => `${n} fields`,
  entriesCount: (n) => `${n} entries`,
  unsavedMark: 'unsaved changes',

  problemsTitle: 'The stored configuration has problems',
  problemsBody: 'The engine runs on the normalised copy, but these rules do not hold. Fix them and save the section concerned.',
  conflictTitle: 'The configuration changed elsewhere',
  conflictBody: (current) => `The server is now at version ${current}. Reload before saving; your unsaved edits stay where they are.`,
  reload: 'Reload',
  reloadNote: 'Reloading fetches the current version and keeps the sections you edited but did not save.',

  save: 'Save this section',
  saving: 'Saving…',
  noChanges: 'No changes',
  savedOk: (version) => `Saved — version ${version}`,
  saveFailed: 'Save failed',
  invalidTitle: 'The server refused this section',
  discard: 'Discard edits',
  resetDefaults: 'Reset to defaults',
  resetTitle: (section) => `Reset “${section}” to the defaults?`,
  resetBody: 'Every value in this section is replaced by the code defaults and the version is bumped. The only way back is to retype the values.',
  typeReset: 'Type RESET to confirm',
  confirmReset: 'Reset to defaults',
  resetDone: (version) => `Section reset to the defaults — version ${version}`,
  cancel: 'Cancel',
  working: 'Working…',
  close: 'Close',

  defaultIs: (v) => `Default: ${v}`,
  starsPreview: (stars) => `= ${stars} ★`,
  percentPreview: (pct) => `= ${pct}%`,
  on: 'On',
  off: 'Off',
  langAr: 'Arabic',
  langEn: 'English',
  langCkb: 'Sorani',
  addChip: 'Add',
  chipPlaceholder: 'key, then Enter',
  removeChip: (v) => `Remove ${v}`,
  addNumber: 'Add value',
  removeNumber: (i) => `Remove value ${i}`,
  emptyList: 'The list is empty',
  shapeUnsupported: 'Shape the editor does not know — shown as is',

  keysFixed: 'The engine fixes these keys: values can be edited, rows cannot be added.',
  addEntry: 'Add row',
  removeEntry: 'Remove row',
  removeTitle: 'Remove this row?',
  removeBody: (id) => `“${id}” leaves the section when you save. Any reference to it from another section is refused by the server until you fix it.`,
  remove: 'Remove',
  keyLabel: 'Key',
  keyPlaceholder: 'e.g. a1_mini',
  keyInvalid: 'Latin letters, digits, _ and - only (up to 40)',
  keyTaken: 'This key already exists',
  keyLocked: 'Key locked — other rows reference it',
  expandRow: (id) => `Expand ${id}`,
  collapseRow: (id) => `Collapse ${id}`,
  newRow: 'new',
  rowN: (n) => `Row ${n}`,

  publicTitle: 'What reaches the player',
  publicBody: 'A read-only excerpt from the server: the sections a customer receives from /api/farm/config. Private sections never leave the server.',
  publicNone: 'The server returned no public excerpt.',
  publicLegendPublic: 'reaches the player',
  publicLegendPrivate: 'server only',

  playersTitle: 'Players',
  playersBody: 'Look a player up by user id to see their farm as it stands on the server (nothing is moved), and to grant or deduct Farm Coins with a recorded reason.',
  userIdLabel: 'User id',
  userIdPlaceholder: 'usr_…',
  lookup: 'Look up',
  lookingUp: 'Looking up…',
  lookupFailed: 'The player could not be fetched',
  noFarm: 'This player has not opened the game yet. A grant creates the farm first.',
  farmName: 'Farm name',
  level: (n) => `Level ${n}`,
  xp: (xp, next) => `${xp} / ${next} xp`,
  reputation: 'Reputation',
  coins: 'Farm Coins',
  state: 'State',
  location: 'Location',
  stats: 'Stats',
  statDelivered: 'Delivered',
  statLate: 'Late',
  statCancelled: 'Cancelled',
  statPrints: 'Prints',
  statFailures: 'Failures',
  statStreak: 'Streak',
  statLifetime: 'Lifetime coins',
  printers: 'Printers',
  printersNone: 'No printers',
  spools: 'Spools',
  jobsActive: 'Active jobs',
  jobsOffered: 'Open offers',
  jobsRecent: 'Recent jobs (log)',
  jobsNone: 'No jobs',
  ledger: 'Ledger tail',
  ledgerNone: 'No movements',
  colId: 'Id',
  colKind: 'Kind',
  colAmount: 'Amount',
  colNote: 'Note',
  colDate: 'Date',
  colState: 'State',
  colModel: 'Model',
  colHealth: 'Health',
  colQty: 'Qty',
  colReward: 'Reward',
  colTitle: 'Title',
  colProduct: 'Product',
  colMaterial: 'Material',
  colTier: 'Tier',
  dash: '—',

  grantTitle: 'Grant Farm Coins',
  grantBody: 'Farm Coins only — Levonis Points are never touched here. A negative amount is a deduction, refused by the server when the balance cannot cover it. Every movement is audited.',
  amount: 'Amount (Farm Coins)',
  amountHint: 'Non-zero integer; negative = deduction',
  amountInvalid: 'Enter a non-zero integer',
  reason: 'Reason',
  reasonHint: 'At least 5 characters; shown on the player’s ledger and in the audit log',
  reasonShort: 'The reason is too short (at least 5 characters)',
  idemKey: 'Idempotency key',
  idemHint: 'Generated per attempt; resending with the same key never grants twice',
  regenerateKey: 'Generate a new key',
  grantSubmit: 'Grant',
  deductSubmit: 'Deduct',
  confirmGrantTitle: 'Confirm the coin movement',
  confirmGrantBody: (amount, who) => `Grant ${amount} Farm Coins to ${who}?`,
  confirmDeductBody: (amount, who) => `Deduct ${amount} Farm Coins from ${who}?`,
  confirm: 'Confirm',
  granted: (amount, balance) => `Movement ${amount} recorded — the player’s balance is now ${balance}`,
  replayed: (balance) => `This attempt was already recorded under the same key — balance ${balance}`,
  grantFailed: 'The movement failed',
  insufficient: 'The player’s balance cannot cover this deduction',

  unitCoins: 'coins',
  showJson: 'Show JSON',
  hideJson: 'Hide JSON',
  problemsInSection: (n) => `${n} problem(s) in the stored section`,
  refreshed: (version) => `Refreshed from the server — version ${version}`,
  discarded: 'Saved values restored',
  addItem: 'Add item',
  removeItem: (n) => `Remove item ${n}`,
  xpTop: 'top level',
  userLine: (name, username) => `${name} · @${username}`,
  colColor: 'Colour',
  colGrams: 'Grams',
  colQuality: 'Quality',
  colNickname: 'Nickname',
  colSlot: 'Slot',
  colDeadline: 'Deadline',
  colCreated: 'Created',
  colRef: 'Ref',
};

const ckb: FarmAdminStrings = {
  title: 'کێڵگەی چاپکەر — هاوسەنگکردنی یاری',
  subtitle: 'هەموو ژمارەیەک کە یاری پێی کاردەکات لێرە دەگۆڕدرێت و دەستبەجێ جێبەجێ دەبێت، بەبێ بڵاوکردنەوە. سێرڤەر هەر بەشێک ئاسایی دەکات پێش پاشەکەوتکردن و ئەوەی بزوێنەر پێی کارناکات ڕەت دەکاتەوە.',
  version: (n) => `وەشان ${n}`,
  schema: (n) => `نەخشە ${n}`,
  refresh: 'نوێکردنەوە لە سێرڤەر',
  loading: 'ڕێکخستنەکان بار دەکرێن…',
  loadFailed: 'ڕێکخستنی کێڵگە بار نەکرا',
  retry: 'هەوڵدانەوە',
  sectionsCount: (n) => `${n} بەش`,
  privateChip: 'تایبەت',
  publicChip: 'گشتی',
  fieldsCount: (n) => `${n} خانە`,
  entriesCount: (n) => `${n} دانە`,
  unsavedMark: 'گۆڕانکاری پاشەکەوتنەکراو',

  problemsTitle: 'ڕێکخستنە پاشەکەوتکراوەکە کێشەی هەیە',
  problemsBody: 'بزوێنەر لەسەر کۆپی ئاساییکراو کاردەکات، بەڵام ئەم یاساکان جێبەجێ نابن. ڕاستیان بکە و بەشی پەیوەندیدار پاشەکەوت بکە.',
  conflictTitle: 'ڕێکخستنەکان لە شوێنێکی دیکە گۆڕدران',
  conflictBody: (current) => `سێرڤەر ئێستا لە وەشانی ${current}دایە. پێش پاشەکەوتکردن دووبارە بار بکە؛ گۆڕانکارییە پاشەکەوتنەکراوەکانت لە شوێنی خۆیان دەمێننەوە.`,
  reload: 'دووبارە بارکردن',
  reloadNote: 'دووبارە بارکردن وەشانی ئێستا دەهێنێت و ئەو بەشانە دەهێڵێتەوە کە گۆڕیوتن بەڵام پاشەکەوت نەکراون.',

  save: 'ئەم بەشە پاشەکەوت بکە',
  saving: 'پاشەکەوت دەکرێت…',
  noChanges: 'هیچ گۆڕانکاری نییە',
  savedOk: (version) => `پاشەکەوت کرا — وەشان ${version}`,
  saveFailed: 'پاشەکەوتکردن سەرکەوتوو نەبوو',
  invalidTitle: 'سێرڤەر ئەم بەشە ڕەت کردەوە',
  discard: 'گۆڕانکارییەکان فەرامۆش بکە',
  resetDefaults: 'گەڕاندنەوە بۆ بنەڕەت',
  resetTitle: (section) => `«${section}» بگەڕێنرێتەوە بۆ بنەڕەت؟`,
  resetBody: 'هەموو بەهاکانی ئەم بەشە بە بەهای بنەڕەتی کۆد دەگۆڕدرێن و وەشان بەرز دەبێتەوە. تەنها ڕێگای گەڕانەوە نووسینەوەی بەهاکانە بە دەست.',
  typeReset: 'RESET بنووسە بۆ دڵنیابوون',
  confirmReset: 'گەڕاندنەوە بۆ بنەڕەت',
  resetDone: (version) => `بەش گەڕێنرایەوە بۆ بنەڕەت — وەشان ${version}`,
  cancel: 'پاشگەزبوونەوە',
  working: 'خەریکە…',
  close: 'داخستن',

  defaultIs: (v) => `بنەڕەت: ${v}`,
  starsPreview: (stars) => `= ${stars} ★`,
  percentPreview: (pct) => `= ${pct}%`,
  on: 'چالاک',
  off: 'ناچالاک',
  langAr: 'عەرەبی',
  langEn: 'ئینگلیزی',
  langCkb: 'کوردی',
  addChip: 'زیادکردن',
  chipPlaceholder: 'کلیل، پاشان Enter',
  removeChip: (v) => `لابردنی ${v}`,
  addNumber: 'بەها زیاد بکە',
  removeNumber: (i) => `لابردنی بەهای ${i}`,
  emptyList: 'لیستەکە بەتاڵە',
  shapeUnsupported: 'شێوەیەک کە دەستکاریکەر نایناسێت — وەک خۆی پیشان دەدرێت',

  keysFixed: 'بزوێنەر ئەم کلیلانە جێگیر کردووە: بەهاکان دەگۆڕدرێن، ڕیز زیاد ناکرێت.',
  addEntry: 'ڕیز زیاد بکە',
  removeEntry: 'ڕیز لاببە',
  removeTitle: 'ئەم ڕیزە لابردرێت؟',
  removeBody: (id) => `«${id}» لە کاتی پاشەکەوتکردن لە بەشەکە دەردەچێت. هەر ئاماژەیەک بۆی لە بەشێکی دیکە لەلایەن سێرڤەرەوە ڕەت دەکرێتەوە هەتا ڕاستی دەکەیت.`,
  remove: 'لابردن',
  keyLabel: 'کلیل',
  keyPlaceholder: 'نموونە: a1_mini',
  keyInvalid: 'تەنها پیتی لاتینی، ژمارە، _ و - (هەتا ٤٠)',
  keyTaken: 'ئەم کلیلە هەیە',
  keyLocked: 'کلیل داخراوە — ڕیزەکانی دیکە ئاماژەی پێدەکەن',
  expandRow: (id) => `کردنەوەی ${id}`,
  collapseRow: (id) => `داخستنی ${id}`,
  newRow: 'نوێ',
  rowN: (n) => `ڕیزی ${n}`,

  publicTitle: 'ئەوەی دەگاتە یاریزان',
  publicBody: 'پارچەیەکی تەنها-خوێندنەوە لە سێرڤەر: ئەو بەشانەی کڕیار لە /api/farm/config وەریدەگرێت. بەشە تایبەتەکان هەرگیز لە سێرڤەر دەرناچن.',
  publicNone: 'سێرڤەر هیچ پارچەیەکی گشتی نەگەڕاندەوە.',
  publicLegendPublic: 'دەگاتە یاریزان',
  publicLegendPrivate: 'تەنها سێرڤەر',

  playersTitle: 'یاریزانان',
  playersBody: 'بە ناسنامەی بەکارهێنەر بگەڕێ بۆ بینینی کێڵگەکەی وەک لەسەر سێرڤەرە (هیچ شتێک ناجوڵێت)، و بۆ بەخشین یان کەمکردنەوەی دراوی کێڵگە لەگەڵ هۆکارێکی تۆمارکراو.',
  userIdLabel: 'ناسنامەی بەکارهێنەر',
  userIdPlaceholder: 'usr_…',
  lookup: 'گەڕان',
  lookingUp: 'دەگەڕێت…',
  lookupFailed: 'یاریزان نەهێنرا',
  noFarm: 'ئەم یاریزانە هێشتا یارییەکەی نەکردووەتەوە. بەخشین سەرەتا کێڵگەکەی دروست دەکات.',
  farmName: 'ناوی کێڵگە',
  level: (n) => `ئاست ${n}`,
  xp: (xp, next) => `${xp} / ${next} ئەزموون`,
  reputation: 'ناوبانگ',
  coins: 'دراوی کێڵگە',
  state: 'دۆخ',
  location: 'شوێن',
  stats: 'ئامارەکان',
  statDelivered: 'گەیەنراو',
  statLate: 'دواکەوتوو',
  statCancelled: 'هەڵوەشێنراو',
  statPrints: 'چاپکراو',
  statFailures: 'شکست',
  statStreak: 'زنجیرە',
  statLifetime: 'کۆی دراو',
  printers: 'چاپکەرەکان',
  printersNone: 'هیچ چاپکەرێک نییە',
  spools: 'بۆبینەکان',
  jobsActive: 'کارە چالاکەکان',
  jobsOffered: 'پێشنیارە کراوەکان',
  jobsRecent: 'دوایین کارەکان (تۆمار)',
  jobsNone: 'هیچ کارێک نییە',
  ledger: 'دوایین جوڵەکانی تۆمار',
  ledgerNone: 'هیچ جوڵەیەک نییە',
  colId: 'ناسنامە',
  colKind: 'جۆر',
  colAmount: 'بڕ',
  colNote: 'تێبینی',
  colDate: 'بەروار',
  colState: 'دۆخ',
  colModel: 'مۆدێل',
  colHealth: 'تەندروستی',
  colQty: 'ژمارە',
  colReward: 'خەڵات',
  colTitle: 'ناونیشان',
  colProduct: 'بەرهەم',
  colMaterial: 'ماددە',
  colTier: 'پلە',
  dash: '—',

  grantTitle: 'بەخشینی دراوی کێڵگە',
  grantBody: 'تەنها دراوی کێڵگە — خاڵەکانی لیڤۆنیس لێرە دەست لێ نادرێت. بڕی نەرێنی کەمکردنەوەیە و سێرڤەر ڕەتی دەکاتەوە ئەگەر باڵانس بەش نەکات. هەموو جوڵەیەک تۆمار دەکرێت.',
  amount: 'بڕ (دراوی کێڵگە)',
  amountHint: 'ژمارەی تەواوی ناسفر؛ نەرێنی = کەمکردنەوە',
  amountInvalid: 'ژمارەیەکی تەواوی ناسفر بنووسە',
  reason: 'هۆکار',
  reasonHint: 'لانیکەم ٥ پیت؛ لە تۆماری یاریزان و لۆگی وردبینی دەردەکەوێت',
  reasonShort: 'هۆکارەکە زۆر کورتە (لانیکەم ٥ پیت)',
  idemKey: 'کلیلی دووبارەنەبوونەوە',
  idemHint: 'بۆ هەر هەوڵێک دروست دەکرێت؛ ناردنەوە بە هەمان کلیل هەرگیز دوو جار نابەخشێت',
  regenerateKey: 'کلیلێکی نوێ دروست بکە',
  grantSubmit: 'بەخشین',
  deductSubmit: 'کەمکردنەوە',
  confirmGrantTitle: 'دڵنیابوون لە جوڵەی دراو',
  confirmGrantBody: (amount, who) => `${amount} دراوی کێڵگە بە ${who} ببەخشرێت؟`,
  confirmDeductBody: (amount, who) => `${amount} دراوی کێڵگە لە ${who} کەم بکرێتەوە؟`,
  confirm: 'دڵنیابوون',
  granted: (amount, balance) => `جوڵەی ${amount} تۆمار کرا — باڵانسی یاریزان ئێستا ${balance}`,
  replayed: (balance) => `ئەم هەوڵە پێشتر بە هەمان کلیل تۆمار کرابوو — باڵانس ${balance}`,
  grantFailed: 'جوڵەکە سەرکەوتوو نەبوو',
  insufficient: 'باڵانسی یاریزان بۆ ئەم کەمکردنەوە بەش ناکات',

  unitCoins: 'دراو',
  showJson: 'پیشاندانی JSON',
  hideJson: 'شاردنەوەی JSON',
  problemsInSection: (n) => `${n} کێشە لە بەشە پاشەکەوتکراوەکە`,
  refreshed: (version) => `لە سێرڤەر نوێ کرایەوە — وەشان ${version}`,
  discarded: 'بەهای پاشەکەوتکراوەکان گەڕێنرانەوە',
  addItem: 'دانە زیاد بکە',
  removeItem: (n) => `لابردنی دانەی ${n}`,
  xpTop: 'بەرزترین ئاست',
  userLine: (name, username) => `${name} · @${username}`,
  colColor: 'ڕەنگ',
  colGrams: 'گرام',
  colQuality: 'کوالیتی',
  colNickname: 'نازناو',
  colSlot: 'شوێن',
  colDeadline: 'کاتی کۆتایی',
  colCreated: 'دروستکراو',
  colRef: 'ئاماژە',
};

export const FARM_ADMIN_STRINGS: Record<Language, FarmAdminStrings> = { ar, en, ckb };

export function adminStrings(lang: string): FarmAdminStrings {
  return lang === 'en' || lang === 'ckb' ? FARM_ADMIN_STRINGS[lang] : FARM_ADMIN_STRINGS.ar;
}

// -------------------------------------------------------------------- labels

export interface FieldLabel {
  ar: string;
  en: string;
  ckb: string;
  hint?: { ar: string; en: string; ckb: string };
}

const L = (ar: string, en: string, ckb: string, hint?: [string, string, string]): FieldLabel =>
  hint ? { ar, en, ckb, hint: { ar: hint[0], en: hint[1], ckb: hint[2] } } : { ar, en, ckb };

/**
 * Curated labels for docs/PRINTER_FARM.md §5. Keyed by dotted path; `*`
 * stands for a catalog entry. A key not here is humanised from its name.
 */
export const LABELS: Record<string, FieldLabel> = {
  // sections
  time: L('الوقت', 'Time', 'کات', ['ساعة اللعبة: كم ثانية لعب في الثانية الحقيقية، ومواعيد التحديث.', 'The game clock: game seconds per real second, and the refresh cadence.', 'کاتژمێری یاری: چرکەی یاری بۆ هەر چرکەیەکی ڕاستەقینە، و ڕیتمی نوێکردنەوە.']),
  economy: L('الاقتصاد', 'Economy', 'ئابووری', ['عملات البداية، إعادة البيع، البكرات، الصيانة والإصلاح والكهرباء.', 'Starter coins, resale, spools, maintenance, repair and electricity.', 'دراوی دەستپێک، فرۆشتنەوە، بۆبین، چاککردن، چاکسازی و کارەبا.']),
  printers: L('كتالوج الطابعات', 'Printer catalog', 'کاتالۆگی چاپکەرەکان', ['الموديلات التي يشتريها اللاعب؛ المفتاح هو معرّف الموديل الذي تشير إليه الطابعات المملوكة.', 'The models a player can buy; the key is the model id owned printers point at.', 'ئەو مۆدێلانەی یاریزان دەیانکڕێت؛ کلیلەکە ناسنامەی مۆدێلە کە چاپکەرە خاوەندارییەکان ئاماژەی پێدەکەن.']),
  materials: L('المواد', 'Materials', 'ماددەکان', ['الفيلامنت: سعر الغرام، الصعوبة، المستوى، والألوان المتاحة.', 'Filaments: price per gram, difficulty, level and the colours sold.', 'فیلامێنت: نرخی گرام، ئاستەنگی، ئاست و ڕەنگە فرۆشراوەکان.']),
  colors: L('الألوان', 'Colours', 'ڕەنگەکان', ['الألوان التي تشير إليها المواد، بالاسم في ثلاث لغات وقيمة hex.', 'The colours materials reference, named in three languages with a hex value.', 'ئەو ڕەنگانەی ماددەکان ئاماژەی پێدەکەن، بە ناو لە سێ زمان و بەهای hex.']),
  products: L('المنتجات (قوالب الطلبات)', 'Products (job templates)', 'بەرهەمەکان (قاڵبی کارەکان)', ['ما يطلبه العملاء: غرامات وثواني الجزء الواحد على الطابعة المرجعية.', 'What customers order: grams and seconds per part on the reference printer.', 'ئەوەی کڕیاران داوای دەکەن: گرام و چرکە بۆ هەر پارچەیەک لەسەر چاپکەری سەرچاوە.']),
  customers: L('فئات العملاء', 'Customer tiers', 'پلەکانی کڕیار', ['خمس فئات ثابتة تُفتح بالسمعة والمستوى وتحدّد الكميات والمواعيد والهوامش.', 'Five fixed tiers unlocked by reputation and level; they set quantities, deadlines and margins.', 'پێنج پلەی جێگیر کە بە ناوبانگ و ئاست دەکرێنەوە؛ ژمارە، کاتی کۆتایی و قازانج دیاری دەکەن.']),
  jobs: L('الطلبات', 'Jobs', 'کارەکان', ['لوح العروض، مهلة العرض، سماح التأخير، سقف الطلبات النشطة وصيغة المكافأة.', 'The offer board, offer lifetime, late grace, active-job cap and the reward formula.', 'بۆردی پێشنیار، تەمەنی پێشنیار، مۆڵەتی دواکەوتن، سنووری کاری چالاک و فۆرمولای خەڵات.']),
  quality: L('مستويات الجودة', 'Quality levels', 'ئاستەکانی کوالیتی', ['أربعة مستويات ثابتة: معامل الوقت والعطل والسمعة لكل منها.', 'Four fixed levels: time, failure and reputation factors for each.', 'چوار ئاستی جێگیر: هۆکاری کات، شکست و ناوبانگ بۆ هەر یەکێک.']),
  failure: L('الأعطال', 'Failure', 'شکست', ['احتمال العطل الأساسي وأوزانه وأنواعه — أرقام يراها اللاعب كمخاطرة على ورقة التعيين.', 'The base failure probability, its weights and kinds — a risk the player sees on the assign sheet.', 'ئەگەری بنەڕەتی شکست، کێشەکان و جۆرەکانی — مەترسییەک کە یاریزان لە شیتی دابەشکردن دەیبینێت.']),
  progression: L('التقدّم', 'Progression', 'پێشکەوتن', ['الخبرة والمستويات والسمعة، ومستوى فتح كل ميزة.', 'XP, levels, reputation and the level each feature unlocks at.', 'ئەزموون، ئاستەکان، ناوبانگ و ئاستی کردنەوەی هەر تایبەتمەندییەک.']),
  locations: L('المواقع', 'Locations', 'شوێنەکان', ['الغرف التي ينمو فيها اللاعب: سعة الطابعات والمخزون والسعر ومستوى الفتح.', 'The rooms a player grows through: printer slots, storage, price and unlock level.', 'ئەو ژوورانەی یاریزان تێیاندا گەشە دەکات: شوێنی چاپکەر، کۆگا، نرخ و ئاستی کردنەوە.']),
  starter: L('حزمة البداية', 'Starter kit', 'پاکێجی دەستپێک', ['ما يستلمه اللاعب الجديد: الطابعة والبكرة وأول طلب. كل مرجع هنا يجب أن يوجد في كتالوجه.', 'What a new player receives: printer, spool and first job. Every reference here must exist in its catalog.', 'ئەوەی یاریزانی نوێ وەریدەگرێت: چاپکەر، بۆبین و یەکەم کار. هەر ئاماژەیەک لێرە دەبێت لە کاتالۆگەکەی هەبێت.']),
  limits: L('الحدود (خاص)', 'Limits (private)', 'سنوورەکان (تایبەت)', ['سقوف مكافحة الإساءة اليومية — لا تصل إلى العميل أبدًا.', 'Daily anti-abuse caps — never sent to the client.', 'سنوورە ڕۆژانەکانی دژە-خراپبەکارهێنان — هەرگیز بۆ کڕیار نانێردرێن.']),
  rewards: L('المكافآت (خاص)', 'Rewards (private)', 'خەڵاتەکان (تایبەت)', ['تحويل عملات المزرعة إلى نقاط ليفونيس — المرحلة ٥. المفتاح enabled لا يُقبل true في هذه المرحلة لأن لا مسار يسكّ النقاط.', 'Farm Coins → Levonis Points conversion — Phase 5. `enabled` cannot be true in this phase: no code path mints Points.', 'گۆڕینی دراوی کێڵگە بۆ خاڵی لیڤۆنیس — قۆناغی ٥. `enabled` لەم قۆناغە نابێت true بێت: هیچ ڕێڕەوێک خاڵ دروست ناکات.']),

  // time
  'time.time_scale': L('مقياس الوقت', 'Time scale', 'پێوانەی کات', ['ثوانٍ لعب لكل ثانية حقيقية؛ 20 يجعل ساعة اللعبة ≈ 3 دقائق حقيقية.', 'Game seconds per real second; 20 makes a game hour ≈ 3 real minutes.', 'چرکەی یاری بۆ هەر چرکەیەکی ڕاستەقینە؛ ٢٠ کاتژمێری یاری ≈ ٣ خولەکی ڕاستەقینە دەکات.']),
  'time.offer_refresh_minutes': L('تحديث العروض (دقائق حقيقية)', 'Offer refresh (real minutes)', 'نوێکردنەوەی پێشنیار (خولەکی ڕاستەقینە)'),
  'time.away_summary_after_minutes': L('ملخّص الغياب بعد (دقائق حقيقية)', 'Away summary after (real minutes)', 'پوختەی نەبوون دوای (خولەکی ڕاستەقینە)', ['طول الغياب الذي يُظهر ورقة «بينما كنت بعيدًا».', 'How long an absence must be before the “While you were away” sheet shows.', 'ماوەی نەبوون پێش ئەوەی شیتی «کاتێک نەبوویت» دەربکەوێت.']),
  'time.reference_speed_mms': L('سرعة الطابعة المرجعية (مم/ث)', 'Reference printer speed (mm/s)', 'خێرایی چاپکەری سەرچاوە (mm/s)', ['أزمنة المنتجات مقيسة على هذه السرعة؛ معامل المدة = هذه ÷ سرعة الموديل.', 'Product times are quoted at this speed; duration factor = this ÷ the model’s speed.', 'کاتی بەرهەمەکان لەسەر ئەم خێراییە داندراون؛ هۆکاری ماوە = ئەمە ÷ خێرایی مۆدێل.']),

  // economy
  'economy.starter_coins': L('عملات البداية', 'Starter coins', 'دراوی دەستپێک'),
  'economy.resale_factor': L('معامل إعادة البيع', 'Resale factor', 'هۆکاری فرۆشتنەوە', ['نسبة سعر الكتالوج التي يستلمها اللاعب عند بيع طابعة.', 'Share of the catalog price a player gets back when selling a printer.', 'بەشی نرخی کاتالۆگ کە یاریزان لە فرۆشتنی چاپکەر وەریدەگرێتەوە.']),
  'economy.spool_sizes_g': L('أحجام البكرات (غ)', 'Spool sizes (g)', 'قەبارەی بۆبین (g)', ['الأوزان التي يبيعها السوق.', 'The weights the market sells.', 'ئەو کێشانەی بازاڕ دەیانفرۆشێت.']),
  'economy.maintenance': L('الصيانة', 'Maintenance', 'چاککردن'),
  'economy.maintenance.cost': L('كلفة الصيانة', 'Maintenance cost', 'تێچووی چاککردن'),
  'economy.maintenance.minutes': L('مدة الصيانة (دقائق لعب)', 'Maintenance duration (game minutes)', 'ماوەی چاککردن (خولەکی یاری)'),
  'economy.maintenance.health_restore': L('الصحة بعد الصيانة', 'Health after maintenance', 'تەندروستی دوای چاککردن', ['0–100', '0–100', '0–100']),
  'economy.repair': L('الإصلاح', 'Repair', 'چاکسازی'),
  'economy.repair.cost': L('كلفة الإصلاح', 'Repair cost', 'تێچووی چاکسازی'),
  'economy.repair.minutes': L('مدة الإصلاح (دقائق لعب)', 'Repair duration (game minutes)', 'ماوەی چاکسازی (خولەکی یاری)'),
  'economy.repair.health': L('الصحة بعد الإصلاح', 'Health after repair', 'تەندروستی دوای چاکسازی', ['0–100', '0–100', '0–100']),
  'economy.energy': L('الكهرباء', 'Energy', 'کارەبا'),
  'economy.energy.coins_per_kwh': L('عملات لكل كيلوواط·ساعة', 'Coins per kWh', 'دراو بۆ هەر kWh', ['تُخصم لكل ساعة طباعة: هذه × واط الموديل ÷ 1000.', 'Debited per printing hour: this × the model’s watts ÷ 1000.', 'بۆ هەر کاتژمێرێکی چاپ کەم دەکرێتەوە: ئەمە × واتی مۆدێل ÷ ١٠٠٠.']),

  // printers
  'printers.*.name': L('الاسم', 'Name', 'ناو'),
  'printers.*.family': L('العائلة', 'Family', 'خێزان', ['A أو P أو X أو H', 'A, P, X or H', 'A، P، X یان H']),
  'printers.*.price': L('السعر', 'Price', 'نرخ'),
  'printers.*.speed': L('السرعة (مم/ث)', 'Speed (mm/s)', 'خێرایی (mm/s)'),
  'printers.*.volume_mm': L('حجم البناء [س، ص، ع] مم', 'Build volume [x, y, z] mm', 'قەبارەی بنیات [x, y, z] mm'),
  'printers.*.materials': L('المواد المدعومة', 'Supported materials', 'ماددە پشتگیریکراوەکان', ['مفاتيح من قسم المواد.', 'Keys from the materials section.', 'کلیلەکان لە بەشی ماددەکان.']),
  'printers.*.ams': L('وحدة AMS (متعدد الألوان)', 'AMS (multi-colour)', 'AMS (فرە ڕەنگ)'),
  'printers.*.reliability': L('الموثوقية', 'Reliability', 'متمانەپێکراوی', ['0–1؛ الأعلى أقل أعطالًا.', '0–1; higher means fewer failures.', '٠–١؛ بەرزتر شکستی کەمتر.']),
  'printers.*.watts': L('الاستهلاك (واط)', 'Power (W)', 'وزە (W)'),
  'printers.*.wear_per_hour': L('التآكل لكل ساعة', 'Wear per hour', 'خواردن بۆ هەر کاتژمێر', ['نقاط صحة تُفقد لكل ساعة تشغيل.', 'Health points lost per operating hour.', 'خاڵی تەندروستی کە بۆ هەر کاتژمێرێکی کارکردن دەفەوتێت.']),
  'printers.*.min_level': L('المستوى الأدنى', 'Minimum level', 'کەمترین ئاست'),
  'printers.*.sort': L('الترتيب', 'Sort order', 'ڕیزبەندی'),

  // materials
  'materials.*.name': L('الاسم', 'Name', 'ناو'),
  'materials.*.price_per_gram': L('السعر لكل غرام', 'Price per gram', 'نرخ بۆ هەر گرام'),
  'materials.*.difficulty': L('الصعوبة', 'Difficulty', 'ئاستەنگی', ['0–1؛ تدخل في احتمال العطل.', '0–1; feeds the failure probability.', '٠–١؛ دەچێتە ناو ئەگەری شکست.']),
  'materials.*.quality': L('جودة البكرة من السوق', 'Spool quality from the market', 'کوالیتی بۆبین لە بازاڕ', ['0–1', '0–1', '٠–١']),
  'materials.*.min_level': L('المستوى الأدنى', 'Minimum level', 'کەمترین ئاست'),
  'materials.*.colors': L('الألوان المتاحة', 'Colours sold', 'ڕەنگە فرۆشراوەکان', ['مفاتيح من قسم الألوان.', 'Keys from the colours section.', 'کلیلەکان لە بەشی ڕەنگەکان.']),

  // colors
  'colors.*.name': L('الاسم', 'Name', 'ناو'),
  'colors.*.hex': L('قيمة hex', 'Hex value', 'بەهای hex', ['#RRGGBB', '#RRGGBB', '#RRGGBB']),

  // products
  'products.*.name': L('الاسم', 'Name', 'ناو'),
  'products.*.grams_per_part': L('غرامات لكل جزء', 'Grams per part', 'گرام بۆ هەر پارچە'),
  'products.*.seconds_per_part': L('ثوانٍ لعب لكل جزء', 'Game seconds per part', 'چرکەی یاری بۆ هەر پارچە', ['على الطابعة المرجعية بجودة عادية.', 'On the reference printer at standard quality.', 'لەسەر چاپکەری سەرچاوە بە کوالیتی ئاسایی.']),
  'products.*.complexity': L('التعقيد', 'Complexity', 'ئاڵۆزی', ['0–1', '0–1', '٠–١']),
  'products.*.max_colors': L('أقصى عدد ألوان', 'Max colours', 'زۆرترین ڕەنگ'),
  'products.*.size_mm': L('الحجم [س، ص، ع] مم', 'Size [x, y, z] mm', 'قەبارە [x, y, z] mm'),
  'products.*.materials': L('المواد المسموحة', 'Allowed materials', 'ماددە ڕێگەپێدراوەکان'),
  'products.*.min_tier': L('أدنى فئة عميل', 'Minimum customer tier', 'کەمترین پلەی کڕیار', ['individual · small_business · merchant · company · industrial', 'individual · small_business · merchant · company · industrial', 'individual · small_business · merchant · company · industrial']),

  // customers
  'customers.individual': L('أفراد', 'Individuals', 'تاکەکان'),
  'customers.small_business': L('أعمال صغيرة', 'Small businesses', 'بازرگانی بچووک'),
  'customers.merchant': L('تجّار', 'Merchants', 'بازرگانان'),
  'customers.company': L('شركات', 'Companies', 'کۆمپانیاکان'),
  'customers.industrial': L('صناعي', 'Industrial', 'پیشەسازی'),
  'customers.*.name': L('الاسم', 'Name', 'ناو'),
  'customers.*.min_reputation_bp': L('السمعة الأدنى', 'Minimum reputation', 'کەمترین ناوبانگ', ['نقاط أساس: 1000 = ★ 1.00', 'Basis points: 1000 = ★ 1.00', 'خاڵی بنەڕەت: ١٠٠٠ = ★ 1.00']),
  'customers.*.min_level': L('المستوى الأدنى', 'Minimum level', 'کەمترین ئاست'),
  'customers.*.qty_range': L('نطاق الكمية [من، إلى]', 'Quantity range [min, max]', 'مەودای ژمارە [کەم، زۆر]'),
  'customers.*.deadline_factor': L('معامل الموعد', 'Deadline factor', 'هۆکاری کاتی کۆتایی', ['الموعد = زمن الطباعة × المعامل + الهامش.', 'Deadline = print time × factor + buffer.', 'کاتی کۆتایی = کاتی چاپ × هۆکار + پاشەکەوت.']),
  'customers.*.reward_margin': L('هامش المكافأة', 'Reward margin', 'قازانجی خەڵات'),
  'customers.*.late_penalty_bp': L('عقوبة التأخير', 'Late penalty', 'سزای دواکەوتن'),
  'customers.*.cancel_penalty_bp': L('عقوبة الإلغاء (سمعة)', 'Cancel penalty (reputation)', 'سزای هەڵوەشاندنەوە (ناوبانگ)'),
  'customers.*.cancel_penalty_coins': L('عقوبة الإلغاء (عملات)', 'Cancel penalty (coins)', 'سزای هەڵوەشاندنەوە (دراو)'),
  'customers.*.reputation_gain_bp': L('مكسب السمعة', 'Reputation gain', 'دەستکەوتی ناوبانگ'),
  'customers.*.weight': L('الوزن', 'Weight', 'کێش', ['التكرار النسبي بين الفئات المفتوحة.', 'Relative frequency among unlocked tiers.', 'دووبارەبوونەوەی ڕێژەیی لە نێوان پلە کراوەکان.']),
  'customers.*.names': L('أسماء العملاء (خيالية)', 'Customer names (fictional)', 'ناوی کڕیاران (خەیاڵی)'),

  // jobs
  'jobs.offers_visible': L('العروض المعروضة', 'Offers visible', 'پێشنیارە بینراوەکان'),
  'jobs.offer_lifetime_minutes': L('مهلة العرض (دقائق حقيقية)', 'Offer lifetime (real minutes)', 'تەمەنی پێشنیار (خولەکی ڕاستەقینە)'),
  'jobs.late_grace_minutes': L('سماح التأخير (دقائق حقيقية)', 'Late grace (real minutes)', 'مۆڵەتی دواکەوتن (خولەکی ڕاستەقینە)', ['بعد الموعد + السماح يلغي العميل الطلب.', 'After deadline + grace the customer cancels the job.', 'دوای کاتی کۆتایی + مۆڵەت کڕیار کارەکە هەڵدەوەشێنێتەوە.']),
  'jobs.deadline_buffer_minutes': L('هامش الموعد (دقائق لعب)', 'Deadline buffer (game minutes)', 'پاشەکەوتی کاتی کۆتایی (خولەکی یاری)'),
  'jobs.max_active_jobs': L('سقف الطلبات النشطة حسب المستوى', 'Max active jobs by level', 'سنووری کاری چالاک بەپێی ئاست', ['العنصر i يخصّ المستوى i+1؛ الأخير يسري على ما فوقه.', 'Entry i applies to level i+1; the last one applies above.', 'دانەی i بۆ ئاستی i+1؛ دوایین بۆ سەرووتر.']),
  'jobs.reward_formula': L('صيغة المكافأة', 'Reward formula', 'فۆرمولای خەڵات', ['المكافأة = غرامات × سعر المادة × الهامش × معامل الغرام + ساعات × عملات الساعة + أجزاء × عملات الجزء، × مضاعف الجودة.', 'Reward = grams × material price × margin × per-gram factor + hours × per-hour coins + parts × per-part coins, × quality multiplier.', 'خەڵات = گرام × نرخی ماددە × قازانج × هۆکاری گرام + کاتژمێر × دراوی کاتژمێر + پارچە × دراوی پارچە، × زێدەکەری کوالیتی.']),
  'jobs.reward_formula.per_gram_factor': L('معامل الغرام', 'Per-gram factor', 'هۆکاری گرام'),
  'jobs.reward_formula.per_hour_coins': L('عملات لكل ساعة طباعة', 'Coins per print hour', 'دراو بۆ هەر کاتژمێری چاپ'),
  'jobs.reward_formula.per_part_coins': L('عملات لكل جزء', 'Coins per part', 'دراو بۆ هەر پارچە'),
  'jobs.reward_formula.quality_multipliers': L('مضاعفات الجودة', 'Quality multipliers', 'زێدەکەرەکانی کوالیتی'),

  // quality
  'quality.draft': L('مسوّدة', 'Draft', 'ڕەشنووس'),
  'quality.standard': L('عادية', 'Standard', 'ئاسایی'),
  'quality.fine': L('دقيقة', 'Fine', 'ورد'),
  'quality.ultra': L('فائقة', 'Ultra', 'زۆر ورد'),
  'quality.*.time_factor': L('معامل الوقت', 'Time factor', 'هۆکاری کات'),
  'quality.*.failure_factor': L('معامل العطل', 'Failure factor', 'هۆکاری شکست'),
  'quality.*.reputation_factor': L('معامل السمعة', 'Reputation factor', 'هۆکاری ناوبانگ'),
  draft: L('مسوّدة', 'Draft', 'ڕەشنووس'),
  standard: L('عادية', 'Standard', 'ئاسایی'),
  fine: L('دقيقة', 'Fine', 'ورد'),
  ultra: L('فائقة', 'Ultra', 'زۆر ورد'),

  // failure
  'failure.base': L('الاحتمال الأساسي', 'Base probability', 'ئەگەری بنەڕەت'),
  'failure.max': L('أقصى احتمال', 'Maximum probability', 'زۆرترین ئەگەر'),
  'failure.weights': L('الأوزان', 'Weights', 'کێشەکان', ['كل وزن هو الإضافة القصوى إلى الاحتمال من عامله.', 'Each weight is the most its factor can add to the probability.', 'هەر کێشێک زۆرترین زیادکردنە کە هۆکارەکەی دەتوانێت بۆ ئەگەر بکات.']),
  'failure.weights.health': L('الصحة', 'Health', 'تەندروستی'),
  'failure.weights.reliability': L('الموثوقية', 'Reliability', 'متمانەپێکراوی'),
  'failure.weights.material': L('صعوبة المادة', 'Material difficulty', 'ئاستەنگی ماددە'),
  'failure.weights.spool': L('جودة البكرة', 'Spool quality', 'کوالیتی بۆبین'),
  'failure.weights.complexity': L('تعقيد المنتج', 'Product complexity', 'ئاڵۆزی بەرهەم'),
  'failure.kinds': L('أنواع الأعطال', 'Failure kinds', 'جۆرەکانی شکست'),
  'failure.kinds.spaghetti': L('سباغيتي', 'Spaghetti', 'سپاگێتی'),
  'failure.kinds.clog': L('انسداد', 'Clog', 'گیران'),
  'failure.kinds.first_layer': L('الطبقة الأولى', 'First layer', 'چینی یەکەم'),
  'failure.kinds.runout': L('نفاد الفيلامنت', 'Filament runout', 'تەواوبوونی فیلامێنت'),
  'failure.kinds.ams_jam': L('انحشار AMS', 'AMS jam', 'گیرانی AMS'),
  'failure.kinds.detach': L('انفصال عن السطح', 'Detach from bed', 'جیابوونەوە لە سەکۆ'),
  'failure.kinds.mechanical': L('عطل ميكانيكي', 'Mechanical', 'میکانیکی'),
  'failure.kinds.*.weight': L('الوزن', 'Weight', 'کێش'),
  'failure.kinds.*.grams_loss_factor': L('نسبة الغرامات المفقودة', 'Grams lost (share)', 'بەشی گرامی فەوتاو'),
  'failure.kinds.*.health_hit': L('ضربة الصحة', 'Health hit', 'زیانی تەندروستی'),
  'failure.kinds.*.breaks': L('يُعطّل الطابعة', 'Breaks the printer', 'چاپکەر تێک دەدات'),
  'failure.kinds.*.time_loss_factor': L('نسبة الوقت المفقود', 'Time lost (share)', 'بەشی کاتی فەوتاو'),
  'failure.kinds.*.ams_only': L('متعدد الألوان فقط', 'Multi-colour batches only', 'تەنها کۆمەڵی فرە ڕەنگ'),

  // progression
  'progression.xp_per_job': L('خبرة لكل طلب', 'XP per job', 'ئەزموون بۆ هەر کار'),
  'progression.xp_per_part': L('خبرة لكل جزء', 'XP per part', 'ئەزموون بۆ هەر پارچە'),
  'progression.level_thresholds': L('عتبات المستويات', 'Level thresholds', 'سنوورەکانی ئاست', ['الخبرة اللازمة لكل مستوى؛ الأول 0 وتصاعدية تمامًا.', 'XP needed for each level; the first is 0 and the list is strictly increasing.', 'ئەزموونی پێویست بۆ هەر ئاست؛ یەکەم ٠ و لیستەکە بەردەوام زیاد دەکات.']),
  'progression.reputation_start_bp': L('السمعة الأولية', 'Starting reputation', 'ناوبانگی دەستپێک'),
  'progression.reputation_cap_bp': L('سقف السمعة', 'Reputation cap', 'سنووری ناوبانگ'),
  'progression.failure_reputation_bp': L('كلفة العطل على السمعة', 'Reputation cost of a failure', 'تێچووی شکست لەسەر ناوبانگ'),
  'progression.unlocks': L('مستويات فتح الميزات', 'Feature unlock levels', 'ئاستەکانی کردنەوەی تایبەتمەندی'),
  'progression.unlocks.market': L('السوق', 'Market', 'بازاڕ'),
  'progression.unlocks.inventory': L('المخزون', 'Inventory', 'کۆگا'),
  'progression.unlocks.maintenance': L('الصيانة', 'Maintenance', 'چاککردن'),
  'progression.unlocks.store': L('المتجر', 'Store', 'فرۆشگا'),
  'progression.unlocks.upgrades': L('التحسينات', 'Upgrades', 'باشترکردنەکان'),
  'progression.unlocks.locations': L('المواقع', 'Locations', 'شوێنەکان'),
  'progression.unlocks.employees': L('الموظفون', 'Employees', 'کارمەندان'),
  'progression.unlocks.contracts': L('العقود', 'Contracts', 'گرێبەستەکان'),
  'progression.unlocks.loans': L('القروض', 'Loans', 'قەرزەکان'),

  // locations
  'locations.*.name': L('الاسم', 'Name', 'ناو'),
  'locations.*.max_printers': L('أقصى عدد طابعات', 'Max printers', 'زۆرترین چاپکەر'),
  'locations.*.storage_grams': L('سعة المخزون (غ)', 'Storage (g)', 'کۆگا (g)'),
  'locations.*.employees': L('الموظفون', 'Employees', 'کارمەندان'),
  'locations.*.price': L('السعر', 'Price', 'نرخ'),
  'locations.*.min_level': L('المستوى الأدنى', 'Minimum level', 'کەمترین ئاست'),

  // starter
  'starter.printer_model': L('موديل الطابعة', 'Printer model', 'مۆدێلی چاپکەر', ['مفتاح من كتالوج الطابعات.', 'A key from the printer catalog.', 'کلیلێک لە کاتالۆگی چاپکەرەکان.']),
  'starter.spool': L('البكرة', 'Spool', 'بۆبین'),
  'starter.spool.material': L('المادة', 'Material', 'ماددە'),
  'starter.spool.color': L('اللون', 'Colour', 'ڕەنگ'),
  'starter.spool.grams': L('الغرامات', 'Grams', 'گرام'),
  'starter.spool.quality': L('الجودة', 'Quality', 'کوالیتی', ['0–1', '0–1', '٠–١']),
  'starter.first_job': L('أول طلب', 'First job', 'یەکەم کار'),
  'starter.first_job.product': L('المنتج', 'Product', 'بەرهەم'),
  'starter.first_job.qty': L('الكمية', 'Quantity', 'ژمارە'),
  'starter.first_job.customer_tier': L('فئة العميل', 'Customer tier', 'پلەی کڕیار'),
  'starter.first_job.quality': L('الجودة المطلوبة', 'Requested quality', 'کوالیتی داواکراو'),
  'starter.first_job.colors': L('الألوان', 'Colours', 'ڕەنگەکان'),

  // limits
  'limits.daily_jobs_cap': L('سقف الطلبات اليومي', 'Daily jobs cap', 'سنووری ڕۆژانەی کار'),
  'limits.daily_coins_cap': L('سقف العملات اليومي', 'Daily coins cap', 'سنووری ڕۆژانەی دراو'),
  'limits.mutations_per_hour': L('التعديلات في الساعة', 'Mutations per hour', 'گۆڕانکاری لە کاتژمێرێک', ['حدّ المعدّل لكل لاعب على كل حركة كتابة.', 'Per-player rate limit on every write.', 'سنووری ڕێژە بۆ هەر یاریزان لەسەر هەر نووسینێک.']),

  // rewards
  'rewards.levonis_points': L('نقاط ليفونيس', 'Levonis Points', 'خاڵەکانی لیڤۆنیس'),
  'rewards.levonis_points.enabled': L('التحويل مفتوح', 'Conversion open', 'گۆڕین کراوەیە', ['لا يُقبل true في هذه المرحلة.', 'Cannot be true in this phase.', 'لەم قۆناغە نابێت true بێت.']),
  'rewards.levonis_points.coins_per_point': L('عملات لكل نقطة', 'Coins per point', 'دراو بۆ هەر خاڵ'),
  'rewards.levonis_points.daily_cap_points': L('سقف النقاط اليومي', 'Daily points cap', 'سنووری ڕۆژانەی خاڵ'),
  'rewards.levonis_points.weekly_cap_points': L('سقف النقاط الأسبوعي', 'Weekly points cap', 'سنووری هەفتانەی خاڵ'),
  'rewards.levonis_points.min_level': L('المستوى الأدنى', 'Minimum level', 'کەمترین ئاست'),
  'rewards.levonis_points.min_reputation_bp': L('السمعة الأدنى', 'Minimum reputation', 'کەمترین ناوبانگ'),
  'rewards.levonis_points.budget_points_per_day': L('ميزانية النقاط اليومية', 'Points budget per day', 'بودجەی ڕۆژانەی خاڵ'),

  // generic last segments — a bare segment is the LAST candidate
  // `labelCandidates` tries, so these never shadow a curated path. The
  // section names `materials`, `colors` and `quality` already sit above as
  // top-level entries and double as the bare-segment fallback; listing them
  // twice was a TS1117 duplicate-key error.
  name: L('الاسم', 'Name', 'ناو'),
  names: L('الأسماء', 'Names', 'ناوەکان'),
  hex: L('قيمة hex', 'Hex value', 'بەهای hex'),
  price: L('السعر', 'Price', 'نرخ'),
  cost: L('الكلفة', 'Cost', 'تێچوو'),
  min_level: L('المستوى الأدنى', 'Minimum level', 'کەمترین ئاست'),
  weight: L('الوزن', 'Weight', 'کێش'),
  enabled: L('مفعّل', 'Enabled', 'چالاک'),
  qty: L('الكمية', 'Quantity', 'ژمارە'),
  grams: L('الغرامات', 'Grams', 'گرام'),
  minutes: L('الدقائق', 'Minutes', 'خولەک'),
};
