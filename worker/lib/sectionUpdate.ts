/**
 * «تحديث البيانات» — A SAVED PRODUCT'S SPECS AND EXTRA CONTENT, FROM A FILE.
 *
 * The owner (2026-09-27): «بالإمكان تحديث بيانات المنتج المحفوظ سابقًا من خلال
 * تنزيل قالب المنتج، ورفع القالب الجديد … يبدأ بمقارنة الحقول المتغيرة … زر
 * للحفظ (التغييرات في قسم المواصفات والمحتوى الإضافي فقط) لا يلمس البيانات
 * للأقسام الأخرى».
 *
 * ONE SECTION, ENFORCED ON THE SERVER. Section 7 of the product form —
 * «المواصفات والمحتوى الإضافي» — is the spec sheet (`spec.<id>`), the spec
 * groups, the labels, the content blocks, the usage guide's steps and link,
 * the free usage text, and the printers a part fits (`fits_printers`, 0148). A file may carry anything (the full export, an old
 * file, a spreadsheet); every line outside those keys is dropped here, BEFORE
 * the text reaches the template parser, so no price, option, colour, picture,
 * name or placement can change through this door whatever the file says. The
 * lines dropped are returned, so the preview can name them.
 *
 * THE SAME PARSER, THE SAME WRITER. What survives is an ordinary TXT update of
 * the product — `product_id` and the stale guard are written here, never taken
 * from the file — so the merge rules (a key the file omits keeps its value;
 * `__CLEAR__` clears), the validation and the audit are the ones every TXT
 * apply already has.
 *
 * TXT OR CSV. The spreadsheet form is two columns, `key,value`, one row per
 * line of the TXT; a value with line breaks is one quoted cell, written back
 * as a heredoc. It round-trips through Excel and Numbers: a cell a spreadsheet
 * would read as a formula is exported with a leading `'` (worker/lib/importCsv.ts
 * `toCsv`), and that one quote is taken off again on the way in.
 */
import { parseCsv, toCsv } from './importCsv';

export interface TemplateEntry {
  key: string;
  value: string;
  line: number;
}

/** The parser's own grammar (worker/lib/template.ts KEY_RE / HEREDOC_TOKEN_RE). */
const KEY_RE = /^([A-Za-z0-9_.]+)\s*=(.*)$/;
const HEREDOC_TOKEN_RE = /^[A-Za-z0-9_]{1,40}$/;

/** Every `key=value` of a TXT template, heredocs whole, comments and blanks skipped. */
export function scanTemplate(text: string): { entries: TemplateEntry[]; malformed: Array<{ line: number; text: string }> } {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const entries: TemplateEntry[] = [];
  const malformed: Array<{ line: number; text: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    i++;
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = KEY_RE.exec(trimmed);
    if (!m) {
      malformed.push({ line: lineNo, text: trimmed.slice(0, 80) });
      continue;
    }
    let value = m[2].trim();
    if (value.startsWith('<<<')) {
      const token = value.slice(3).trim() || 'END';
      if (!HEREDOC_TOKEN_RE.test(token)) {
        malformed.push({ line: lineNo, text: trimmed.slice(0, 80) });
        continue;
      }
      const collected: string[] = [];
      let terminated = false;
      while (i < lines.length) {
        const l = lines[i];
        i++;
        if (l.trim() === token) {
          terminated = true;
          break;
        }
        collected.push(l);
      }
      if (!terminated) {
        malformed.push({ line: lineNo, text: `${m[1]}=<<<${token} …` });
        continue;
      }
      value = collected.join('\n');
    }
    entries.push({ key: m[1], value, line: lineNo });
  }
  return { entries, malformed };
}

/** Section 7's repeatable groups (`group.N.…`, and `group=__CLEAR__`). */
export const SECTION_GROUPS = ['spec_groups', 'labels', 'content_blocks', 'usage_steps'] as const;
/**
 * Section 7's single keys. `how_to_use` is the importer's old spelling of
 * `how_to_use_en`. `fits_printers` (0148) is the «يناسب الطابعات» picker at
 * the top of the same section — links, not a document field, so the preview
 * compares it on its own and the apply writes it through the save's batch.
 */
export const SECTION_SCALARS = ['how_to_use', 'how_to_use_ar', 'how_to_use_en', 'how_to_use_ckb', 'usage_official_url', 'fits_printers'] as const;

/** Whether a template key belongs to «المواصفات والمحتوى الإضافي». */
export function isSectionKey(key: string): boolean {
  if (key.startsWith('spec.') && key.length > 'spec.'.length) return true;
  if ((SECTION_SCALARS as readonly string[]).includes(key)) return true;
  const group = key.split('.')[0];
  if (!(SECTION_GROUPS as readonly string[]).includes(group)) return false;
  return key === group || /^[a-z_]+\.\d+\./.test(key);
}

