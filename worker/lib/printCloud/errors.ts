/**
 * PRINT CLOUD REFUSALS — one code, one status, three languages.
 *
 * Every refusal the Print Cloud API gives is an `HttpError` built here, so the
 * code is the contract (a client switches on it) and the words exist in
 * Arabic, English and Sorani Kurdish (DECISIONS row 183: a `ckb` slot never
 * carries the Arabic). `message` keeps the house shape «عربي / English»;
 * `details.messages` carries all three for a client that picks one.
 *
 * `classifyDbError` turns a batch the database refused — a fence, a named
 * CHECK, a UNIQUE index — into the refusal it means. Anything it does not
 * recognise is NOT a refusal: it is rethrown, so an outage is a 500 the
 * caller retries, never an invented «out of stock».
 */
import { HttpError } from '../http';

export type PcErrorCode =
  | 'PRINT_CLOUD_NOT_INSTALLED'
  | 'PRINT_CLOUD_DISABLED'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'STATE_CHANGED'
  | 'OUT_OF_STOCK'
  | 'STOCK_DEFICIT'
  | 'INSUFFICIENT_CREDIT'
  | 'INSUFFICIENT_INVENTORY'
  | 'INVALID_TRANSITION'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_ALREADY_ORDERED'
  | 'PRICE_NOT_CONFIGURED'
  | 'QUANTITY_NOT_ALLOWED'
  | 'LIMIT_REACHED'
  | 'PAYMENT_ADAPTER_DISABLED'
  | 'PAYMENT_SIGNATURE_INVALID'
  | 'ORDER_NOT_PAYABLE'
  | 'FILE_TOO_LARGE'
  | 'FILE_TYPE_NOT_SUPPORTED'
  | 'FILE_REJECTED'
  | 'FILE_NOT_READY'
  | 'STORAGE_NOT_CONFIGURED'
  | 'URL_NOT_ALLOWED'
  | 'ESTIMATE_REQUIRED'
  | 'PRINTER_UNAVAILABLE'
  | 'PRINTER_BUSY'
  | 'INCOMPATIBLE_PRINTER'
  | 'CONVERSION_DISABLED'
  | 'BUYBACK_NOT_ALLOWED'
  | 'DELIVERY_NOT_AVAILABLE'
  | 'AGENT_UNAUTHORIZED'
  | 'DEPENDENCY_NOT_MET'
  | 'ADAPTER_NOT_CONNECTED';

interface Words {
  status: number;
  ar: string;
  en: string;
  ckb: string;
}

