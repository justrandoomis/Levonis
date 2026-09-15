import type { Language } from '../../translations';

/**
 * Every visible string of the Printer Farm and the games hub, in the three UI
 * languages. One interface, three literal tables: a key missing from any
 * language is a type error, not a blank label on a player's screen. Function
 * keys take the number they pluralise or interpolate; the digits inside them
 * stay Latin (see format.ts) so a card never mixes two digit systems.
 */
export interface FarmStrings {
  // shell
  title: string;
  back: string;
  coins: string;
  coinsUnit: string;
  level: (n: number) => string;
  xpProgress: (xp: number, next: number) => string;
  reputation: string;
  starsLabel: (stars: string) => string;
  recovery: string;
  /** "Today: X of Y jobs" — the server's daily tally against its cap. */
  todayJobs: (jobs: number, cap: number) => string;
  tabsLabel: string;
  tabFarm: string;
  tabJobs: string;
  tabMarket: string;
  tabInventory: string;
  tabStore: string;
  tabUpgrades: string;
  lockedLevel: (n: number) => string;
  lockedLater: string;
  lockedSection: string;
  sectionLockedBody: string;
  loading: string;
  retry: string;
  close: string;
  cancel: string;
  confirm: string;
  save: string;
  gotIt: string;
  estimate: string;
  busy: string;

  // room
  roomLabel: string;
  roomDesc: (printers: number, slots: number) => string;
  emptySlot: string;
  addPrinter: string;
  slotN: (n: number) => string;
  openPrinter: (name: string) => string;
  shelf: string;
  spoolsOnShelf: (n: number) => string;
  workTable: string;

  // printer states and cards
  stateIdle: string;
  statePrinting: string;
  stateDone: string;
  stateMaintenance: string;
  stateBroken: string;
  health: string;
  healthPct: (n: number) => string;
  maintenanceRecommended: string;
  nextInQueue: string;
  queueEmpty: string;
  timeLeft: (t: string) => string;
  readyToCollect: string;
  awaitingRepair: string;
  underMaintenance: string;
  progress: string;
  hours: string;
  prints: string;
  failures: string;
  machines: string;
  noPrinters: string;
  queued: (n: number) => string;

  // actions
  collect: string;
  maintain: string;
  repair: string;
  assignWork: string;
  rename: string;
  sell: string;
  start: string;
  accept: string;
  reject: string;
  cancelJob: string;
  assign: string;
  buy: string;
  loadMore: string;
  moveUp: string;
  moveDown: string;
  viewLedger: string;
  enterFarm: string;
  takeFirstJob: string;
  keepJob: string;
  details: string;

  // first-time intro
  introLine1: string;
  introLine2: string;
  introLine3: string;

  // jobs
  offers: string;
  activeJobs: string;
  noOffers: string;
  noOffersDesc: string;
  noActive: string;
  noActiveDesc: string;
  urgencyUrgent: string;
  urgencyTight: string;
  urgencyRelaxed: string;
  tierIndividual: string;
  tierSmallBusiness: string;
  tierMerchant: string;
  tierCompany: string;
  tierIndustrial: string;
  qtyProduct: (qty: number, product: string) => string;
  grams: (g: number) => string;
  printTime: string;
  realTime: (t: string) => string;
  reward: string;
  reputationGain: (stars: string) => string;
  latePenalty: (stars: string) => string;
  cancelPenaltyBp: (stars: string) => string;
  cancelPenaltyCoins: (coins: string) => string;
  offerExpiresIn: (t: string) => string;
  offerExpired: string;
  deadlineIn: (t: string) => string;
  deadlinePassed: string;
  deadline: string;
  assignedOf: (assigned: number, qty: number) => string;
  unassigned: (n: number) => string;
  jobAccepted: string;
  jobPrinting: string;
  jobReady: string;
  jobDelivered: string;
  jobLate: string;
  jobCancelled: string;
  printingOn: (n: number) => string;
  cancelJobTitle: string;
  cancelJobBody: string;
  colors: string;

  // job sheet
  assignTitle: string;
  assignIntro: string;
  printersLabel: string;
  spoolLabel: string;
  chooseSpool: string;
  noCompatibleSpool: string;
  gramsNeeded: (g: number) => string;
  gramsLeft: (g: number) => string;
  insufficientGrams: string;
  qualityLabel: string;
  qualityDraft: string;
  qualityStandard: string;
  qualityFine: string;
  qualityUltra: string;
  estPrintTime: string;
  estFinish: string;
  riskOnTime: string;
  riskTight: string;
  riskLate: string;
  incompatibleMaterial: string;
  incompatibleMulticolor: string;
  incompatibleTooLarge: string;
  unavailableBroken: string;
  unavailableMaintenance: string;
  unknownModel: string;
  queueWait: (t: string) => string;
  partialNote: (n: number) => string;
  allocated: (n: number, qty: number) => string;
  tooMany: string;
  parts: (n: number) => string;

  // printer sheet
  currentPrint: string;
  queueTitle: string;
  maintainCost: (coins: string, minutes: number) => string;
  repairCost: (coins: string, minutes: number) => string;
  notEnoughCoins: string;
  onlyWhenIdle: string;
  maintenanceLocked: (level: number) => string;
  sellTitle: string;
  sellBody: (name: string, coins: string) => string;
  /** The confirmation when the server sent no `resale_coins` — no figure is invented. */
  sellBodyNoQuote: (name: string) => string;
  sellOnlyIdle: string;
  renameLabel: string;
  renamePlaceholder: string;
  nicknameSaved: string;

  // market
  market: string;
  filament: string;
  materialLabel: string;
  colorLabel: string;
  sizeLabel: string;
  spoolSize: (g: number) => string;
  pricePerGram: (coins: string) => string;
  price: string;
  storageLeft: (g: number, total: number) => string;
  storageFull: string;
  noFreeSlot: string;
  catalog: string;
  specSpeed: string;
  specVolume: string;
  specMaterials: string;
  specAms: string;
  yes: string;
  no: string;
  specReliability: string;
  specPower: string;
  family: (f: string) => string;
  buyPrinterTitle: string;
  buyPrinterBody: (name: string, coins: string) => string;
  buyFilamentTitle: string;
  buyFilamentBody: (material: string, color: string, grams: number, coins: string) => string;
  materialLocked: (level: number) => string;
  owned: (n: number) => string;

  // inventory
  inventory: string;
  spools: string;
  noSpools: string;
  noSpoolsDesc: string;
  spoolQuality: (q: number) => string;
  ledger: string;
  noLedger: string;
  balanceAfter: (coins: string) => string;
  ledgerKinds: Record<string, string>;
  printersOwned: string;

  // away sheet
  awayTitle: string;
  awayIntro: string;
  awaySince: (t: string) => string;
  awayFinished: (n: number) => string;
  awayFailed: (n: number) => string;
  awayLate: (n: number) => string;
  awayCancelled: (n: number) => string;
  awayMaintenance: (n: number) => string;
  awayLevelUp: (n: number) => string;
  awayCoins: string;
  awayOther: (n: number) => string;

  // failures
  batchFailed: (kind: string) => string;
  failureKinds: Record<string, string>;
  activeOfMax: (n: number, max: number) => string;

  // the collect result (§4 collect, §9a deferred payout) — coins and stars arrive formatted
  /** Badge on a job whose parts were handed over but whose coins wait for a later day. */
  payoutPending: string;
  payoutPendingBody: string;
  collectReplayed: string;
  collectPartsOnly: (qty: number) => string;
  collectFailed: (qty: number, kind: string) => string;
  collectPaid: (coins: string, stars: string) => string;
  collectPaidLate: (coins: string, stars: string) => string;
  collectLevelUp: (level: number) => string;
  collectDeferred: (coins: string, cap: string) => string;
  capJobs: string;
  capCoins: string;

  // errors (SCREAMING_SNAKE codes from the server)
  errGeneric: string;
  errors: Record<string, string>;

  // hub
  hubTitle: string;
  hubKicker: string;
  hubDesc: string;
  hubGuestTitle: string;
  hubGuestDesc: string;
  hubYourFarm: string;
  hubLeaderboards: string;
  hubLeaderboardsDesc: string;
  hubProfile: string;
  hubProfileDesc: string;
  hubRedeem: string;
  hubRedeemDesc: string;

  /**
   * SHELVED — «قريبا — تحت التطوير».
   *
   * The owner asked for the farm to be marked coming-soon and for its page not
   * to be shown to customers while it is being built. The hub keeps LISTING the
   * game and wears these words; a card that vanished would read as cancelled.
   * The server's switch decides when they are shown (worker/routes/farm.ts),
   * so nothing here is a claim the client made up.
   *
   * Nested on purpose: one block, one meaning, and it stays together when the
   * Sorani below is replaced by the owner's own wording.
   */
  shelved: {
    /** The card's chip: the one word the owner wrote. */
    badge: string;
    title: string;
    body: string;
    /** Under a hub row that leads into the shelved game. */
    linkNote: string;
    /** Under a hub row when the game's status COULD NOT BE READ. Not the same
     *  fact as «قريبا» and must never be written as if it were. */
    linkUnknown: string;
    /** An admin's card says who it is closed to, and where the switch lives. */
    adminBadge: string;
    adminBody: string;
  };

  // leaderboards
  lbTitle: string;
  lbBoardReputation: string;
  lbBoardFarmValue: string;
  lbBoardJobs: string;
  lbBoardsLabel: string;
  lbEmptyTitle: string;
  lbEmptyDesc: string;
  lbYou: string;
  lbRank: (n: number) => string;
  lbJobs: (n: number) => string;

  // farm profile page
  profTitle: string;
  profStats: string;
  profDelivered: string;
  profLate: string;
  profCancelled: string;
  profPrints: string;
  profFailures: string;
  profStreak: string;
  profLifetime: string;
  profLocation: string;
  notSent: string;

  // redeem page
  redeemTitle: string;
  redeemIntro: string;
  redeemClosedTitle: string;
  redeemClosedBody: string;
  redeemRulesTitle: string;
  redeemRuleRate: (n: number) => string;
  redeemRuleDaily: (n: number) => string;
  redeemRuleWeekly: (n: number) => string;
  redeemRuleLevel: (n: number) => string;
  redeemRuleRep: (stars: string) => string;
  redeemNoRules: string;
  redeemGuest: string;
  redeemNoButton: string;
}