/** A heredoc delimiter the value itself never contains on a line of its own. */
function heredocToken(value: string): string {
  const lines = new Set(value.split('\n').map((l) => l.trim()));
  let token = 'END';
  for (let n = 1; lines.has(token); n++) token = `END_${n}`;
  return token;
}

// A value that would itself read as a heredoc opener is written as one too.
const writeEntry = (key: string, value: string) =>
  value.includes('\n') || value.trimStart().startsWith('<<<')
    ? `${key}=<<<${heredocToken(value)}\n${value}\n${heredocToken(value)}`
    : `${key}=${value}`;

/**
 * The file as this door applies it: the header written HERE (the product and,
 * when given, the moment the preview read it), then the section's lines in
 * file order. Everything else is returned as `ignored`.
 */
export function sectionTemplate(
  text: string,
  productId: string,
  expectedUpdatedAt: string | null,
  /** A comment written above a key — the spec field's own name, for the downloaded file. */
  notes: ReadonlyMap<string, string> = new Map()
): {
  text: string;
  kept: TemplateEntry[];
  ignored: TemplateEntry[];
  malformed: Array<{ line: number; text: string }>;
} {
  const { entries, malformed } = scanTemplate(text);
  const header = new Set(['template_version', 'product_id', 'expected_updated_at', 'allow_slug_change', 'slug']);
  const kept = entries.filter((e) => isSectionKey(e.key));
  const ignored = entries.filter((e) => !isSectionKey(e.key) && !header.has(e.key));
  const lines = [
    '# «تحديث البيانات» — المواصفات والمحتوى الإضافي فقط / Specifications & extras only',
    '# الأسطر التي تبدأ بـ # تعليقات. حقل تحذفه من الملف يبقى كما هو؛ __CLEAR__ يمسحه.',
    '# Any other line (price, options, colours, pictures, names…) is ignored by this door.',
    'template_version=2',
    `product_id=${productId}`,
    ...(expectedUpdatedAt ? [`expected_updated_at=${expectedUpdatedAt}`] : []),
    ...kept.flatMap((e) => {
      const note = notes.get(e.key);
      return note ? [`# ${note}`, writeEntry(e.key, e.value)] : [writeEntry(e.key, e.value)];
    }),
  ];
  return { text: `${lines.join('\n')}\n`, kept, ignored, malformed };
}

/** The spreadsheet form of a template: `key,value`, one row per line. */
export function templateTextToCsv(text: string): string {
  const { entries } = scanTemplate(text);
  const rows = [['key', 'value'], ...entries.map((e) => [e.key, e.value])];
  return `\uFEFF${toCsv(rows)}\r\n`;
}

/** A cell our own export defused (`'=…`, `'+…`) — the quote goes, the text stays. */
const undefuse = (cell: string) => (/^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell);

/**
 * `key,value` rows back into template text. A first row that names the two
 * columns is the header; an empty key, or one starting with `#`, is skipped.
 */
export function csvToTemplateText(csv: string): { text: string; errors: string[] } {
  const rows = parseCsv(csv);
  const errors: string[] = [];
  const out: string[] = [];
  rows.forEach((row, index) => {
    const key = (row[0] ?? '').trim();
    const value = undefuse(row[1] ?? '');
    if (index === 0 && key.toLowerCase() === 'key' && (row[1] ?? '').trim().toLowerCase() === 'value') return;
    if (!key || key.startsWith('#')) return;
    if (!/^[A-Za-z0-9_.]+$/.test(key)) {
      errors.push(`CSV row ${index + 1}: "${key.slice(0, 60)}" is not a template key`);
      return;
    }
    out.push(writeEntry(key, value.replace(/\r\n?/g, '\n')));
  });
  return { text: `${out.join('\n')}\n`, errors };
}

/** Section 7's fields on the product document. */
export const SECTION_DOC_KEYS = [
  'spec_fields',
  'spec_groups',
  'labels',
  'content_blocks',
  'usage_guide',
  'how_to_use',
  'how_to_use_ar',
  'how_to_use_ckb',
] as const;

/**
 * THE DOCUMENT THIS DOOR WRITES: the stored product, with ONLY section 7 taken
 * from the merge — and the translation bookkeeping, which describes those very
 * texts. A TXT update otherwise writes the whole merged document, and the
 * merge applies store-wide defaults on the way (a printer's warranty base and
 * serial tracking, worker/routes/template.ts `applyPrinterWarrantyRules`):
 * right for an import, a change to section 4 here. So every other field is
 * the stored one, whatever the merge made of it.
 */
export function sectionOnlyDoc<T extends object>(merged: T, stored: T): T {
  const out = { ...stored } as Record<string, unknown>;
  const from = merged as Record<string, unknown>;
  for (const key of [...SECTION_DOC_KEYS, 'content_rev', 'translation_meta']) {
    if (key in from) out[key] = from[key];
  }
  return out as T;
}