const WORDS: Record<PcErrorCode, Words> = {
  PRINT_CLOUD_NOT_INSTALLED: {
    status: 503,
    ar: 'خدمة الطباعة السحابية غير مثبتة على قاعدة البيانات بعد',
    en: 'Print Cloud is not installed on this database yet',
    ckb: 'خزمەتگوزاریی چاپی هەوری هێشتا لەسەر بنکەدراوەکە دانەمەزراوە',
  },
  PRINT_CLOUD_DISABLED: {
    status: 503,
    ar: 'خدمة الطباعة السحابية غير مفعّلة حالياً',
    en: 'Print Cloud is not open yet',
    ckb: 'خزمەتگوزاریی چاپی هەوری ئێستا چالاک نییە',
  },
  VALIDATION: {
    status: 400,
    ar: 'البيانات المرسلة غير صالحة',
    en: 'The request is not valid',
    ckb: 'داواکارییەکە دروست نییە',
  },
  NOT_FOUND: { status: 404, ar: 'غير موجود', en: 'Not found', ckb: 'نەدۆزرایەوە' },
  FORBIDDEN: { status: 403, ar: 'غير مسموح', en: 'Not allowed', ckb: 'ڕێگەپێدراو نییە' },
  IDEMPOTENCY_KEY_REQUIRED: {
    status: 400,
    ar: 'مفتاح منع التكرار مطلوب لهذه العملية',
    en: 'An Idempotency-Key header is required for this operation',
    ckb: 'کلیلی ڕێگری لە دووبارەبوونەوە بۆ ئەم کارە پێویستە',
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 409,
    ar: 'استُخدم مفتاح منع التكرار لطلب مختلف',
    en: 'This Idempotency-Key was already used for a different request',
    ckb: 'ئەم کلیلە پێشتر بۆ داواکارییەکی جیاواز بەکارهاتووە',
  },
  STATE_CHANGED: {
    status: 409,
    ar: 'تغيّرت البيانات أثناء الطلب، أعد المحاولة',
    en: 'The record changed while the request was running; try again',
    ckb: 'زانیارییەکان لە کاتی داواکارییەکەدا گۆڕان، دووبارە هەوڵ بدەرەوە',
  },
  OUT_OF_STOCK: {
    status: 409,
    ar: 'الكمية المطلوبة غير متوفرة في المخزون',
    en: 'The requested quantity is not in stock',
    ckb: 'بڕی داواکراو لە کۆگادا بەردەست نییە',
  },
  STOCK_DEFICIT: {
    status: 409,
    ar: 'المخزون الفعلي أقل من الكمية المطلوب تسجيلها',
    en: 'Physical stock is lower than the quantity being recorded',
    ckb: 'کۆگای ڕاستەقینە لە بڕی تۆمارکراو کەمترە',
  },
  INSUFFICIENT_CREDIT: {
    status: 409,
    ar: 'رصيد ساعات الطباعة غير كافٍ',
    en: 'Not enough printing hours',
    ckb: 'کاتژمێری چاپ بەس نییە',
  },
  INSUFFICIENT_INVENTORY: {
    status: 409,
    ar: 'رصيدك من هذه المادة غير كافٍ',
    en: 'Not enough of this material in your inventory',
    ckb: 'ئەم کەرەستەیە لە کۆگاکەتدا بەس نییە',
  },
  INVALID_TRANSITION: {
    status: 409,
    ar: 'لا يمكن تنفيذ هذه الخطوة في حالة الطلب الحالية',
    en: 'This step is not allowed in the current state',
    ckb: 'ئەم هەنگاوە لە دۆخی ئێستادا ڕێگەپێدراو نییە',
  },
  QUOTE_EXPIRED: {
    status: 409,
    ar: 'انتهت صلاحية عرض السعر، اطلب عرضاً جديداً',
    en: 'The quote has expired; request a new one',
    ckb: 'نرخدانەکە بەسەرچووە، نرخدانێکی نوێ داوا بکە',
  },
  QUOTE_ALREADY_ORDERED: {
    status: 409,
    ar: 'تم إنشاء طلب من عرض السعر هذا مسبقاً',
    en: 'An order was already created from this quote',
    ckb: 'پێشتر داواکارییەک لەم نرخدانە دروستکراوە',
  },
  PRICE_NOT_CONFIGURED: {
    status: 409,
    ar: 'لم يُحدَّد سعر لهذا المنتج أو الكمية بعد',
    en: 'No price is configured for this item or quantity',
    ckb: 'هێشتا نرخ بۆ ئەم کاڵا یان بڕە دیاری نەکراوە',
  },
  QUANTITY_NOT_ALLOWED: {
    status: 400,
    ar: 'الكمية المطلوبة غير مسموح بها',
    en: 'This quantity is not allowed',
    ckb: 'ئەم بڕە ڕێگەپێدراو نییە',
  },
  LIMIT_REACHED: {
    status: 409,
    ar: 'تم بلوغ الحد المسموح',
    en: 'The allowed limit has been reached',
    ckb: 'گەیشتیتە سنووری ڕێگەپێدراو',
  },
  PAYMENT_ADAPTER_DISABLED: {
    status: 503,
    ar: 'طريقة الدفع هذه غير مفعّلة',
    en: 'This payment method is not enabled',
    ckb: 'ئەم ڕێگای پارەدانە چالاک نییە',
  },
  PAYMENT_SIGNATURE_INVALID: {
    status: 401,
    ar: 'توقيع إشعار الدفع غير صالح',
    en: 'The payment notification signature is not valid',
    ckb: 'واژۆی ئاگادارکردنەوەی پارەدان دروست نییە',
  },
  ORDER_NOT_PAYABLE: {
    status: 409,
    ar: 'هذا الطلب لا ينتظر الدفع',
    en: 'This order is not awaiting payment',
    ckb: 'ئەم داواکارییە چاوەڕوانی پارەدان نییە',
  },
  FILE_TOO_LARGE: {
    status: 413,
    ar: 'حجم الملف أكبر من المسموح',
    en: 'The file is larger than allowed',
    ckb: 'قەبارەی فایلەکە لە ڕێگەپێدراو گەورەترە',
  },
  FILE_TYPE_NOT_SUPPORTED: {
    status: 415,
    ar: 'نوع الملف غير مدعوم (STL أو 3MF أو OBJ)',
    en: 'Unsupported file type (STL, 3MF or OBJ)',
    ckb: 'جۆری فایلەکە پشتگیری ناکرێت (STL یان 3MF یان OBJ)',
  },
  FILE_REJECTED: {
    status: 422,
    ar: 'رُفض الملف بعد الفحص',
    en: 'The file was rejected by validation',
    ckb: 'فایلەکە دوای پشکنین ڕەتکرایەوە',
  },
  FILE_NOT_READY: {
    status: 409,
    ar: 'لم يكتمل فحص الملف بعد',
    en: 'The file has not finished validation',
    ckb: 'پشکنینی فایلەکە هێشتا تەواو نەبووە',
  },
  STORAGE_NOT_CONFIGURED: {
    status: 503,
    ar: 'التخزين الخاص غير مهيأ',
    en: 'Private storage is not configured',
    ckb: 'هەڵگرتنی تایبەت ڕێکنەخراوە',
  },
  URL_NOT_ALLOWED: {
    status: 400,
    ar: 'هذا الرابط غير مدعوم',
    en: 'This link is not supported',
    ckb: 'ئەم بەستەرە پشتگیری ناکرێت',
  },
  ESTIMATE_REQUIRED: {
    status: 409,
    ar: 'يلزم تقدير من برنامج التقطيع قبل هذه الخطوة',
    en: 'A slicer estimate is required before this step',
    ckb: 'پێش ئەم هەنگاوە خەمڵاندنی بەرنامەی بڕین پێویستە',
  },
  PRINTER_UNAVAILABLE: {
    status: 409,
    ar: 'الطابعة غير متاحة',
    en: 'The printer is not available',
    ckb: 'چاپکەرەکە بەردەست نییە',
  },
  PRINTER_BUSY: {
    status: 409,
    ar: 'الطابعة مشغولة بمهمة أخرى',
    en: 'The printer is already working on another job',
    ckb: 'چاپکەرەکە سەرقاڵی کارێکی ترە',
  },
  INCOMPATIBLE_PRINTER: {
    status: 409,
    ar: 'الطابعة غير متوافقة مع هذه المهمة',
    en: 'The printer is not compatible with this job',
    ckb: 'چاپکەرەکە لەگەڵ ئەم کارەدا گونجاو نییە',
  },
  CONVERSION_DISABLED: {
    status: 409,
    ar: 'تحويل الساعات بين هذين النوعين غير مفعّل',
    en: 'Converting hours between these tiers is not enabled',
    ckb: 'گۆڕینی کاتژمێر لە نێوان ئەم دوو جۆرەدا چالاک نییە',
  },
  BUYBACK_NOT_ALLOWED: {
    status: 409,
    ar: 'إعادة البيع غير متاحة لهذه المادة',
    en: 'Buyback is not available for this item',
    ckb: 'فرۆشتنەوە بۆ ئەم کاڵایە بەردەست نییە',
  },
  DELIVERY_NOT_AVAILABLE: {
    status: 409,
    ar: 'التوصيل غير متاح لهذا الطلب',
    en: 'Delivery is not available for this request',
    ckb: 'گەیاندن بۆ ئەم داواکارییە بەردەست نییە',
  },
  AGENT_UNAUTHORIZED: {
    status: 401,
    ar: 'وكيل الورشة غير مصرّح له',
    en: 'Workshop agent not authorised',
    ckb: 'بریکاری کارگە ڕێگەپێدراو نییە',
  },
  DEPENDENCY_NOT_MET: {
    status: 409,
    ar: 'المهمة تعتمد على مهمة أخرى لم تكتمل',
    en: 'This job depends on another job that has not completed',
    ckb: 'ئەم کارە پشت بە کارێکی تر دەبەستێت کە تەواو نەبووە',
  },
  ADAPTER_NOT_CONNECTED: {
    status: 503,
    ar: 'هذا التكامل غير متصل بعد',
    en: 'This integration is not connected yet',
    ckb: 'ئەم پەیوەستکردنە هێشتا نەبەستراوە',
  },
};