const ERRORS_AR: Record<string, string> = {
  OFFER_EXPIRED: 'انتهت صلاحية هذا العرض.',
  PRINTER_INCOMPATIBLE_MATERIAL: 'هذه الطابعة لا تطبع هذه الخامة.',
  PRINTER_NO_MULTICOLOR: 'هذه الطابعة لا تدعم الطباعة متعددة الألوان.',
  PART_TOO_LARGE: 'القطعة أكبر من حجم طباعة هذه الطابعة.',
  SPOOL_MISMATCH: 'البكرة لا تطابق خامة الطلب أو لونه.',
  SPOOL_INSUFFICIENT: 'الغرامات المتبقية في البكرة لا تكفي.',
  PRINTER_UNAVAILABLE: 'الطابعة غير متاحة الآن.',
  QTY_MISMATCH: 'مجموع الكميات لا يطابق كمية الطلب.',
  FARM_INSUFFICIENT_COINS: 'عملات المزرعة لا تكفي.',
  NO_FREE_SLOT: 'لا توجد فتحة فارغة في الغرفة.',
  LEVEL_REQUIRED: 'مستواك لا يسمح بذلك بعد.',
  STORAGE_FULL: 'سعة التخزين لا تكفي لهذه البكرة.',
  MAX_ACTIVE_JOBS: 'بلغت الحد الأقصى من الطلبات النشطة.',
  INVALID_STATE: 'هذا الإجراء غير ممكن في الحالة الحالية.',
  NOT_FOUND: 'العنصر غير موجود.',
  RATE_LIMITED: 'طلبات كثيرة — انتظر قليلًا ثم أعد المحاولة.',
  INSUFFICIENT_COINS: 'عملات المزرعة لا تكفي.',
  TOO_MANY_ACTIVE_JOBS: 'بلغت الحد الأقصى من الطلبات النشطة — سلّم أحدها أولًا.',
  LEVEL_TOO_LOW: 'مستواك لا يسمح بذلك بعد.',
  JOB_NOT_OFFERED: 'هذا العرض لم يعد متاحًا.',
  JOB_NOT_ACTIVE: 'هذا الطلب لم يعد جاريًا.',
  PRODUCT_UNKNOWN: 'هذا المنتج لم يعد في الكتالوج.',
  QUEUE_MISMATCH: 'تغيّر الطابور — أُعيدت قراءته.',
  NOTHING_TO_COLLECT: 'لا توجد دفعة منتهية على هذه الطابعة.',
  PRINT_NOT_FINISHED: 'الطباعة لم تنتهِ بعد.',
  DAILY_CAP_REACHED: 'وصلت إلى الحد اليومي — عد غدًا.',
  PRINTER_BROKEN: 'الطابعة معطّلة — أصلحها أولًا.',
  PRINTER_BUSY: 'الطابعة مشغولة الآن.',
  PRINTER_NOT_BROKEN: 'الطابعة ليست معطّلة.',
  MATERIAL_UNKNOWN: 'خامة غير معروفة.',
  COLOR_UNKNOWN: 'هذا اللون غير متاح لهذه الخامة.',
  SPOOL_SIZE_UNKNOWN: 'حجم بكرة غير متاح.',
  MODEL_UNKNOWN: 'طراز غير معروف.',
  CONFLICT_RETRY: 'تغيّرت الحالة في الأثناء — أُعيدت قراءتها، حاول مرة أخرى.',
  STATE_CHANGED: 'تغيّرت مزرعتك في الأثناء — حاول مرة أخرى.',
  FEATURE_LOCKED: 'هذه الميزة غير مفتوحة لمزرعتك بعد.',
  LAST_PRINTER: 'لا يمكن بيع آخر طابعة: ثمنها مع رصيدك لا يكفي لشراء طابعة أخرى.',
  IDEMPOTENCY_KEY_REUSED: 'تعارض في الطلب — أُعيدت قراءة الحالة، حاول مرة أخرى.',
  FARM_SHELVED: 'لعبة المزرعة تحت التطوير ولم تُفتح بعد — قريبا.',
};

const ERRORS_EN: Record<string, string> = {
  OFFER_EXPIRED: 'This offer has expired.',
  PRINTER_INCOMPATIBLE_MATERIAL: 'This printer cannot print this material.',
  PRINTER_NO_MULTICOLOR: 'This printer has no multi-colour capability.',
  PART_TOO_LARGE: 'The part does not fit this printer\'s build volume.',
  SPOOL_MISMATCH: 'That spool does not match the job\'s material or colour.',
  SPOOL_INSUFFICIENT: 'The spool does not have enough grams left.',
  PRINTER_UNAVAILABLE: 'That printer is not available right now.',
  QTY_MISMATCH: 'The quantities do not add up to the job quantity.',
  FARM_INSUFFICIENT_COINS: 'Not enough Farm Coins.',
  NO_FREE_SLOT: 'There is no free slot in the room.',
  LEVEL_REQUIRED: 'Your level is not high enough yet.',
  STORAGE_FULL: 'Not enough storage for that spool.',
  MAX_ACTIVE_JOBS: 'You have reached the maximum of active jobs.',
  INVALID_STATE: 'That action is not possible in the current state.',
  NOT_FOUND: 'That item no longer exists.',
  RATE_LIMITED: 'Too many requests — wait a moment and try again.',
  INSUFFICIENT_COINS: 'Not enough Farm Coins.',
  TOO_MANY_ACTIVE_JOBS: 'You already hold the maximum of active jobs — deliver one first.',
  LEVEL_TOO_LOW: 'Your level is not high enough yet.',
  JOB_NOT_OFFERED: 'This offer is no longer available.',
  JOB_NOT_ACTIVE: 'This job is no longer active.',
  PRODUCT_UNKNOWN: 'This product is no longer in the catalog.',
  QUEUE_MISMATCH: 'The queue changed — it has been re-read.',
  NOTHING_TO_COLLECT: 'Nothing to collect on this printer.',
  PRINT_NOT_FINISHED: 'The print has not finished yet.',
  DAILY_CAP_REACHED: 'You reached today\'s limit — come back tomorrow.',
  PRINTER_BROKEN: 'The printer is broken — repair it first.',
  PRINTER_BUSY: 'The printer is busy right now.',
  PRINTER_NOT_BROKEN: 'The printer is not broken.',
  MATERIAL_UNKNOWN: 'Unknown material.',
  COLOR_UNKNOWN: 'That colour is not available for this material.',
  SPOOL_SIZE_UNKNOWN: 'That spool size is not sold.',
  MODEL_UNKNOWN: 'Unknown printer model.',
  CONFLICT_RETRY: 'The state changed meanwhile — it has been re-read, please try again.',
  STATE_CHANGED: 'Your farm changed, please try again.',
  FEATURE_LOCKED: 'This feature is not unlocked for your farm yet.',
  LAST_PRINTER: 'Your last printer cannot be sold: its price plus your balance would not buy another one.',
  IDEMPOTENCY_KEY_REUSED: 'Request conflict — the state has been re-read, please try again.',
  FARM_SHELVED: 'The printer farm is under development and is not open yet.',
};

const ERRORS_CKB: Record<string, string> = {
  OFFER_EXPIRED: 'ماوەی ئەم پێشنیارە بەسەرچووە.',
  PRINTER_INCOMPATIBLE_MATERIAL: 'ئەم چاپکەرە ئەم کەرەستەیە چاپ ناکات.',
  PRINTER_NO_MULTICOLOR: 'ئەم چاپکەرە چاپی فرەڕەنگ ناکات.',
  PART_TOO_LARGE: 'پارچەکە لە قەبارەی چاپکردنی ئەم چاپکەرە گەورەترە.',
  SPOOL_MISMATCH: 'ئەم بۆبینە لەگەڵ کەرەستە یان ڕەنگی کارەکە ناگونجێت.',
  SPOOL_INSUFFICIENT: 'گرامی ماوە لە بۆبینەکە بەش ناکات.',
  PRINTER_UNAVAILABLE: 'ئەم چاپکەرە ئێستا بەردەست نییە.',
  QTY_MISMATCH: 'کۆی بڕەکان لەگەڵ بڕی کارەکە یەک ناگرێتەوە.',
  FARM_INSUFFICIENT_COINS: 'دراوی کێڵگە بەش ناکات.',
  NO_FREE_SLOT: 'شوێنی بەتاڵ لە ژوورەکە نییە.',
  LEVEL_REQUIRED: 'ئاستەکەت هێشتا ڕێگە بەمە نادات.',
  STORAGE_FULL: 'شوێنی هەڵگرتن بۆ ئەم بۆبینە بەش ناکات.',
  MAX_ACTIVE_JOBS: 'گەیشتیتە زۆرترین ژمارەی کاری چالاک.',
  INVALID_STATE: 'ئەم کردارە لەم دۆخەدا ناکرێت.',
  NOT_FOUND: 'ئەم شتە بوونی نییە.',
  RATE_LIMITED: 'داواکاری زۆر — کەمێک چاوەڕێ بکە و دووبارە هەوڵ بدەوە.',
  INSUFFICIENT_COINS: 'دراوی کێڵگە بەش ناکات.',
  TOO_MANY_ACTIVE_JOBS: 'گەیشتیتە زۆرترین ژمارەی کاری چالاک — یەکێکیان بگەیەنە.',
  LEVEL_TOO_LOW: 'ئاستەکەت هێشتا ڕێگە بەمە نادات.',
  JOB_NOT_OFFERED: 'ئەم پێشنیارە چیتر بەردەست نییە.',
  JOB_NOT_ACTIVE: 'ئەم کارە چیتر چالاک نییە.',
  PRODUCT_UNKNOWN: 'ئەم بەرهەمە چیتر لە کاتالۆگ نییە.',
  QUEUE_MISMATCH: 'ڕیزەکە گۆڕا — دووبارە خوێندرایەوە.',
  NOTHING_TO_COLLECT: 'هیچ کۆمەڵەیەکی تەواوبوو لەسەر ئەم چاپکەرە نییە.',
  PRINT_NOT_FINISHED: 'چاپەکە هێشتا تەواو نەبووە.',
  DAILY_CAP_REACHED: 'گەیشتیتە سنووری ئەمڕۆ — سبەینێ بگەڕێوە.',
  PRINTER_BROKEN: 'چاپکەر تێکچووە — سەرەتا چاکی بکەرەوە.',
  PRINTER_BUSY: 'چاپکەر ئێستا سەرقاڵە.',
  PRINTER_NOT_BROKEN: 'چاپکەر تێکنەچووە.',
  MATERIAL_UNKNOWN: 'کەرەستەی نەناسراو.',
  COLOR_UNKNOWN: 'ئەم ڕەنگە بۆ ئەم کەرەستەیە بەردەست نییە.',
  SPOOL_SIZE_UNKNOWN: 'ئەم قەبارەی بۆبینە نافرۆشرێت.',
  MODEL_UNKNOWN: 'مۆدێلی چاپکەری نەناسراو.',
  CONFLICT_RETRY: 'دۆخەکە لەو ماوەدا گۆڕا — دووبارە خوێندرایەوە، هەوڵ بدەوە.',
  STATE_CHANGED: 'کێڵگەکەت لەو ماوەدا گۆڕا — دووبارە هەوڵ بدەوە.',
  FEATURE_LOCKED: 'ئەم تایبەتمەندییە هێشتا بۆ کێڵگەکەت نەکراوەتەوە.',
  LAST_PRINTER: 'دوایین چاپکەر نافرۆشرێت: نرخەکەی لەگەڵ باڵانسەکەت بەشی کڕینی چاپکەرێکی دیکە ناکات.',
  IDEMPOTENCY_KEY_REUSED: 'ناکۆکی داواکاری — دۆخەکە دووبارە خوێندرایەوە، هەوڵ بدەوە.',
  // Arabic: the Sorani for this sentence is the owner's to write by hand.
  FARM_SHELVED: 'لعبة المزرعة تحت التطوير ولم تُفتح بعد — قريبا.',
};

