/**
 * ONE READING OF EVERY IMPORT COMPLAINT, whichever lane produced it.
 *
 * The three import formats answer in three different shapes:
 *
 *   CSV / ZIP  →  `errors: string[]` per row, each already prefixed by the
 *                 parser with `سطر N: ` and usually by the offending column
 *                 (`image: "a.png" غير موجود…`, `hex: "#zz" ليس…`).
 *   TXT        →  `errors: [{ line, key, message }]` — already structured.
 *   ZIP of TXT →  the same, once per file.
 *
 * The panel has to show ONE validation report over all of them, and the owner
 * asked for a specific breakdown: how many products, what is wrong, which
 * fields are missing, which images are missing, what is duplicated — each
 * naming the product and the line. So every complaint is normalised here,
 * once, into `{ product, line, field, code, message }`.
 *
 * WHY THE FIELD IS READ FROM THE TEXT AND NOT GUESSED. The importer builds its
 * messages as `${column}: …`, so the column is genuinely in the string. The
 * leading token is accepted as a field ONLY when it looks like a column name
 * (ASCII identifier) or is literally one of the file's own columns, which the
 * preview response hands us. An Arabic prefix — `المنتج: سعر PRIME أعلى…`,
 * `الخيار Large: …` — is a PLACE, not a column, and is deliberately left in
 * the message rather than reported as a field that does not exist.
 *
 * WHY THE CODE IS A CLASSIFICATION AND NOT A SERVER FLAG. Adding a code to the
 * importer would mean touching forty validation sites in code the owner asked
 * to leave alone. The classification is a DISPLAY grouping: every issue is
 * still listed in full under "الأخطاء", so a misfiled one is mis-grouped, never
 * hidden. tests/importIssues.test.ts runs the importer's real message corpus
 * through it, so the grouping is checked against the strings that actually
 * ship rather than against strings I imagined.
 */

/** What kind of complaint this is — the owner's four buckets. */
export type IssueCode = 'missing' | 'image' | 'duplicate' | 'invalid';

export interface ImportIssue {
  /** The product this belongs to: the CSV `key`, or the .txt file name. */
  product: string | null;
  /** Line inside the file, when the parser knew one. */
  line: number | null;
  /** The column / template key at fault, when the message names one. */
  field: string | null;
  /** The complaint, with the line prefix stripped (the line is shown separately). */
  message: string;
  code: IssueCode;
  severity: 'error' | 'warning';
}

/** `سطر 12: image: "a.png" غير موجود` → line 12, rest. */
const LINE_PREFIX = /^\s*(?:سطر|line)\s*(\d+)\s*[:：]\s*/;
/** A column name looks like this; Arabic prefixes deliberately do not match. */
const FIELD_TOKEN = /^([A-Za-z_][A-Za-z0-9_.]*)\s*[:：]\s*/;

/**
 * Row types are named at the head of several messages and are NOT columns:
 * `spec: "الأبعاد" مكررة` is about a spec ROW, not a column called spec.
 *
 * `image` is deliberately absent: the image resolver builds its messages as
 * `image: "…"` where `image` really is the column that held the unresolved
 * cell, and excluding it would lose the one field the owner most wants named.
 */
const ROW_TYPES = new Set([
  'product', 'option', 'color', 'variant', 'transport',
  'spec', 'label', 'warranty', 'content', 'guide',
]);

/**
 * The classification. Order matters: an unresolved image reference is an image
 * problem even though its message also says "غير موجود", and a duplicate is a
 * duplicate even when the thing duplicated is a field value.
 */
export function classify(field: string | null, message: string): IssueCode {
  // "أكثر من صورة رئيسية" is a duplicate too — one product, two rows claiming the same slot.
  if (/مكرر|أكثر من|duplicate/i.test(message)) return 'duplicate';
  if (field === 'image' || /صورة|صور|image/i.test(message)) {
    // Only an image that could not be RESOLVED counts as a missing image; a
    // complaint about too many main images is a duplicate (caught above) and a
    // limit on step pictures is an ordinary invalid.
    if (field === 'image' || /غير موجود|تعذّر|not found|missing/i.test(message)) return 'image';
  }
  if (/فارغ|مطلوب|يحتاج|لا يوجد|لا توجد|بلا |required|missing|is empty/i.test(message)) return 'missing';
  return 'invalid';
}

/**
 * Reads one CSV/ZIP complaint string into the shared shape.
 *
 * @param columns the file's own columns, from the preview response — they let
 *   a bare leading `name فارغ` / `price_iqd مطلوب` be attributed to its field.
 */
export function readIssueText(
  raw: string,
  opts: { product?: string | null; severity?: 'error' | 'warning'; columns?: readonly string[]; line?: number | null } = {}
): ImportIssue {
  const severity = opts.severity ?? 'error';
  let rest = raw;
  let line: number | null = opts.line ?? null;

  const lm = LINE_PREFIX.exec(rest);
  if (lm) {
    line = parseInt(lm[1], 10);
    rest = rest.slice(lm[0].length);
  }

  let field: string | null = null;
  const fm = FIELD_TOKEN.exec(rest);
  if (fm && !ROW_TYPES.has(fm[1])) {
    field = fm[1];
    rest = rest.slice(fm[0].length);
  } else if (opts.columns && opts.columns.length > 0) {
    // `name فارغ` — the column is there, just not followed by a colon.
    const head = /^([A-Za-z_][A-Za-z0-9_.]*)\s/.exec(rest);
    if (head && opts.columns.includes(head[1])) field = head[1];
  }

  return {
    product: opts.product ?? null,
    line,
    field,
    message: rest.trim() || raw.trim(),
    code: classify(field, raw),
    severity,
  };
}

/** The TXT lanes already answer structurally; this only classifies. */
export function readIssueEntry(
  entry: { line?: number; key?: string; message: string },
  opts: { product?: string | null; severity?: 'error' | 'warning' } = {}
): ImportIssue {
  const field = entry.key && entry.key.trim() ? entry.key.trim() : null;
  return {
    product: opts.product ?? null,
    line: typeof entry.line === 'number' && entry.line > 0 ? entry.line : null,
    field,
    message: entry.message,
    code: classify(field, `${field ?? ''} ${entry.message}`),
    severity: opts.severity ?? 'error',
  };
}

export interface IssueBuckets {
  /** Every blocking complaint, in the order the file produced them. */
  errors: ImportIssue[];
  /** Errors that say a required field or row is absent. */
  missing: ImportIssue[];
  /** Image cells that resolved to nothing. */
  images: ImportIssue[];
  /** Keys, combinations, plans or specs repeated inside the file. */
  duplicates: ImportIssue[];
  /** Non-blocking notes. */
  warnings: ImportIssue[];
}

/** Splits a flat issue list into the buckets the report card renders. */
export function bucketise(issues: readonly ImportIssue[]): IssueBuckets {
  const errors = issues.filter((i) => i.severity === 'error');
  return {
    errors,
    missing: errors.filter((i) => i.code === 'missing'),
    images: errors.filter((i) => i.code === 'image'),
    duplicates: errors.filter((i) => i.code === 'duplicate'),
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}

/** `المنتج ABC · سطر 12 · الحقل price_iqd` — the locator shown before a message. */
export function issueWhere(i: ImportIssue, t: { product: string; line: string; field: string }): string {
  const parts: string[] = [];
  if (i.product) parts.push(`${t.product} ${i.product}`);
  if (i.line !== null) parts.push(`${t.line} ${i.line}`);
  if (i.field) parts.push(`${t.field} ${i.field}`);
  return parts.join(' · ');
}