/** The three-language words of a code, for a client or a notification. */
export function pcWords(code: PcErrorCode): { ar: string; en: string; ckb: string } {
  const w = WORDS[code];
  return { ar: w.ar, en: w.en, ckb: w.ckb };
}

export function pcError(code: PcErrorCode, details: Record<string, unknown> = {}, status?: number): HttpError {
  const w = WORDS[code];
  return new HttpError(status ?? w.status, `${w.ar} / ${w.en}`, code, { ...details, messages: pcWords(code) });
}

/** A field-level validation refusal: `field` names the input, `reason` is machine-readable. */
export function invalid(field: string, reason = 'invalid'): HttpError {
  return pcError('VALIDATION', { field, reason });
}

/** The CHECK constraints whose failure is an answer, and what each means. */
const CHECK_CODES: Record<string, PcErrorCode> = {
  ck_pc_credit_available: 'INSUFFICIENT_CREDIT',
  ck_pc_credit_reserved: 'STATE_CHANGED',
  ck_pc_credit_lot_remaining: 'STATE_CHANGED',
  ck_pc_inventory_available: 'INSUFFICIENT_INVENTORY',
  ck_pc_inventory_reserved: 'STATE_CHANGED',
  ck_pc_inventory_lot_remaining: 'STATE_CHANGED',
  ck_pc_stock_on_hand: 'STOCK_DEFICIT',
  ck_pc_stock_lot_on_hand: 'STOCK_DEFICIT',
  ck_pc_stock_reserved: 'STATE_CHANGED',
  ck_pc_stock_allocated: 'STOCK_DEFICIT',
  ck_pc_promotion_redemptions: 'LIMIT_REACHED',
  ck_pc_order_refund: 'STATE_CHANGED',
  ck_pc_order_line_refund: 'STATE_CHANGED',
};