const LEDGER_AR: Record<string, string> = {
  starter: 'رأس المال الابتدائي',
  job_payout: 'دفعة طلب',
  filament_purchase: 'شراء فيلامنت',
  printer_purchase: 'شراء طابعة',
  printer_sale: 'بيع طابعة',
  maintenance: 'صيانة',
  repair: 'إصلاح',
  electricity: 'كهرباء',
  cancel_penalty: 'غرامة إلغاء',
  penalty: 'غرامة',
  refund: 'استرداد',
  admin_grant: 'منحة إدارية',
  admin_adjust: 'تسوية إدارية',
};

const LEDGER_EN: Record<string, string> = {
  starter: 'Starting capital',
  job_payout: 'Job payout',
  filament_purchase: 'Filament purchase',
  printer_purchase: 'Printer purchase',
  printer_sale: 'Printer sale',
  maintenance: 'Maintenance',
  repair: 'Repair',
  electricity: 'Electricity',
  cancel_penalty: 'Cancellation penalty',
  penalty: 'Penalty',
  refund: 'Refund',
  admin_grant: 'Admin grant',
  admin_adjust: 'Admin adjustment',
};

const LEDGER_CKB: Record<string, string> = {
  starter: 'سەرمایەی سەرەتایی',
  job_payout: 'پارەی کار',
  filament_purchase: 'کڕینی فیلامێنت',
  printer_purchase: 'کڕینی چاپکەر',
  printer_sale: 'فرۆشتنی چاپکەر',
  maintenance: 'چاککردن',
  repair: 'چاککردنەوە',
  electricity: 'کارەبا',
  cancel_penalty: 'سزای هەڵوەشاندنەوە',
  penalty: 'سزا',
  refund: 'گەڕاندنەوە',
  admin_grant: 'بەخشینی بەڕێوەبەر',
  admin_adjust: 'ڕێکخستنی بەڕێوەبەر',
};

const FAILURES_AR: Record<string, string> = {
  spaghetti: 'سباغيتي (انفصال الطبقات)',
  clog: 'انسداد الفوهة',
  first_layer: 'فشل الطبقة الأولى',
  runout: 'نفاد الفيلامنت',
  ams_jam: 'انحشار في نظام الألوان',
  detach: 'انفصال القطعة عن السطح',
  mechanical: 'عطل ميكانيكي',
};
const FAILURES_EN: Record<string, string> = {
  spaghetti: 'Spaghetti (layers came apart)',
  clog: 'Nozzle clog',
  first_layer: 'First layer failed',
  runout: 'Filament ran out',
  ams_jam: 'AMS jam',
  detach: 'Part detached from the bed',
  mechanical: 'Mechanical fault',
};
const FAILURES_CKB: Record<string, string> = {
  spaghetti: 'سپاگێتی (چینەکان جیابوونەوە)',
  clog: 'گیرانی نۆزڵ',
  first_layer: 'چینی یەکەم شکستی هێنا',
  runout: 'فیلامێنت تەواو بوو',
  ams_jam: 'گیرانی AMS',
  detach: 'پارچە لە سەر تەختە هەڵبوو',
  mechanical: 'کێشەی میکانیکی',
};

