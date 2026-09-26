/**
 * The admin serial inventory's wire types, calls and words
 * (worker/routes/serialInventory.ts). Admin screens are Arabic and English;
 * a Sorani-reading admin gets the Arabic, like every other admin panel.
 */
import { api, ApiError } from '../../../lib/api';
import type { BulkRowProblem } from '../../../../packages/catalog/src/deviceSerials';

export const INVENTORY_BASE = '/api/devices/admin/serial-inventory';

export type InventoryStatus = 'in_stock' | 'sold' | 'registered' | 'void';
export type PreviewOutcome = 'new' | 'new_assigned' | 'exists' | 'duplicate_in_batch' | 'invalid';

export interface InventoryRow {
  serial: string;
  serial_norm: string;
  model_code: string;
  model_name: string;
  product: { id: string; name: string; name_ar: string } | null;
  variant_id: string | null;
  box_sn: string;
  ean: string;
  source: 'manual' | 'bulk' | 'scan';
  note: string;
  status: InventoryStatus;
  unit: { id: string; order_id: string | null; delivered_at: string | null } | null;
  holder: { id: string; email: string | null; username: string | null; registered_at: string | null } | null;
  voided_at: string | null;
  void_reason: string;
  created_at: string;
  updated_at: string;
  created_by: { id: string; email: string | null; username: string | null };
}

export interface ListResponse {
  rows: InventoryRow[];
  next_cursor: string | null;
  counts: Record<InventoryStatus | 'all', number> | null;
}

export interface PreviewRow {
  line: number;
  serial_raw: string;
  serial_norm: string;
  model_name: string;
  model_code: string;
  box_sn: string;
  ean: string;
  problem: BulkRowProblem | null;
  duplicate_of: number | null;
  outcome: PreviewOutcome;
  existing_status?: InventoryStatus;
}

export interface PreviewCounts {
  total: number;
  new: number;
  new_assigned: number;
  exists: number;
  duplicate_in_batch: number;
  invalid: number;
}

export interface PreviewResponse {
  rows: PreviewRow[];
  counts: PreviewCounts;
  product: { id: string; name: string; serialized: boolean } | null;
  max_lines: number;
}

export interface CommitResponse {
  inserted: number;
  skipped_concurrent: number;
  counts: PreviewCounts;
}

export interface Filing {
  product_id: string;
  variant_id: string;
  model_code: string;
  model_name: string;
}

export interface ScanRowInput {
  serial: string;
  box_sn?: string;
  ean?: string;
  model_code?: string;
  model_name?: string;
}

function body(filing: Filing) {
  return {
    product_id: filing.product_id || undefined,
    variant_id: filing.variant_id || undefined,
    defaults: { model_code: filing.model_code, model_name: filing.model_name },
  };
}

export const inventoryApi = {
  list: (params: URLSearchParams) => api.get<ListResponse>(`${INVENTORY_BASE}?${params.toString()}`),
  previewText: (text: string, filing: Filing) => api.post<PreviewResponse>(`${INVENTORY_BASE}/preview`, { text, ...body(filing) }),
  previewRows: (rows: ScanRowInput[], filing: Filing) => api.post<PreviewResponse>(`${INVENTORY_BASE}/preview`, { rows, ...body(filing) }),
  commitText: (text: string, filing: Filing) =>
    api.post<CommitResponse>(`${INVENTORY_BASE}/commit`, { text, source: 'bulk', ...body(filing) }),
  commitRows: (rows: ScanRowInput[], filing: Filing, source: 'manual' | 'scan') =>
    api.post<CommitResponse>(`${INVENTORY_BASE}/commit`, { rows, source, ...body(filing) }),
  resolve: (ean: string, modelCode = '') =>
    api.get<{
      match: {
        via: string;
        product: { id: string; name_en: string; name_ar: string; sku?: string | null; price_iqd: number; status: string; composition: string };
        variant_id: string | null;
        model_code: string;
        model_name: string;
      } | null;
    }>(`${INVENTORY_BASE}/resolve?${new URLSearchParams({ ean, model_code: modelCode }).toString()}`),
  variants: (productId: string) =>
    api.get<{ variants: Array<{ id: string; combo_key: string; sku: string | null }> }>(
      `${INVENTORY_BASE}/variants?${new URLSearchParams({ product_id: productId }).toString()}`
    ),
  detail: (serialNorm: string) =>
    api.get<{ row: InventoryRow; history: Array<{ id: string; action: string; created_at: string; actor: { email: string | null; username: string | null } | null; detail: Record<string, unknown> }> }>(
      `${INVENTORY_BASE}/${encodeURIComponent(serialNorm)}`
    ),
  patch: (serialNorm: string, patch: Record<string, unknown>) =>
    api.patch<{ row: InventoryRow }>(`${INVENTORY_BASE}/${encodeURIComponent(serialNorm)}`, patch),
  setVoid: (serialNorm: string, voided: boolean, reason: string) =>
    api.post<{ row: InventoryRow }>(`${INVENTORY_BASE}/${encodeURIComponent(serialNorm)}/${voided ? 'void' : 'restore'}`, { reason }),
};