/** UNIQUE indexes whose collision is an answer (table.column as SQLite names it). */
const UNIQUE_CODES: Array<[RegExp, PcErrorCode]> = [
  [/pc_printer_assignments\.printer_id/, 'PRINTER_BUSY'],
  [/pc_printer_assignments\.job_id/, 'STATE_CHANGED'],
  [/pc_credit_reservations\.job_id/, 'STATE_CHANGED'],
  [/pc_inventory_reservations\./, 'STATE_CHANGED'],
  [/pc_queue_entries\.job_id/, 'STATE_CHANGED'],
  [/pc_shipment_items\.job_id/, 'STATE_CHANGED'],
  [/pc_payments\.order_id/, 'STATE_CHANGED'],
  [/pc_failures\.job_id/, 'STATE_CHANGED'],
  [/pc_slicing_requests\.job_id/, 'STATE_CHANGED'],
  [/pc_\w+_ledger\.entry_key/, 'STATE_CHANGED'],
  [/pc_\w+_lot_draws\./, 'STATE_CHANGED'],
  [/pc_quotes\.|pc_orders\.quote_id/, 'QUOTE_ALREADY_ORDERED'],
];

/** True when the batch collided with an earlier copy of the same idempotent request. */
export function isOperationReplay(e: unknown): boolean {
  return /UNIQUE constraint failed: pc_operations\./.test(e instanceof Error ? e.message : String(e));
}

/**
 * The refusal a database error means, or null when it is not one of ours —
 * in which case the caller rethrows the original error.
 */
export function classifyDbError(e: unknown): HttpError | null {
  const message = e instanceof Error ? e.message : String(e);
  const fence = /PC_FENCE:([A-Z_]+)/.exec(message);
  if (fence) {
    const code = fence[1] as PcErrorCode;
    return pcError(code in WORDS ? code : 'STATE_CHANGED');
  }
  const check = /CHECK constraint failed: (ck_pc_\w+)/.exec(message);
  if (check && CHECK_CODES[check[1]]) return pcError(CHECK_CODES[check[1]], { constraint: check[1] });
  // A natural key someone already holds (a tier code, a SKU, a serial number).
  const natural = /UNIQUE constraint failed: (pc_\w+)\.(code|sku|serial_number|equipment_code|token_hash)\b/.exec(message);
  if (natural) return pcError('VALIDATION', { field: natural[2], reason: 'duplicate' });
  if (/UNIQUE constraint failed: pc_/.test(message)) {
    for (const [re, code] of UNIQUE_CODES) if (re.test(message)) return pcError(code);
    return pcError('STATE_CHANGED');
  }
  if (/PC_APPEND_ONLY/.test(message)) return pcError('FORBIDDEN', { reason: 'append_only' });
  // A Print Cloud write naming a row that does not exist (an unknown tier, model or variant id).
  if (/FOREIGN KEY constraint failed/.test(message)) return pcError('VALIDATION', { reason: 'unknown_reference' });
  // An unnamed CHECK on a pc_ table: a value the schema refuses (dates out of order, a negative amount).
  if (/CHECK constraint failed:/.test(message) && !/ck_(?!pc_)/.test(message)) return pcError('VALIDATION', { reason: 'constraint' });
  return null;
}