const ar: FarmStrings = {
  title: 'مزرعة الطباعة',
  back: 'رجوع',
  coins: 'عملات المزرعة',
  coinsUnit: 'عملة',
  level: (n) => `المستوى ${n}`,
  xpProgress: (xp, next) => `${xp} / ${next} نقطة خبرة`,
  reputation: 'السمعة',
  starsLabel: (stars) => `${stars} من 5 نجوم`,
  recovery: 'وضع التعافي',
  todayJobs: (jobs, cap) => `اليوم: ${jobs} من ${cap} طلبات`,
  tabsLabel: 'أقسام المزرعة',
  tabFarm: 'المزرعة',
  tabJobs: 'الطلبات',
  tabMarket: 'السوق',
  tabInventory: 'المخزون',
  tabStore: 'المتجر',
  tabUpgrades: 'الترقيات',
  lockedLevel: (n) => `يُفتح عند المستوى ${n}`,
  lockedLater: 'ليس ضمن هذه المرحلة',
  lockedSection: 'قسم مقفل',
  sectionLockedBody: 'الخادم لم يفتح هذا القسم لمزرعتك بعد.',
  loading: 'جارٍ تحميل المزرعة…',
  retry: 'إعادة المحاولة',
  close: 'إغلاق',
  cancel: 'إلغاء',
  confirm: 'تأكيد',
  save: 'حفظ',
  gotIt: 'فهمت',
  estimate: 'تقديري',
  busy: 'جارٍ التنفيذ…',

  roomLabel: 'غرفة الطباعة',
  roomDesc: (printers, slots) => `${printers} من ${slots} فتحات مشغولة`,
  emptySlot: 'فتحة فارغة',
  addPrinter: 'أضف طابعة',
  slotN: (n) => `الفتحة ${n}`,
  openPrinter: (name) => `افتح الطابعة ${name}`,
  shelf: 'رف الفيلامنت',
  spoolsOnShelf: (n) => `${n} بكرات على الرف`,
  workTable: 'طاولة العمل',

  stateIdle: 'متوقفة',
  statePrinting: 'تطبع',
  stateDone: 'جاهزة للاستلام',
  stateMaintenance: 'في الصيانة',
  stateBroken: 'معطّلة',
  health: 'الحالة الفنية',
  healthPct: (n) => `الحالة ${n}%`,
  maintenanceRecommended: 'يُستحسن إجراء صيانة',
  nextInQueue: 'التالي في الطابور',
  queueEmpty: 'الطابور فارغ',
  timeLeft: (t) => `${t} متبقية`,
  readyToCollect: 'الطبعة جاهزة للاستلام',
  awaitingRepair: 'بحاجة إلى إصلاح',
  underMaintenance: 'الصيانة جارية',
  progress: 'التقدم',
  hours: 'ساعات التشغيل',
  prints: 'طبعات',
  failures: 'إخفاقات',
  machines: 'الآلات',
  noPrinters: 'لا توجد طابعات في الغرفة.',
  queued: (n) => (n === 1 ? 'دفعة واحدة في الطابور' : n === 2 ? 'دفعتان في الطابور' : `${n} دفعات في الطابور`),

  collect: 'استلام',
  maintain: 'صيانة',
  repair: 'إصلاح',
  assignWork: 'تعيين عمل',
  rename: 'إعادة التسمية',
  sell: 'بيع',
  start: 'ابدأ الطباعة',
  accept: 'قبول',
  reject: 'رفض',
  cancelJob: 'إلغاء الطلب',
  assign: 'تعيين',
  buy: 'شراء',
  loadMore: 'عرض المزيد',
  moveUp: 'تقديم في الطابور',
  moveDown: 'تأخير في الطابور',
  viewLedger: 'دفتر العملات',
  enterFarm: 'ادخل المزرعة',
  takeFirstJob: 'خذ أول طلب لك',
  keepJob: 'إبقاء الطلب',
  details: 'التفاصيل',

  introLine1: 'لديك طابعة A1 mini واحدة وبكرة PLA وغرفة صغيرة.',
  introLine2: 'اقبل طلبًا من عميل، وزّعه على الطابعة، واستلم القطع قبل الموعد.',
  introLine3: 'كل تسليم يجلب عملات وسمعة — ومنهما تنمو المزرعة.',

  offers: 'عروض العملاء',
  activeJobs: 'الطلبات الجارية',
  noOffers: 'لا عروض حاليًا',
  noOffersDesc: 'يُرسل العملاء عروضًا جديدة على فترات — تفقّد لاحقًا.',
  noActive: 'لا طلبات جارية',
  noActiveDesc: 'اقبل عرضًا لتبدأ الطباعة.',
  urgencyUrgent: 'عاجل',
  urgencyTight: 'وقت ضيّق',
  urgencyRelaxed: 'وقت مريح',
  tierIndividual: 'فرد',
  tierSmallBusiness: 'عمل صغير',
  tierMerchant: 'تاجر',
  tierCompany: 'شركة',
  tierIndustrial: 'صناعي',
  qtyProduct: (qty, product) => `${qty} × ${product}`,
  grams: (g) => `${g} غ`,
  printTime: 'وقت الطباعة',
  realTime: (t) => `≈ ${t} فعليًا`,
  reward: 'المكافأة',
  reputationGain: (stars) => `+${stars}★ سمعة`,
  latePenalty: (stars) => `−${stars}★ عند التأخير`,
  cancelPenaltyBp: (stars) => `−${stars}★ عند الإلغاء`,
  cancelPenaltyCoins: (coins) => `−${coins} عملة عند الإلغاء`,
  offerExpiresIn: (t) => `ينتهي العرض خلال ${t}`,
  offerExpired: 'انتهى العرض',
  deadlineIn: (t) => `الموعد خلال ${t}`,
  deadlinePassed: 'تجاوز الموعد',
  deadline: 'الموعد النهائي',
  assignedOf: (assigned, qty) => `${assigned} / ${qty} معيّنة`,
  unassigned: (n) => (n === 1 ? 'قطعة واحدة بلا تعيين' : n === 2 ? 'قطعتان بلا تعيين' : `${n} قطع بلا تعيين`),
  jobAccepted: 'مقبول',
  jobPrinting: 'قيد الطباعة',
  jobReady: 'جاهز للتسليم',
  jobDelivered: 'تم التسليم',
  jobLate: 'متأخر',
  jobCancelled: 'ملغى',
  printingOn: (n) => (n === 1 ? 'على طابعة واحدة' : n === 2 ? 'على طابعتين' : `على ${n} طابعات`),
  cancelJobTitle: 'إلغاء هذا الطلب؟',
  cancelJobBody: 'تُطبَّق غرامة الإلغاء المذكورة على البطاقة، وتُرجَع الغرامات المحجوزة للدفعات التي لم تبدأ.',
  colors: 'الألوان',

  assignTitle: 'توزيع العمل',
  assignIntro: 'اختر الطابعات، وبكرة لكل واحدة، وكمية القطع لكل طابعة.',
  printersLabel: 'الطابعات',
  spoolLabel: 'البكرة',
  chooseSpool: 'اختر بكرة',
  noCompatibleSpool: 'لا بكرة مطابقة — اشترِ فيلامنت من السوق.',
  gramsNeeded: (g) => `يحتاج ${g} غ`,
  gramsLeft: (g) => `متبقٍ ${g} غ`,
  insufficientGrams: 'الغرامات لا تكفي',
  qualityLabel: 'الجودة',
  qualityDraft: 'مسودة',
  qualityStandard: 'قياسية',
  qualityFine: 'دقيقة',
  qualityUltra: 'فائقة',
  estPrintTime: 'وقت الطباعة التقديري',
  estFinish: 'الانتهاء التقديري',
  riskOnTime: 'في الوقت',
  riskTight: 'على الحد',
  riskLate: 'سيتأخر',
  incompatibleMaterial: 'لا تدعم الخامة',
  incompatibleMulticolor: 'بلا نظام ألوان متعدد',
  incompatibleTooLarge: 'القطعة أكبر من حجم الطباعة',
  unavailableBroken: 'معطّلة',
  unavailableMaintenance: 'في الصيانة',
  unknownModel: 'طراز غير معروف',
  queueWait: (t) => `انتظار الطابور ${t}`,
  partialNote: (n) => (n === 1 ? 'تبقى قطعة واحدة بلا تعيين — يمكنك تعيينها لاحقًا.' : `تبقى ${n} قطع بلا تعيين — يمكنك تعيينها لاحقًا.`),
  allocated: (n, qty) => `${n} من ${qty} قطعة موزّعة`,
  tooMany: 'الكمية الموزّعة تتجاوز المطلوب.',
  parts: (n) => (n === 1 ? 'قطعة واحدة' : n === 2 ? 'قطعتان' : n <= 10 ? `${n} قطع` : `${n} قطعة`),

  currentPrint: 'الطبعة الحالية',
  queueTitle: 'الطابور',
  maintainCost: (coins, minutes) => `${coins} عملة · ${minutes} دقيقة`,
  repairCost: (coins, minutes) => `${coins} عملة · ${minutes} دقيقة`,
  notEnoughCoins: 'عملات المزرعة لا تكفي',
  onlyWhenIdle: 'متاح حين تكون الطابعة متوقفة أو جاهزة',
  maintenanceLocked: (level) => `تُفتح الصيانة عند المستوى ${level}`,
  sellTitle: 'بيع الطابعة؟',
  sellBody: (name, coins) => `سيُباع ${name} مقابل ${coins} عملة. لا يمكن التراجع.`,
  sellBodyNoQuote: (name) => `سيُباع ${name} بسعر إعادة البيع الذي يحدّده الخادم عند التنفيذ. لا يمكن التراجع.`,
  sellOnlyIdle: 'يمكن بيع الطابعات المتوقفة فقط',
  renameLabel: 'اسم الطابعة',
  renamePlaceholder: 'مثال: الخط الأول',
  nicknameSaved: 'تم حفظ الاسم.',

  market: 'السوق',
  filament: 'الفيلامنت',
  materialLabel: 'الخامة',
  colorLabel: 'اللون',
  sizeLabel: 'حجم البكرة',
  spoolSize: (g) => `${g} غ`,
  pricePerGram: (coins) => `${coins} عملة / غ`,
  price: 'السعر',
  storageLeft: (g, total) => `التخزين: ${g} غ متاحة من ${total} غ`,
  storageFull: 'التخزين لا يتسع لهذه البكرة',
  noFreeSlot: 'لا فتحة فارغة في الغرفة',
  catalog: 'كتالوج الطابعات',
  specSpeed: 'السرعة',
  specVolume: 'حجم الطباعة',
  specMaterials: 'الخامات',
  specAms: 'ألوان متعددة',
  yes: 'نعم',
  no: 'لا',
  specReliability: 'الموثوقية',
  specPower: 'الاستهلاك',
  family: (f) => `سلسلة ${f}`,
  buyPrinterTitle: 'شراء طابعة',
  buyPrinterBody: (name, coins) => `شراء ${name} مقابل ${coins} عملة؟ ستُوضع في أول فتحة فارغة.`,
  buyFilamentTitle: 'شراء فيلامنت',
  buyFilamentBody: (material, color, grams, coins) => `شراء بكرة ${material} ${color} بوزن ${grams} غ مقابل ${coins} عملة؟`,
  materialLocked: (level) => `تُفتح عند المستوى ${level}`,
  owned: (n) => (n === 1 ? 'تملك واحدة' : n === 2 ? 'تملك اثنتين' : `تملك ${n}`),

  inventory: 'المخزون',
  spools: 'البكرات',
  noSpools: 'لا بكرات',
  noSpoolsDesc: 'اشترِ فيلامنت من السوق لتبدأ الطباعة.',
  spoolQuality: (q) => `جودة ${q}`,
  ledger: 'دفتر العملات',
  noLedger: 'لا حركات بعد.',
  balanceAfter: (coins) => `الرصيد بعدها ${coins}`,
  ledgerKinds: LEDGER_AR,
  printersOwned: 'الطابعات',

  awayTitle: 'بينما كنت بعيدًا',
  awayIntro: 'هذا ما حدث في مزرعتك منذ آخر زيارة.',
  awaySince: (t) => `غبت ${t}`,
  awayFinished: (n) => (n === 1 ? 'طبعة واحدة اكتملت وجاهزة للاستلام' : n === 2 ? 'طبعتان اكتملتا وجاهزتان للاستلام' : `${n} طبعات اكتملت وجاهزة للاستلام`),
  awayFailed: (n) => (n === 1 ? 'طبعة واحدة أخفقت' : n === 2 ? 'طبعتان أخفقتا' : `${n} طبعات أخفقت`),
  awayLate: (n) => (n === 1 ? 'طلب واحد تجاوز موعده' : n === 2 ? 'طلبان تجاوزا موعدهما' : `${n} طلبات تجاوزت موعدها`),
  awayCancelled: (n) => (n === 1 ? 'طلب واحد ألغاه العميل أو انتهى عرضه' : n === 2 ? 'طلبان ألغاهما العميل أو انتهى عرضهما' : `${n} طلبات ألغاها العميل أو انتهت عروضها`),
  awayMaintenance: (n) => (n === 1 ? 'صيانة واحدة اكتملت' : n === 2 ? 'صيانتان اكتملتا' : `${n} صيانات اكتملت`),
  awayLevelUp: (n) => (n === 1 ? 'ارتقيت مستوى' : `ارتقيت ${n} مستويات`),
  awayCoins: 'صافي العملات',
  awayOther: (n) => (n === 1 ? 'حدث آخر' : `${n} أحداث أخرى`),

  batchFailed: (kind) => `أخفقت الطبعة: ${kind}`,
  failureKinds: FAILURES_AR,
  activeOfMax: (n, max) => `${n} من ${max} طلبات نشطة`,

  payoutPending: 'الدفع مؤجَّل',
  payoutPendingBody: 'سُلِّمت القطع للعميل، والعملات تصل في اليوم التالي ضمن الحد اليومي.',
  collectReplayed: 'جُمعت هذه الدفعة من قبل — لم يُدفع شيء إضافي.',
  collectPartsOnly: (qty) => `استُلمت ${qty === 1 ? 'قطعة واحدة' : qty === 2 ? 'قطعتان' : qty <= 10 ? `${qty} قطع` : `${qty} قطعة`}. يُدفع الطلب عند تسليم كل قطعه.`,
  collectFailed: (qty, kind) => `أخفقت طبعة ${qty === 1 ? 'قطعة واحدة' : qty === 2 ? 'قطعتين' : qty <= 10 ? `${qty} قطع` : `${qty} قطعة`}: ${kind}. أعد إسناد القطع الناقصة.`,
  collectPaid: (coins, stars) => `تم التسليم: +${coins} عملة، ${stars}★ سمعة`,
  collectPaidLate: (coins, stars) => `تم التسليم متأخرًا: +${coins} عملة، ${stars}★ سمعة`,
  collectLevelUp: (level) => `ارتقيت إلى المستوى ${level}`,
  collectDeferred: (coins, cap) => `سُلِّمت القطع للعميل. دفعة ${coins} عملة تصل غدًا لأن ${cap} قد اكتمل.`,
  capJobs: 'حد الطلبات اليومي',
  capCoins: 'حد العملات اليومي',

  errGeneric: 'تعذّر تنفيذ الإجراء. حاول مرة أخرى.',
  errors: ERRORS_AR,

  hubTitle: 'الألعاب',
  hubKicker: 'محاكي أعمال',
  hubDesc: 'ابدأ بطابعة واحدة وبكرة واحدة. خذ طلبات العملاء، اطبع، سلّم قبل الموعد، وابنِ مزرعة طباعة آلية.',
  hubGuestTitle: 'سجّل الدخول لتدير مزرعتك',
  hubGuestDesc: 'المزرعة تحفظ تقدمك على حسابك — الطابعات والطلبات والعملات كلها على الخادم.',
  hubYourFarm: 'مزرعتك',
  hubLeaderboards: 'لوحات المتصدرين',
  hubLeaderboardsDesc: 'السمعة، قيمة المزرعة، والطلبات المسلَّمة.',
  hubProfile: 'ملف المزرعة',
  hubProfileDesc: 'مستواك وإحصاءاتك وسمعتك.',
  hubRedeem: 'تحويل العملات',
  hubRedeemDesc: 'قواعد تحويل عملات المزرعة إلى نقاط ليفونيس.',

  shelved: {
    badge: 'قريبا',
    title: 'المزرعة تحت التطوير',
    body: 'اللعبة قيد التطوير الآن ولم تُفتح للاعبين بعد. لم يضع أحد شيئًا: كل ما جمعته المزارع محفوظ كما هو، وتعود اللعبة من حيث توقفت عند فتحها.',
    linkNote: 'يفتح مع اللعبة',
    linkUnknown: 'تعذّر معرفة حالة اللعبة',
    adminBadge: 'مغلقة على اللاعبين',
    adminBody: 'أنت تدخلها كمشرف — اللاعبون يرون إشعار «قريبا» فقط. الفتح من لوحة الإدارة ← مزرعة الطابعات.',
  },

  lbTitle: 'لوحات المتصدرين',
  lbBoardReputation: 'السمعة',
  lbBoardFarmValue: 'قيمة المزرعة',
  lbBoardJobs: 'التسليمات',
  lbBoardsLabel: 'اختر اللوحة',
  lbEmptyTitle: 'لم يلعب أحد بعد',
  lbEmptyDesc: 'أول مزرعة تسلّم طلبًا تظهر هنا.',
  lbYou: 'أنت',
  lbRank: (n) => `المركز ${n}`,
  lbJobs: (n) => (n === 1 ? 'طلب واحد' : n === 2 ? 'طلبان' : n <= 10 ? `${n} طلبات` : `${n} طلبًا`),

  profTitle: 'ملف المزرعة',
  profStats: 'الإحصاءات',
  profDelivered: 'طلبات مسلَّمة',
  profLate: 'متأخرة',
  profCancelled: 'ملغاة',
  profPrints: 'طبعات',
  profFailures: 'إخفاقات',
  profStreak: 'سلسلة التسليم',
  profLifetime: 'إجمالي العملات المكتسبة',
  profLocation: 'الموقع',
  notSent: '—',

  redeemTitle: 'تحويل العملات',
  redeemIntro: 'عملات المزرعة عملة داخل اللعبة. نقاط ليفونيس هي عملة المكافآت الحقيقية في المتجر، ولا تُصدَر إلا من الخادم وفق حدود يحدّدها الفريق.',
  redeemClosedTitle: 'التحويل غير مفتوح حاليًا',
  redeemClosedBody: 'الخادم يفيد بأن تحويل عملات المزرعة إلى نقاط ليفونيس غير مُفعَّل. عملاتك تبقى في اللعبة وتُستخدم لتنمية المزرعة.',
  redeemRulesTitle: 'القواعد كما يرسلها الخادم',
  redeemRuleRate: (n) => `${n} عملة مزرعة لكل نقطة ليفونيس`,
  redeemRuleDaily: (n) => `حد يومي: ${n} نقطة`,
  redeemRuleWeekly: (n) => `حد أسبوعي: ${n} نقطة`,
  redeemRuleLevel: (n) => `المستوى المطلوب: ${n}`,
  redeemRuleRep: (stars) => `السمعة المطلوبة: ${stars}★`,
  redeemNoRules: 'لم يرسل الخادم قواعد تحويل.',
  redeemGuest: 'سجّل الدخول لترى حالة التحويل لحسابك.',
  redeemNoButton: 'لا يوجد إجراء تحويل في هذه المرحلة — هذه الصفحة تعرض حالة الخادم فقط.',
};