// ------------------------------------------------------------------ words

export const STR = {
  ar: {
    tabReceipts: 'وصولات الضمان',
    tabSerials: 'الأرقام التسلسلية',
    title: 'مخزون الأرقام التسلسلية',
    subtitle: 'أرقام الأجهزة التي في المتجر قبل بيعها. حين يكتب المشتري الرقم أو يمسحه من صفحة الضمان يُربط تلقائيًا بطابعته المُسلَّمة من الموديل نفسه.',
    add: 'إضافة أرقام تسلسلية',
    export: 'تصدير CSV',
    refresh: 'تحديث',
    search: 'ابحث برقم تسلسلي، رقم علبة، EAN، موديل، منتج، بريد أو طلب…',
    all: 'الكل',
    in_stock: 'في المخزون',
    sold: 'مُباع — غير مربوط',
    registered: 'مربوط بحساب',
    void: 'ملغى',
    serial: 'الرقم التسلسلي',
    model: 'الموديل',
    product: 'المنتج',
    status: 'الحالة',
    added: 'أُضيف',
    by: 'بواسطة',
    box: 'علبة',
    ean: 'EAN',
    order: 'طلب',
    holder: 'الحساب',
    noProduct: 'بلا منتج',
    empty: 'لا توجد أرقام تسلسلية بعد. أضفها واحدًا واحدًا، أو الصق قائمة، أو امسح ملصقات العلب بالكاميرا.',
    noResults: 'لا نتائج لهذا البحث.',
    loading: 'جارٍ التحميل…',
    loadMore: 'عرض المزيد',
    edit: 'تعديل',
    voidIt: 'إلغاء الرقم',
    restore: 'استعادة',
    history: 'السجل',
    hideHistory: 'إخفاء السجل',
    actions: 'إجراءات',
    voidTitle: 'إلغاء هذا الرقم التسلسلي؟',
    voidBody: 'الرقم الملغى لا يمكن لأي زبون ربطه. إن كان على جهاز مُباع يبقى الجهاز كما هو.',
    restoreTitle: 'استعادة هذا الرقم؟',
    reason: 'السبب (يُسجَّل في سجل التدقيق)',
    reasonShort: 'اكتب سببًا من 3 أحرف على الأقل.',
    confirmVoid: 'إلغاء الرقم',
    confirmRestore: 'استعادة',
    voided: 'أُلغي الرقم.',
    restored: 'استُعيد الرقم.',
    saved: 'تم الحفظ.',
    sources: { manual: 'يدوي', bulk: 'قائمة', scan: 'كاميرا' } as Record<string, string>,
    // dialog
    dialogTitle: 'إضافة أرقام تسلسلية',
    modeSingle: 'رقم واحد',
    modeBulk: 'قائمة',
    modeScan: 'مسح بالكاميرا',
    filing: 'تُحفظ تحت',
    filingHint: 'اختر المنتج مرة واحدة — يبقى مختارًا لكل الأرقام التالية وللمسح المتتالي.',
    pickProduct: 'اختر منتج الكتالوج…',
    variant: 'الخيار',
    anyVariant: 'بلا خيار محدد',
    modelCode: 'رمز الموديل',
    modelCodePh: 'PF002-A+SA005',
    modelName: 'اسم الموديل',
    modelNamePh: 'A1 Combo',
    notSerialized: 'هذا المنتج لا تُنشأ له وحدات عند التسليم (ليس طابعة ولا مُرقّمًا)، فلن يستطيع المشتري ربط أرقامه. فعّل «مُرقّم» في المنتج أو اختر منتجًا آخر.',
    noProductWarn: 'بلا منتج لا يمكن الربط التلقائي: الربط يحتاج أن يطابق الرقمُ طابعةً مُسلَّمة للمشتري من المنتج نفسه.',
    serialPh: '03919D580607841',
    boxSn: 'رقم العلبة (BOX SN)',
    boxPh: 'B07119G5811000AB',
    eanPh: '6977252425445',
    optional: 'اختياري',
    addOne: 'إضافة',
    pasteLabel: 'الصق الأرقام — رقم في كل سطر، أو CSV: serial,model',
    pasteHint: 'أعمدة اختيارية بعد الموديل: model_code, box_sn, ean. سطر عناوين يحدد ترتيبًا آخر. الحد 1000 سطر في المرة.',
    pastePh: '03919D580607841\n03919D580607842,A1 Combo\n03919D580607843,A1 Combo,PF002-A+SA005,,6977252425445',
    previewBtn: 'معاينة',
    previewing: 'جارٍ الفحص…',
    commitN: (n: number) => `حفظ ${n} رقمًا`,
    commitAll: (n: number) => `حفظ الكل (${n})`,
    committing: 'جارٍ الحفظ…',
    committed: (n: number) => `أُضيف ${n} رقمًا إلى المخزون.`,
    committedSome: (n: number, skipped: number) => `أُضيف ${n} رقمًا؛ ${skipped} أضافه شخص آخر في اللحظة نفسها.`,
    line: 'السطر',
    outcome: 'النتيجة',
    outcomes: {
      new: 'جديد',
      new_assigned: 'جديد — على جهاز مُباع',
      exists: 'موجود مسبقًا',
      duplicate_in_batch: 'مكرّر في القائمة',
      invalid: 'غير صالح',
    } as Record<PreviewOutcome, string>,
    duplicateOf: (n: number) => `يكرر السطر ${n}`,
    summary: (c: PreviewCounts) =>
      `${c.total} سطرًا: ${c.new + c.new_assigned} جديد، ${c.exists} موجود، ${c.duplicate_in_batch} مكرر، ${c.invalid} غير صالح`,
    problems: {
      SERIAL_EMPTY: 'فارغ',
      SERIAL_TOO_SHORT: 'قصير جدًا (6 خانات على الأقل)',
      SERIAL_TOO_LONG: 'طويل جدًا (40 خانة على الأكثر)',
      SERIAL_CHARS: 'حروف وأرقام إنجليزية فقط',
      SERIAL_LOOKS_LIKE_EAN: 'هذا EAN وليس رقمًا تسلسليًا',
      SERIAL_LOOKS_LIKE_RECEIPT: 'هذا رقم وصل ضمان',
      EAN_INVALID: 'EAN غير صحيح (رقم التحقق)',
      BOX_SN_INVALID: 'رقم العلبة غير صالح',
    } as Record<string, string>,
    scanStart: 'ابدأ المسح',
    scanIntro: 'وجّه الكاميرا إلى ملصق العلبة: يُقرأ باركود «Product SN» ومعه رقم العلبة وEAN إن ظهرا، ويبقى المنتج المختار لكل علبة. المسح متواصل — انتقل من علبة إلى التالية.',
    scanTitle: 'مسح ملصقات العلب',
    scanned: (n: number) => `${n} في القائمة`,
    scannedEmpty: 'لم يُمسح شيء بعد.',
    remove: 'إزالة',
    checking: 'فحص…',
    eanMatched: (name: string) => `تعرّفنا على المنتج من EAN: ${name}`,
    discard: 'تجاهل القائمة',
    unsavedTitle: 'في القائمة أرقام لم تُحفظ',
    closeScanner: 'إنهاء المسح',
    editTitle: 'تعديل الرقم التسلسلي',
    note: 'ملاحظة',
    save: 'حفظ',
    cancel: 'إلغاء',
    historyEmpty: 'لا تعديلات مسجّلة.',
    actionsNames: {
      'serial_inventory.update': 'تعديل',
      'serial_inventory.void': 'إلغاء',
      'serial_inventory.restore': 'استعادة',
      'serial_inventory.link_refused': 'محاولة ربط مرفوضة',
      'device.serial_assign': 'رُبط بجهاز',
      'device.serial_reassign': 'نُقل إلى جهاز آخر',
      'device.register': 'رُبط بحساب',
      'device.unregister': 'فُكّ من حساب',
    } as Record<string, string>,
    refusal: {
      SERIAL_LIST_EMPTY: 'القائمة فارغة.',
      SERIAL_LIST_TOO_LONG: 'القائمة أطول من 1000 سطر — قسّمها.',
      SERIAL_NOTHING_TO_ADD: 'لا شيء في القائمة يمكن إضافته (كلها موجودة أو غير صالحة).',
      SERIAL_PRODUCT_UNKNOWN: 'المنتج المختار لم يعد موجودًا.',
      SERIAL_VARIANT_MISMATCH: 'الخيار المختار ليس من هذا المنتج.',
      SERIAL_VARIANT_WITHOUT_PRODUCT: 'اختر المنتج قبل الخيار.',
      SERIAL_NOT_IN_INVENTORY: 'هذا الرقم لم يعد في المخزون.',
      SERIAL_ALREADY_VOID: 'الرقم ملغى مسبقًا.',
      SERIAL_NOT_VOID: 'الرقم غير ملغى.',
      BOX_SN_INVALID: 'رقم العلبة غير صالح.',
      EAN_INVALID: 'EAN غير صحيح.',
      NOTHING_TO_CHANGE: 'لا تغيير للحفظ.',
      REASON_REQUIRED: 'السبب مطلوب.',
    } as Record<string, string>,
    genericError: 'تعذّر إكمال العملية. حاول مجددًا.',
  },
  en: {
    tabReceipts: 'Warranty receipts',
    tabSerials: 'Serial numbers',
    title: 'Serial inventory',
    subtitle: 'Device serials the shop holds before a sale. When the buyer types or scans one on the warranty page it links to their delivered printer of the same model automatically.',
    add: 'Add serial numbers',
    export: 'Export CSV',
    refresh: 'Refresh',
    search: 'Search serial, box SN, EAN, model, product, email or order…',
    all: 'All',
    in_stock: 'In stock',
    sold: 'Sold — not linked',
    registered: 'Linked to an account',
    void: 'Void',
    serial: 'Serial',
    model: 'Model',
    product: 'Product',
    status: 'Status',
    added: 'Added',
    by: 'by',
    box: 'Box',
    ean: 'EAN',
    order: 'Order',
    holder: 'Account',
    noProduct: 'No product',
    empty: 'No serial numbers yet. Add them one by one, paste a list, or scan box labels with the camera.',
    noResults: 'No results for this search.',
    loading: 'Loading…',
    loadMore: 'Show more',
    edit: 'Edit',
    voidIt: 'Void serial',
    restore: 'Restore',
    history: 'History',
    hideHistory: 'Hide history',
    actions: 'Actions',
    voidTitle: 'Void this serial number?',
    voidBody: 'A void serial cannot be linked by any customer. If it is already on a sold device, that device stays as it is.',
    restoreTitle: 'Restore this serial?',
    reason: 'Reason (kept in the audit log)',
    reasonShort: 'Write a reason of at least 3 characters.',
    confirmVoid: 'Void serial',
    confirmRestore: 'Restore',
    voided: 'Serial voided.',
    restored: 'Serial restored.',
    saved: 'Saved.',
    sources: { manual: 'Manual', bulk: 'List', scan: 'Camera' } as Record<string, string>,
    dialogTitle: 'Add serial numbers',
    modeSingle: 'One serial',
    modeBulk: 'List',
    modeScan: 'Camera scan',
    filing: 'File under',
    filingHint: 'Pick the product once — it stays chosen for every following serial and for continuous scanning.',
    pickProduct: 'Choose a catalogue product…',
    variant: 'Option',
    anyVariant: 'No specific option',
    modelCode: 'Model code',
    modelCodePh: 'PF002-A+SA005',
    modelName: 'Model name',
    modelNamePh: 'A1 Combo',
    notSerialized: 'Delivery creates no units for this product (not a printer, not serialized), so buyers could never link these serials. Mark the product serialized or choose another.',
    noProductWarn: 'Without a product there is no automatic linking: a serial links only to the buyer’s delivered unit of the same product.',
    serialPh: '03919D580607841',
    boxSn: 'Box SN',
    boxPh: 'B07119G5811000AB',
    eanPh: '6977252425445',
    optional: 'optional',
    addOne: 'Add',
    pasteLabel: 'Paste serials — one per line, or CSV: serial,model',
    pasteHint: 'Optional columns after the model: model_code, box_sn, ean. A header line sets another order. Up to 1000 lines at a time.',
    pastePh: '03919D580607841\n03919D580607842,A1 Combo\n03919D580607843,A1 Combo,PF002-A+SA005,,6977252425445',
    previewBtn: 'Preview',
    previewing: 'Checking…',
    commitN: (n: number) => `Save ${n} serial${n === 1 ? '' : 's'}`,
    commitAll: (n: number) => `Save all (${n})`,
    committing: 'Saving…',
    committed: (n: number) => `${n} serial${n === 1 ? '' : 's'} added to the inventory.`,
    committedSome: (n: number, skipped: number) => `${n} added; ${skipped} were added by someone else at the same moment.`,
    line: 'Line',
    outcome: 'Result',
    outcomes: {
      new: 'New',
      new_assigned: 'New — on a sold device',
      exists: 'Already in inventory',
      duplicate_in_batch: 'Repeated in the list',
      invalid: 'Invalid',
    } as Record<PreviewOutcome, string>,
    duplicateOf: (n: number) => `repeats line ${n}`,
    summary: (c: PreviewCounts) =>
      `${c.total} lines: ${c.new + c.new_assigned} new, ${c.exists} existing, ${c.duplicate_in_batch} repeated, ${c.invalid} invalid`,
    problems: {
      SERIAL_EMPTY: 'empty',
      SERIAL_TOO_SHORT: 'too short (6+ characters)',
      SERIAL_TOO_LONG: 'too long (40 at most)',
      SERIAL_CHARS: 'Latin letters and digits only',
      SERIAL_LOOKS_LIKE_EAN: 'this is an EAN, not a serial',
      SERIAL_LOOKS_LIKE_RECEIPT: 'this is a warranty receipt number',
      EAN_INVALID: 'EAN check digit is wrong',
      BOX_SN_INVALID: 'invalid box SN',
    } as Record<string, string>,
    scanStart: 'Start scanning',
    scanIntro: 'Point the camera at the box label: the “Product SN” barcode is read, with the box SN and EAN when visible, and the chosen product sticks for every box. Scanning is continuous — move from one box to the next.',
    scanTitle: 'Scan box labels',
    scanned: (n: number) => `${n} in the list`,
    scannedEmpty: 'Nothing scanned yet.',
    remove: 'Remove',
    checking: 'Checking…',
    eanMatched: (name: string) => `Product recognised from the EAN: ${name}`,
    discard: 'Discard the list',
    unsavedTitle: 'The list has unsaved serials',
    closeScanner: 'Finish scanning',
    editTitle: 'Edit serial number',
    note: 'Note',
    save: 'Save',
    cancel: 'Cancel',
    historyEmpty: 'No recorded changes.',
    actionsNames: {
      'serial_inventory.update': 'Edited',
      'serial_inventory.void': 'Voided',
      'serial_inventory.restore': 'Restored',
      'serial_inventory.link_refused': 'Link attempt refused',
      'device.serial_assign': 'Put on a device',
      'device.serial_reassign': 'Moved to another device',
      'device.register': 'Linked to an account',
      'device.unregister': 'Unlinked from an account',
    } as Record<string, string>,
    refusal: {
      SERIAL_LIST_EMPTY: 'The list is empty.',
      SERIAL_LIST_TOO_LONG: 'The list is longer than 1000 lines — split it.',
      SERIAL_NOTHING_TO_ADD: 'Nothing in the list can be added (all existing or invalid).',
      SERIAL_PRODUCT_UNKNOWN: 'The chosen product no longer exists.',
      SERIAL_VARIANT_MISMATCH: 'That option is not one of this product.',
      SERIAL_VARIANT_WITHOUT_PRODUCT: 'Choose the product before the option.',
      SERIAL_NOT_IN_INVENTORY: 'This serial is no longer in the inventory.',
      SERIAL_ALREADY_VOID: 'Already void.',
      SERIAL_NOT_VOID: 'Not void.',
      BOX_SN_INVALID: 'Invalid box SN.',
      EAN_INVALID: 'Invalid EAN.',
      NOTHING_TO_CHANGE: 'Nothing to save.',
      REASON_REQUIRED: 'A reason is required.',
    } as Record<string, string>,
    genericError: 'Could not complete that. Try again.',
  },
};

export type InventoryStrings = typeof STR.ar;

/** A refusal in the admin's language — by its stable code, never the raw server text. */
export function refusalText(e: unknown, t: InventoryStrings): string {
  if (e instanceof ApiError && e.code && t.refusal[e.code]) return t.refusal[e.code];
  return t.genericError;
}