const en: FarmStrings = {
  title: 'Printer Farm',
  back: 'Back',
  coins: 'Farm Coins',
  coinsUnit: 'coins',
  level: (n) => `Level ${n}`,
  xpProgress: (xp, next) => `${xp} / ${next} XP`,
  reputation: 'Reputation',
  starsLabel: (stars) => `${stars} of 5 stars`,
  recovery: 'Recovery mode',
  todayJobs: (jobs, cap) => `Today: ${jobs} of ${cap} jobs`,
  tabsLabel: 'Farm sections',
  // Tab words stay short (≤ 9 characters) so a 56px tab at 360px never truncates.
  tabFarm: 'Farm',
  tabJobs: 'Jobs',
  tabMarket: 'Market',
  tabInventory: 'Stock',
  tabStore: 'Store',
  tabUpgrades: 'Upgrade',
  lockedLevel: (n) => `Unlocks at level ${n}`,
  lockedLater: 'Not in this phase',
  lockedSection: 'Locked section',
  sectionLockedBody: 'The server has not unlocked this section for your farm yet.',
  loading: 'Loading the farm…',
  retry: 'Retry',
  close: 'Close',
  cancel: 'Cancel',
  confirm: 'Confirm',
  save: 'Save',
  gotIt: 'Got it',
  estimate: 'estimate',
  busy: 'Working…',

  roomLabel: 'Print room',
  roomDesc: (printers, slots) => `${printers} of ${slots} slots in use`,
  emptySlot: 'Empty slot',
  addPrinter: 'Add a printer',
  slotN: (n) => `Slot ${n}`,
  openPrinter: (name) => `Open printer ${name}`,
  shelf: 'Filament shelf',
  spoolsOnShelf: (n) => `${n} spools on the shelf`,
  workTable: 'Work table',

  stateIdle: 'Idle',
  statePrinting: 'Printing',
  stateDone: 'Ready to collect',
  stateMaintenance: 'In maintenance',
  stateBroken: 'Broken',
  health: 'Health',
  healthPct: (n) => `Health ${n}%`,
  maintenanceRecommended: 'Maintenance recommended',
  nextInQueue: 'Next in queue',
  queueEmpty: 'Queue empty',
  timeLeft: (t) => `${t} left`,
  readyToCollect: 'Print ready to collect',
  awaitingRepair: 'Needs repair',
  underMaintenance: 'Maintenance in progress',
  progress: 'Progress',
  hours: 'Hours run',
  prints: 'Prints',
  failures: 'Failures',
  machines: 'Machines',
  noPrinters: 'No printers in the room.',
  queued: (n) => (n === 1 ? '1 batch queued' : `${n} batches queued`),

  collect: 'Collect',
  maintain: 'Maintain',
  repair: 'Repair',
  assignWork: 'Assign work',
  rename: 'Rename',
  sell: 'Sell',
  start: 'Start printing',
  accept: 'Accept',
  reject: 'Reject',
  cancelJob: 'Cancel job',
  assign: 'Assign',
  buy: 'Buy',
  loadMore: 'Load more',
  moveUp: 'Move up the queue',
  moveDown: 'Move down the queue',
  viewLedger: 'Coin ledger',
  enterFarm: 'Enter the farm',
  takeFirstJob: 'Take your first job',
  keepJob: 'Keep the job',
  details: 'Details',

  introLine1: 'You own one A1 mini, one PLA spool and a tiny room.',
  introLine2: 'Accept a customer job, put it on the printer, collect the parts before the deadline.',
  introLine3: 'Every delivery pays coins and reputation — that is how the farm grows.',

  offers: 'Customer offers',
  activeJobs: 'Active jobs',
  noOffers: 'No offers right now',
  noOffersDesc: 'Customers send new offers at intervals — check back soon.',
  noActive: 'No active jobs',
  noActiveDesc: 'Accept an offer to start printing.',
  urgencyUrgent: 'Urgent',
  urgencyTight: 'Tight',
  urgencyRelaxed: 'Relaxed',
  tierIndividual: 'Individual',
  tierSmallBusiness: 'Small business',
  tierMerchant: 'Merchant',
  tierCompany: 'Company',
  tierIndustrial: 'Industrial',
  qtyProduct: (qty, product) => `${qty} × ${product}`,
  grams: (g) => `${g} g`,
  printTime: 'Print time',
  realTime: (t) => `≈ ${t} real`,
  reward: 'Reward',
  reputationGain: (stars) => `+${stars}★ reputation`,
  latePenalty: (stars) => `−${stars}★ if late`,
  cancelPenaltyBp: (stars) => `−${stars}★ if cancelled`,
  cancelPenaltyCoins: (coins) => `−${coins} coins if cancelled`,
  offerExpiresIn: (t) => `Offer ends in ${t}`,
  offerExpired: 'Offer ended',
  deadlineIn: (t) => `Due in ${t}`,
  deadlinePassed: 'Deadline passed',
  deadline: 'Deadline',
  assignedOf: (assigned, qty) => `${assigned} / ${qty} assigned`,
  unassigned: (n) => (n === 1 ? '1 part unassigned' : `${n} parts unassigned`),
  jobAccepted: 'Accepted',
  jobPrinting: 'Printing',
  jobReady: 'Ready to deliver',
  jobDelivered: 'Delivered',
  jobLate: 'Late',
  jobCancelled: 'Cancelled',
  printingOn: (n) => (n === 1 ? 'on 1 printer' : `on ${n} printers`),
  cancelJobTitle: 'Cancel this job?',
  cancelJobBody: 'The cancellation penalty shown on the card applies; reserved grams for batches that have not started are refunded.',
  colors: 'Colours',

  assignTitle: 'Allocate the work',
  assignIntro: 'Pick the printers, a spool for each, and how many parts each one prints.',
  printersLabel: 'Printers',
  spoolLabel: 'Spool',
  chooseSpool: 'Choose a spool',
  noCompatibleSpool: 'No matching spool — buy filament in the market.',
  gramsNeeded: (g) => `needs ${g} g`,
  gramsLeft: (g) => `${g} g left`,
  insufficientGrams: 'Not enough grams',
  qualityLabel: 'Quality',
  qualityDraft: 'Draft',
  qualityStandard: 'Standard',
  qualityFine: 'Fine',
  qualityUltra: 'Ultra',
  estPrintTime: 'Estimated print time',
  estFinish: 'Estimated finish',
  riskOnTime: 'On time',
  riskTight: 'Tight',
  riskLate: 'Will be late',
  incompatibleMaterial: 'Does not print this material',
  incompatibleMulticolor: 'No multi-colour system',
  incompatibleTooLarge: 'Part exceeds the build volume',
  unavailableBroken: 'Broken',
  unavailableMaintenance: 'In maintenance',
  unknownModel: 'Unknown model',
  queueWait: (t) => `queue wait ${t}`,
  partialNote: (n) => (n === 1 ? '1 part stays unassigned — you can assign it later.' : `${n} parts stay unassigned — you can assign them later.`),
  allocated: (n, qty) => `${n} of ${qty} parts allocated`,
  tooMany: 'More parts allocated than the job needs.',
  parts: (n) => (n === 1 ? '1 part' : `${n} parts`),

  currentPrint: 'Current print',
  queueTitle: 'Queue',
  maintainCost: (coins, minutes) => `${coins} coins · ${minutes} min`,
  repairCost: (coins, minutes) => `${coins} coins · ${minutes} min`,
  notEnoughCoins: 'Not enough Farm Coins',
  onlyWhenIdle: 'Available while the printer is idle or done',
  maintenanceLocked: (level) => `Maintenance unlocks at level ${level}`,
  sellTitle: 'Sell this printer?',
  sellBody: (name, coins) => `${name} sells for ${coins} coins. This cannot be undone.`,
  sellBodyNoQuote: (name) => `${name} sells at the resale price the server sets when the sale goes through. This cannot be undone.`,
  sellOnlyIdle: 'Only idle printers can be sold',
  renameLabel: 'Printer name',
  renamePlaceholder: 'e.g. Line one',
  nicknameSaved: 'Name saved.',

  market: 'Market',
  filament: 'Filament',
  materialLabel: 'Material',
  colorLabel: 'Colour',
  sizeLabel: 'Spool size',
  spoolSize: (g) => `${g} g`,
  pricePerGram: (coins) => `${coins} coins / g`,
  price: 'Price',
  storageLeft: (g, total) => `Storage: ${g} g free of ${total} g`,
  storageFull: 'Not enough storage for this spool',
  noFreeSlot: 'No free slot in the room',
  catalog: 'Printer catalog',
  specSpeed: 'Speed',
  specVolume: 'Build volume',
  specMaterials: 'Materials',
  specAms: 'Multi-colour',
  yes: 'Yes',
  no: 'No',
  specReliability: 'Reliability',
  specPower: 'Power',
  family: (f) => `${f} series`,
  buyPrinterTitle: 'Buy a printer',
  buyPrinterBody: (name, coins) => `Buy ${name} for ${coins} coins? It lands in the first free slot.`,
  buyFilamentTitle: 'Buy filament',
  buyFilamentBody: (material, color, grams, coins) => `Buy a ${grams} g spool of ${material} ${color} for ${coins} coins?`,
  materialLocked: (level) => `Unlocks at level ${level}`,
  owned: (n) => (n === 1 ? 'You own 1' : `You own ${n}`),

  inventory: 'Inventory',
  spools: 'Spools',
  noSpools: 'No spools',
  noSpoolsDesc: 'Buy filament in the market to start printing.',
  spoolQuality: (q) => `Quality ${q}`,
  ledger: 'Coin ledger',
  noLedger: 'No movements yet.',
  balanceAfter: (coins) => `Balance after ${coins}`,
  ledgerKinds: LEDGER_EN,
  printersOwned: 'Printers',

  awayTitle: 'While you were away',
  awayIntro: 'What happened on your farm since your last visit.',
  awaySince: (t) => `Away for ${t}`,
  awayFinished: (n) => (n === 1 ? '1 print finished and waits to be collected' : `${n} prints finished and wait to be collected`),
  awayFailed: (n) => (n === 1 ? '1 print failed' : `${n} prints failed`),
  awayLate: (n) => (n === 1 ? '1 job passed its deadline' : `${n} jobs passed their deadline`),
  awayCancelled: (n) => (n === 1 ? '1 job cancelled by the customer or offer expired' : `${n} jobs cancelled by the customer or offers expired`),
  awayMaintenance: (n) => (n === 1 ? '1 maintenance completed' : `${n} maintenances completed`),
  awayLevelUp: (n) => (n === 1 ? 'You reached a new level' : `You climbed ${n} levels`),
  awayCoins: 'Net coins',
  awayOther: (n) => (n === 1 ? '1 other event' : `${n} other events`),

  batchFailed: (kind) => `Print failed: ${kind}`,
  failureKinds: FAILURES_EN,
  activeOfMax: (n, max) => `${n} of ${max} active jobs`,

  payoutPending: 'Payout pending',
  payoutPendingBody: 'Handed over to the customer; the coins arrive on the next day under the daily cap.',
  collectReplayed: 'This batch was already collected — nothing extra was paid.',
  collectPartsOnly: (qty) => `${qty === 1 ? '1 part' : `${qty} parts`} collected. The job is paid once every part is handed over.`,
  collectFailed: (qty, kind) => `The batch of ${qty === 1 ? '1 part' : `${qty} parts`} failed: ${kind}. Assign the missing parts again.`,
  collectPaid: (coins, stars) => `Delivered: +${coins} coins, ${stars}★ reputation`,
  collectPaidLate: (coins, stars) => `Delivered late: +${coins} coins, ${stars}★ reputation`,
  collectLevelUp: (level) => `Level ${level} reached`,
  collectDeferred: (coins, cap) => `Handed over. The payout of ${coins} coins arrives tomorrow because ${cap} is reached.`,
  capJobs: "today's jobs cap",
  capCoins: "today's coins cap",

  errGeneric: 'The action could not be completed. Please try again.',
  errors: ERRORS_EN,

  hubTitle: 'Games',
  hubKicker: 'Business simulator',
  hubDesc: 'Start with one printer and one spool. Take customer jobs, print, deliver before the deadline, and build an automated print farm.',
  hubGuestTitle: 'Sign in to run your farm',
  hubGuestDesc: 'The farm saves your progress to your account — printers, jobs and coins all live on the server.',
  hubYourFarm: 'Your farm',
  hubLeaderboards: 'Leaderboards',
  hubLeaderboardsDesc: 'Reputation, farm value and jobs delivered.',
  hubProfile: 'Farm profile',
  hubProfileDesc: 'Your level, stats and reputation.',
  hubRedeem: 'Coin conversion',
  hubRedeemDesc: 'The rules for turning Farm Coins into Levonis Points.',

  shelved: {
    badge: 'In development',
    title: 'The farm is under development',
    body: 'The game is still being built and is not open to players yet. Nothing was lost: every farm is stored exactly as its owner left it, and play resumes where it stopped.',
    linkNote: 'Opens with the game',
    linkUnknown: 'Could not check whether the game is open',
    adminBadge: 'Closed to players',
    adminBody: 'You are entering as an admin — players only see the notice. The switch is in Admin → Printer Farm.',
  },

  lbTitle: 'Leaderboards',
  lbBoardReputation: 'Reputation',
  lbBoardFarmValue: 'Farm value',
  lbBoardJobs: 'Delivered',
  lbBoardsLabel: 'Choose a board',
  lbEmptyTitle: 'Nobody has played yet',
  lbEmptyDesc: 'The first farm to deliver a job appears here.',
  lbYou: 'You',
  lbRank: (n) => `Rank ${n}`,
  lbJobs: (n) => (n === 1 ? '1 job' : `${n} jobs`),

  profTitle: 'Farm profile',
  profStats: 'Statistics',
  profDelivered: 'Jobs delivered',
  profLate: 'Late',
  profCancelled: 'Cancelled',
  profPrints: 'Prints',
  profFailures: 'Failures',
  profStreak: 'Delivery streak',
  profLifetime: 'Lifetime coins earned',
  profLocation: 'Location',
  notSent: '—',

  redeemTitle: 'Coin conversion',
  redeemIntro: 'Farm Coins are an in-game currency. Levonis Points are the store\'s real reward currency and are only ever issued by the server, within limits the team sets.',
  redeemClosedTitle: 'Conversion is not open',
  redeemClosedBody: 'The server reports that converting Farm Coins into Levonis Points is not enabled. Your coins stay in the game and grow the farm.',
  redeemRulesTitle: 'Rules as the server sends them',
  redeemRuleRate: (n) => `${n} Farm Coins per Levonis Point`,
  redeemRuleDaily: (n) => `Daily cap: ${n} points`,
  redeemRuleWeekly: (n) => `Weekly cap: ${n} points`,
  redeemRuleLevel: (n) => `Level required: ${n}`,
  redeemRuleRep: (stars) => `Reputation required: ${stars}★`,
  redeemNoRules: 'The server sent no conversion rules.',
  redeemGuest: 'Sign in to see the conversion status for your account.',
  redeemNoButton: 'There is no conversion action in this phase — this page shows the server\'s state only.',
};

const ckb: FarmStrings = {
  title: 'کێڵگەی چاپکەر',
  back: 'گەڕانەوە',
  coins: 'دراوی کێڵگە',
  coinsUnit: 'دراو',
  level: (n) => `ئاستی ${n}`,
  xpProgress: (xp, next) => `${xp} / ${next} ئەزموون`,
  reputation: 'ناوبانگ',
  starsLabel: (stars) => `${stars} لە 5 ئەستێرە`,
  recovery: 'دۆخی چاکبوونەوە',
  todayJobs: (jobs, cap) => `ئەمڕۆ: ${jobs} لە ${cap} کار`,
  tabsLabel: 'بەشەکانی کێڵگە',
  tabFarm: 'کێڵگە',
  tabJobs: 'کارەکان',
  tabMarket: 'بازاڕ',
  tabInventory: 'کۆگا',
  tabStore: 'فرۆشگا',
  tabUpgrades: 'پێشخستن',
  lockedLevel: (n) => `لە ئاستی ${n} دەکرێتەوە`,
  lockedLater: 'لەم قۆناغەدا نییە',
  lockedSection: 'بەشی داخراو',
  sectionLockedBody: 'ڕاژەکار هێشتا ئەم بەشە بۆ کێڵگەکەت نەکردووەتەوە.',
  loading: 'کێڵگە باردەکرێت…',
  retry: 'دووبارە هەوڵ بدەوە',
  close: 'داخستن',
  cancel: 'هەڵوەشاندنەوە',
  confirm: 'دڵنیاکردنەوە',
  save: 'پاشەکەوت',
  gotIt: 'تێگەیشتم',
  estimate: 'خەمڵاندن',
  busy: 'جێبەجێ دەکرێت…',

  roomLabel: 'ژووری چاپ',
  roomDesc: (printers, slots) => `${printers} لە ${slots} شوێن بەکارهاتووە`,
  emptySlot: 'شوێنی بەتاڵ',
  addPrinter: 'چاپکەرێک زیاد بکە',
  slotN: (n) => `شوێنی ${n}`,
  openPrinter: (name) => `چاپکەری ${name} بکەرەوە`,
  shelf: 'ڕەفی فیلامێنت',
  spoolsOnShelf: (n) => `${n} بۆبین لەسەر ڕەف`,
  workTable: 'مێزی کار',

  stateIdle: 'وەستاوە',
  statePrinting: 'چاپ دەکات',
  stateDone: 'ئامادەیە بۆ وەرگرتن',
  stateMaintenance: 'لە چاککردندایە',
  stateBroken: 'تێکچووە',
  health: 'باری تەکنیکی',
  healthPct: (n) => `بار ${n}%`,
  maintenanceRecommended: 'چاککردن پێشنیار دەکرێت',
  nextInQueue: 'دواتر لە ڕیز',
  queueEmpty: 'ڕیز بەتاڵە',
  timeLeft: (t) => `${t} ماوە`,
  readyToCollect: 'چاپەکە ئامادەیە بۆ وەرگرتن',
  awaitingRepair: 'پێویستی بە چاککردنەوە هەیە',
  underMaintenance: 'چاککردن بەردەوامە',
  progress: 'پێشکەوتن',
  hours: 'کاتژمێری کارکردن',
  prints: 'چاپ',
  failures: 'شکست',
  machines: 'ئامێرەکان',
  noPrinters: 'هیچ چاپکەرێک لە ژوورەکە نییە.',
  queued: (n) => `${n} کۆمەڵە لە ڕیز`,

  collect: 'وەرگرتن',
  maintain: 'چاککردن',
  repair: 'چاککردنەوە',
  assignWork: 'کار دیاری بکە',
  rename: 'ناو گۆڕین',
  sell: 'فرۆشتن',
  start: 'دەست بکە بە چاپ',
  accept: 'قبوڵکردن',
  reject: 'ڕەتکردنەوە',
  cancelJob: 'هەڵوەشاندنەوەی کار',
  assign: 'دیاریکردن',
  buy: 'کڕین',
  loadMore: 'زیاتر ببینە',
  moveUp: 'پێشخستن لە ڕیز',
  moveDown: 'دواخستن لە ڕیز',
  viewLedger: 'تۆماری دراو',
  enterFarm: 'بچۆ ناو کێڵگە',
  takeFirstJob: 'یەکەم کارت وەربگرە',
  keepJob: 'کارەکە بهێڵەرەوە',
  details: 'وردەکاری',

  introLine1: 'یەک A1 mini، یەک بۆبینی PLA و ژوورێکی بچووکت هەیە.',
  introLine2: 'کارێکی کڕیار قبوڵ بکە، بیخە سەر چاپکەر، پارچەکان پێش کاتی دیاریکراو وەربگرە.',
  introLine3: 'هەر گەیاندنێک دراو و ناوبانگ دەهێنێت — کێڵگە بەمە گەشە دەکات.',

  offers: 'پێشنیارەکانی کڕیار',
  activeJobs: 'کارە چالاکەکان',
  noOffers: 'ئێستا هیچ پێشنیارێک نییە',
  noOffersDesc: 'کڕیاران بە ماوە پێشنیاری نوێ دەنێرن — دواتر سەیر بکەرەوە.',
  noActive: 'هیچ کاری چالاک نییە',
  noActiveDesc: 'پێشنیارێک قبوڵ بکە بۆ دەستپێکردنی چاپ.',
  urgencyUrgent: 'بەپەلە',
  urgencyTight: 'کات تەنگە',
  urgencyRelaxed: 'کات فراوانە',
  tierIndividual: 'تاک',
  tierSmallBusiness: 'کاری بچووک',
  tierMerchant: 'بازرگان',
  tierCompany: 'کۆمپانیا',
  tierIndustrial: 'پیشەسازی',
  qtyProduct: (qty, product) => `${qty} × ${product}`,
  grams: (g) => `${g} گ`,
  printTime: 'کاتی چاپ',
  realTime: (t) => `≈ ${t} ڕاستەقینە`,
  reward: 'خەڵات',
  reputationGain: (stars) => `+${stars}★ ناوبانگ`,
  latePenalty: (stars) => `−${stars}★ لە دواکەوتن`,
  cancelPenaltyBp: (stars) => `−${stars}★ لە هەڵوەشاندنەوە`,
  cancelPenaltyCoins: (coins) => `−${coins} دراو لە هەڵوەشاندنەوە`,
  offerExpiresIn: (t) => `پێشنیار لە ${t} کۆتایی دێت`,
  offerExpired: 'پێشنیار کۆتایی هات',
  deadlineIn: (t) => `کاتی دیاریکراو لە ${t}`,
  deadlinePassed: 'کاتی دیاریکراو تێپەڕی',
  deadline: 'کاتی دیاریکراو',
  assignedOf: (assigned, qty) => `${assigned} / ${qty} دیاریکراو`,
  unassigned: (n) => `${n} پارچە دیارینەکراو`,
  jobAccepted: 'قبوڵکراو',
  jobPrinting: 'لە چاپدایە',
  jobReady: 'ئامادەیە بۆ گەیاندن',
  jobDelivered: 'گەیەنراوە',
  jobLate: 'دواکەوتوو',
  jobCancelled: 'هەڵوەشێنراوە',
  printingOn: (n) => `لەسەر ${n} چاپکەر`,
  cancelJobTitle: 'ئەم کارە هەڵبوەشێنرێتەوە؟',
  cancelJobBody: 'سزای هەڵوەشاندنەوەی سەر کارتەکە جێبەجێ دەکرێت؛ گرامی پاشەکەوتکراو بۆ کۆمەڵەکانی دەستپێنەکراو دەگەڕێنرێتەوە.',
  colors: 'ڕەنگەکان',

  assignTitle: 'دابەشکردنی کار',
  assignIntro: 'چاپکەرەکان، بۆبینێک بۆ هەر یەکێک، و ژمارەی پارچە بۆ هەر چاپکەر هەڵبژێرە.',
  printersLabel: 'چاپکەرەکان',
  spoolLabel: 'بۆبین',
  chooseSpool: 'بۆبینێک هەڵبژێرە',
  noCompatibleSpool: 'بۆبینی گونجاو نییە — فیلامێنت لە بازاڕ بکڕە.',
  gramsNeeded: (g) => `پێویستی بە ${g} گ هەیە`,
  gramsLeft: (g) => `${g} گ ماوە`,
  insufficientGrams: 'گرام بەش ناکات',
  qualityLabel: 'کوالیتی',
  qualityDraft: 'ڕەشنووس',
  qualityStandard: 'ستاندارد',
  qualityFine: 'ورد',
  qualityUltra: 'زۆر ورد',
  estPrintTime: 'کاتی چاپی خەمڵێنراو',
  estFinish: 'کۆتایی خەمڵێنراو',
  riskOnTime: 'لە کاتی خۆی',
  riskTight: 'لەسەر سنوور',
  riskLate: 'دوا دەکەوێت',
  incompatibleMaterial: 'ئەم کەرەستەیە چاپ ناکات',
  incompatibleMulticolor: 'سیستەمی فرەڕەنگی نییە',
  incompatibleTooLarge: 'پارچە لە قەبارەی چاپ گەورەترە',
  unavailableBroken: 'تێکچووە',
  unavailableMaintenance: 'لە چاککردندایە',
  unknownModel: 'مۆدێلی نەناسراو',
  queueWait: (t) => `چاوەڕوانی ڕیز ${t}`,
  partialNote: (n) => `${n} پارچە دیارینەکراو دەمێنێتەوە — دواتر دەتوانیت دیاری بکەیت.`,
  allocated: (n, qty) => `${n} لە ${qty} پارچە دابەشکراو`,
  tooMany: 'پارچەی دابەشکراو لە پێویست زیاترە.',
  parts: (n) => `${n} پارچە`,

  currentPrint: 'چاپی ئێستا',
  queueTitle: 'ڕیز',
  maintainCost: (coins, minutes) => `${coins} دراو · ${minutes} خولەک`,
  repairCost: (coins, minutes) => `${coins} دراو · ${minutes} خولەک`,
  notEnoughCoins: 'دراوی کێڵگە بەش ناکات',
  onlyWhenIdle: 'بەردەستە کاتێک چاپکەر وەستاوە یان تەواو بووە',
  maintenanceLocked: (level) => `چاککردن لە ئاستی ${level} دەکرێتەوە`,
  sellTitle: 'ئەم چاپکەرە بفرۆشرێت؟',
  sellBody: (name, coins) => `${name} بە ${coins} دراو دەفرۆشرێت. ناگەڕێندرێتەوە.`,
  sellBodyNoQuote: (name) => `${name} بەو نرخی فرۆشتنەوەیە دەفرۆشرێت کە ڕاژەکار لە کاتی جێبەجێکردن دیاری دەکات. ناگەڕێندرێتەوە.`,
  sellOnlyIdle: 'تەنها چاپکەری وەستاو دەفرۆشرێت',
  renameLabel: 'ناوی چاپکەر',
  renamePlaceholder: 'نموونە: هێڵی یەکەم',
  nicknameSaved: 'ناو پاشەکەوت کرا.',

  market: 'بازاڕ',
  filament: 'فیلامێنت',
  materialLabel: 'کەرەستە',
  colorLabel: 'ڕەنگ',
  sizeLabel: 'قەبارەی بۆبین',
  spoolSize: (g) => `${g} گ`,
  pricePerGram: (coins) => `${coins} دراو / گ`,
  price: 'نرخ',
  storageLeft: (g, total) => `کۆگا: ${g} گ بەتاڵ لە ${total} گ`,
  storageFull: 'کۆگا بۆ ئەم بۆبینە بەش ناکات',
  noFreeSlot: 'شوێنی بەتاڵ لە ژوورەکە نییە',
  catalog: 'کاتالۆگی چاپکەر',
  specSpeed: 'خێرایی',
  specVolume: 'قەبارەی چاپ',
  specMaterials: 'کەرەستەکان',
  specAms: 'فرەڕەنگ',
  yes: 'بەڵێ',
  no: 'نەخێر',
  specReliability: 'متمانەپێکراوی',
  specPower: 'وزە',
  family: (f) => `زنجیرەی ${f}`,
  buyPrinterTitle: 'کڕینی چاپکەر',
  buyPrinterBody: (name, coins) => `${name} بە ${coins} دراو بکڕیت؟ لە یەکەم شوێنی بەتاڵ دادەنرێت.`,
  buyFilamentTitle: 'کڕینی فیلامێنت',
  buyFilamentBody: (material, color, grams, coins) => `بۆبینی ${grams} گ ${material} ${color} بە ${coins} دراو بکڕیت؟`,
  materialLocked: (level) => `لە ئاستی ${level} دەکرێتەوە`,
  owned: (n) => `${n} هەیە`,

  inventory: 'کۆگا',
  spools: 'بۆبینەکان',
  noSpools: 'هیچ بۆبینێک نییە',
  noSpoolsDesc: 'فیلامێنت لە بازاڕ بکڕە بۆ دەستپێکردنی چاپ.',
  spoolQuality: (q) => `کوالیتی ${q}`,
  ledger: 'تۆماری دراو',
  noLedger: 'هێشتا هیچ جوڵەیەک نییە.',
  balanceAfter: (coins) => `باڵانس دواتر ${coins}`,
  ledgerKinds: LEDGER_CKB,
  printersOwned: 'چاپکەرەکان',

  awayTitle: 'کاتێک دوور بوویت',
  awayIntro: 'ئەوەی لە کێڵگەکەت ڕوویدا لە دوایین سەردانتەوە.',
  awaySince: (t) => `${t} دوور بوویت`,
  awayFinished: (n) => `${n} چاپ تەواو بوو و چاوەڕێی وەرگرتنە`,
  awayFailed: (n) => `${n} چاپ شکستی هێنا`,
  awayLate: (n) => `${n} کار کاتی دیاریکراوی تێپەڕی`,
  awayCancelled: (n) => `${n} کار لەلایەن کڕیار هەڵوەشێنرایەوە یان پێشنیارەکەی بەسەرچوو`,
  awayMaintenance: (n) => `${n} چاککردن تەواو بوو`,
  awayLevelUp: (n) => `${n} ئاست بەرزبوویتەوە`,
  awayCoins: 'کۆی دراو',
  awayOther: (n) => `${n} ڕووداوی دیکە`,

  batchFailed: (kind) => `چاپ شکستی هێنا: ${kind}`,
  failureKinds: FAILURES_CKB,
  activeOfMax: (n, max) => `${n} لە ${max} کاری چالاک`,

  payoutPending: 'پارەدان دواخراوە',
  payoutPendingBody: 'پارچەکان بە کڕیار گەیەنران؛ دراوەکان ڕۆژی داهاتوو لە سنووری ڕۆژانە دەگەن.',
  collectReplayed: 'ئەم دەستەیە پێشتر وەرگیراوە — هیچ زیادەیەک نەدرا.',
  collectPartsOnly: (qty) => `${qty} پارچە وەرگیرا. کارەکە کاتێک پارە دەدرێت هەموو پارچەکان بگەیەنرێن.`,
  collectFailed: (qty, kind) => `دەستەی ${qty} پارچە شکستی هێنا: ${kind}. پارچەکانی کەم دووبارە دابەش بکە.`,
  collectPaid: (coins, stars) => `گەیەنرا: +${coins} دراو، ${stars}★ ناوبانگ`,
  collectPaidLate: (coins, stars) => `بە دواکەوتن گەیەنرا: +${coins} دراو، ${stars}★ ناوبانگ`,
  collectLevelUp: (level) => `گەیشتیت بە ئاستی ${level}`,
  collectDeferred: (coins, cap) => `گەیەنرا. پارەدانی ${coins} دراو سبەینێ دەگات چونکە ${cap} پڕ بووە.`,
  capJobs: 'سنووری کاری ئەمڕۆ',
  capCoins: 'سنووری دراوی ئەمڕۆ',

  errGeneric: 'کردارەکە جێبەجێ نەکرا. دووبارە هەوڵ بدەوە.',
  errors: ERRORS_CKB,

  hubTitle: 'یارییەکان',
  hubKicker: 'شێوەکاری بازرگانی',
  hubDesc: 'بە یەک چاپکەر و یەک بۆبین دەست پێ بکە. کاری کڕیاران وەربگرە، چاپ بکە، پێش کاتی دیاریکراو بگەیەنە، و کێڵگەیەکی چاپی ئۆتۆماتیکی دروست بکە.',
  hubGuestTitle: 'بچۆ ژوورەوە بۆ بەڕێوەبردنی کێڵگەکەت',
  hubGuestDesc: 'کێڵگە پێشکەوتنت لەسەر هەژمارەکەت پاشەکەوت دەکات — چاپکەر و کار و دراو هەموو لەسەر ڕاژەکارن.',
  hubYourFarm: 'کێڵگەکەت',
  hubLeaderboards: 'خشتەی پێشەنگان',
  hubLeaderboardsDesc: 'ناوبانگ، بەهای کێڵگە، و کاری گەیەنراو.',
  hubProfile: 'پرۆفایلی کێڵگە',
  hubProfileDesc: 'ئاست و ئامار و ناوبانگت.',
  hubRedeem: 'گۆڕینی دراو',
  hubRedeemDesc: 'ڕێساکانی گۆڕینی دراوی کێڵگە بۆ خاڵی لیڤۆنیس.',

  // THE ARABIC TEXT, ON PURPOSE. The shelving notice is new copy and the
  // Sorani for it is the owner's to write by hand — machine-written Kurdish is
  // not allowed on this site. A Kurdish reader sees the Arabic sentence, which
  // is true, rather than an invented one that might not be. Replace these six
  // values with the owner's wording; nothing else has to change.
  shelved: {
    badge: 'قريبا',
    title: 'المزرعة تحت التطوير',
    body: 'اللعبة قيد التطوير الآن ولم تُفتح للاعبين بعد. لم يضع أحد شيئًا: كل ما جمعته المزارع محفوظ كما هو، وتعود اللعبة من حيث توقفت عند فتحها.',
    linkNote: 'يفتح مع اللعبة',
    linkUnknown: 'تعذّر معرفة حالة اللعبة',
    adminBadge: 'مغلقة على اللاعبين',
    adminBody: 'أنت تدخلها كمشرف — اللاعبون يرون إشعار «قريبا» فقط. الفتح من لوحة الإدارة ← مزرعة الطابعات.',
  },

  lbTitle: 'خشتەی پێشەنگان',
  lbBoardReputation: 'ناوبانگ',
  lbBoardFarmValue: 'بەهای کێڵگە',
  lbBoardJobs: 'گەیەنراو',
  lbBoardsLabel: 'خشتەیەک هەڵبژێرە',
  lbEmptyTitle: 'هێشتا کەس یاری نەکردووە',
  lbEmptyDesc: 'یەکەم کێڵگە کە کارێک بگەیەنێت لێرە دەردەکەوێت.',
  lbYou: 'تۆ',
  lbRank: (n) => `پلەی ${n}`,
  lbJobs: (n) => `${n} کار`,

  profTitle: 'پرۆفایلی کێڵگە',
  profStats: 'ئامارەکان',
  profDelivered: 'کاری گەیەنراو',
  profLate: 'دواکەوتوو',
  profCancelled: 'هەڵوەشێنراو',
  profPrints: 'چاپ',
  profFailures: 'شکست',
  profStreak: 'زنجیرەی گەیاندن',
  profLifetime: 'کۆی دراوی بەدەستهاتوو',
  profLocation: 'شوێن',
  notSent: '—',

  redeemTitle: 'گۆڕینی دراو',
  redeemIntro: 'دراوی کێڵگە دراوی ناو یارییە. خاڵی لیڤۆنیس دراوی خەڵاتی ڕاستەقینەی فرۆشگایە و تەنها لە ڕاژەکارەوە دەردەچێت، لە سنووری ئەو ڕێسایانەی تیم دیاری دەکات.',
  redeemClosedTitle: 'گۆڕین ئێستا کراوە نییە',
  redeemClosedBody: 'ڕاژەکار ڕاپۆرت دەکات کە گۆڕینی دراوی کێڵگە بۆ خاڵی لیڤۆنیس چالاک نییە. دراوەکانت لە یاری دەمێننەوە و کێڵگە گەشە پێ دەدەن.',
  redeemRulesTitle: 'ڕێساکان وەک ڕاژەکار دەیاننێرێت',
  redeemRuleRate: (n) => `${n} دراوی کێڵگە بۆ هەر خاڵێکی لیڤۆنیس`,
  redeemRuleDaily: (n) => `سنووری ڕۆژانە: ${n} خاڵ`,
  redeemRuleWeekly: (n) => `سنووری هەفتانە: ${n} خاڵ`,
  redeemRuleLevel: (n) => `ئاستی پێویست: ${n}`,
  redeemRuleRep: (stars) => `ناوبانگی پێویست: ${stars}★`,
  redeemNoRules: 'ڕاژەکار هیچ ڕێسایەکی گۆڕینی نەناردووە.',
  redeemGuest: 'بچۆ ژوورەوە بۆ بینینی دۆخی گۆڕین بۆ هەژمارەکەت.',
  redeemNoButton: 'لەم قۆناغەدا کرداری گۆڕین نییە — ئەم پەڕەیە تەنها دۆخی ڕاژەکار پیشان دەدات.',
};

export const FARM_STRINGS: Record<Language, FarmStrings> = { ar, en, ckb };
