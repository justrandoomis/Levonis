/**
 * THE MONEY SECTION'S PRINTED DOCUMENT — one arrangement for the orders report and every statement (the owner, 2026-11-13:
 * «need more improvement of arrangement on pdf and excel of ui ux»; DECISIONS row 334).
 *
 * Top to bottom: a header band (the shop's name, the document's title, its period or person and when it was made); a row
 * of summary boxes, the figures a reader looks for first, the key one marked; then each table — column groups over the
 * header, zebra rows, amounts right-aligned in tabular figures, a negative amount in red, the column the table is about
 * in bold, an adjustment row (the period's general expenses) set apart, the totals last; then the notes and, on a
 * payout, lines to sign. A4 (landscape for wide tables), the header repeated on every page and «n / N» at the foot.
 * The tables are the workbook's own sheets (xlsx.ts), so the Excel and the PDF cannot disagree; every value is escaped.
 */
import type { XlsxSheet } from './xlsx';
import { xmlText } from './xlsx';
import { AUTO_PRINT_SCRIPT } from './securityPolicy';
import { PRINT_FONT_LINK, printBaseCss } from './printDocument';
import type { ReportLang } from './financeOrdersReport';

export interface DocFigure {
  label: string;
  value: number | string | null;
  kind: 'money' | 'int' | 'pct' | 'text';
  /** «key» frames the figure the document is about; «neg» reads red. */
  tone?: 'key' | 'neg';
}

export interface FinanceDocumentInput {
  lang: ReportLang;
  title: string;
  /** The lines under the title: the period or the person, the payment, when it was made. */
  meta: string[];
  figures?: DocFigure[];
  tables: Array<{ caption?: string; sheet: XlsxSheet; newPage?: boolean }>;
  notes?: string[];
  /** Lines to sign at the foot (a payout statement). */
  signatures?: string[];
  printHint: string;
  orientation?: 'landscape' | 'portrait';
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const money = (v: unknown) => (isNum(v) ? v.toLocaleString('en-US') : '');
/** Escaped text with its days and times kept left to right: inside an Arabic line «2026-11-12» would read «12-11-2026». */
export const textHtml = (s: string) => xmlText(s).replace(/\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/g, (m) => `<span dir="ltr">${m}</span>`);
const unit = (lang: ReportLang) => (lang === 'en' ? 'IQD' : 'د.ع');

function figureHtml(f: DocFigure, lang: ReportLang): string {
  const v = f.value;
  const shown = v === null || v === '' ? '—'
    : f.kind === 'money' && isNum(v) ? `<span dir="ltr">${money(v)}</span> <small>${unit(lang)}</small>`
      : f.kind === 'pct' && isNum(v) ? `<span dir="ltr">${(v * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%</span>`
        : f.kind === 'int' && isNum(v) ? `<span dir="ltr">${v.toLocaleString('en-US')}</span>`
          : textHtml(String(v));
  const neg = f.tone === 'neg' || (isNum(v) && v < 0 && f.kind !== 'text');
  return `<div class="fig${f.tone === 'key' ? ' key' : ''}${neg ? ' neg' : ''}"><span>${xmlText(f.label)}</span><strong>${shown}</strong></div>`;
}

function tableHtml(sheet: XlsxSheet): string {
  const strong = new Set(sheet.strong ?? []);
  const numeric = (k: string) => k === 'money' || k === 'int' || k === 'pct';
  const groups = sheet.groups?.length
    ? `<tr class="grp">${sheet.groups.map((g) => `<th scope="colgroup" colspan="${g.span}">${xmlText(g.label)}</th>`).join('')}</tr>` : '';
  const head = `<tr>${sheet.columns.map((c) => `<th scope="col"${numeric(c.kind) ? ' class="n"' : ''}>${xmlText(c.header)}</th>`).join('')}</tr>`;
  const body = sheet.rows.map((r) => `<tr${r.__kind === 'overhead' ? ' class="adj"' : ''}>${sheet.columns.map((c) => {
    const kind = c.kindOf?.(r) ?? c.kind, v = r[c.key];
    if (!numeric(kind)) return `<td${c.key === 'products' ? ' class="products"' : ''}>${textHtml(String(v ?? ''))}</td>`;
    const cls = ['num', isNum(v) && v < 0 ? 'neg' : '', strong.has(c.key) ? 'strong' : ''].filter(Boolean).join(' ');
    return `<td class="${cls}"><span dir="ltr">${money(v)}</span></td>`;
  }).join('')}</tr>`).join('');
  const totals = sheet.totalLabel === undefined ? '' : `<tfoot><tr>${sheet.columns.map((c, j) => {
    if (j === 0) return `<th scope="row">${xmlText(sheet.totalLabel ?? '')}</th>`;
    if (!numeric(c.kind) || c.total === false) return '<td></td>';
    let sum = 0;
    for (const r of sheet.rows) if (isNum(r[c.key])) sum += r[c.key] as number;
    return `<td class="num${sum < 0 ? ' neg' : ''}"><span dir="ltr">${money(sum)}</span></td>`;
  }).join('')}</tr></tfoot>`;
  return `<table><thead>${groups}${head}</thead><tbody>${body}</tbody>${totals}</table>`;
}

/** The document, stand-alone (asDocument): the one hashed script opens the print dialog, where «Save as PDF» is the PDF. */
export function financeDocumentHtml(input: FinanceDocumentInput): string {
  const { lang } = input, dir = lang === 'en' ? 'ltr' : 'rtl', landscape = (input.orientation ?? 'landscape') === 'landscape';
  const wide = input.tables.some((t) => t.sheet.columns.length > 10);
  const parts = input.tables.map((t) => `${t.newPage ? '<div class="page-break"></div>' : ''}<section class="part">${t.caption ? `<h2>${xmlText(t.caption)}</h2>` : ''}${tableHtml(t.sheet)}</section>`).join('');
  const figures = input.figures?.length ? `<section class="figs">${input.figures.map((f) => figureHtml(f, lang)).join('')}</section>` : '';
  const notes = input.notes?.length ? `<section class="notes">${input.notes.map((n) => `<p>${textHtml(n)}</p>`).join('')}</section>` : '';
  const sign = input.signatures?.length ? `<section class="sign">${input.signatures.map((s) => `<div><span>${xmlText(s)}</span><i></i></div>`).join('')}</section>` : '';
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${xmlText(input.title)}</title>${PRINT_FONT_LINK}<style>${printBaseCss(10)}
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 10mm 9mm 13mm;
    @bottom-center { content: counter(page) " / " counter(pages); font-size: 8pt; color: #6b7280; } }
  .doc { color: #14161a; }
  .doc-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; border-bottom: 2px solid #1f2937; padding-bottom: 6px; }
  .brand { font-size: 10px; font-weight: 800; color: #1f2937; }
  h1 { font-size: 16px; margin: 0; }
  .meta { margin: 3px 0 0; font-size: 9.5px; color: #4b5563; }
  .meta span + span::before { content: " · "; color: #9ca3af; }
  .no-print { margin: 6px 0 0; font-size: 9px; color: #6b7280; }
  .figs { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 6px; margin: 10px 0 4px; }
  .fig { border: 1px solid #d5dbe2; border-radius: 4px; padding: 5px 8px; break-inside: avoid; }
  .fig > span { display: block; font-size: 8.5px; color: #4b5563; }
  .fig strong { display: block; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .fig strong small { font-size: 8px; font-weight: 600; color: #6b7280; }
  .fig.key { border-color: #1f2937; background: #f3f5f8; }
  .fig.neg strong { color: #b42318; }
  h2 { font-size: 12px; margin: 12px 0 0; }
  table { font-size: ${wide ? '8.5' : '9.5'}px; margin-top: 8px; }
  th, td { border: 1px solid #d5dbe2; padding: 3px 5px; text-align: start; vertical-align: top; }
  thead tr.grp th { background: #d9e1e9; text-align: center; font-weight: 800; }
  thead th { background: #eef2f6; font-weight: 700; vertical-align: bottom; }
  thead th.n { text-align: end; }
  tbody tr:nth-child(even) td { background: #f7f9fb; }
  tbody tr.adj td { background: #fff7e6; font-style: italic; }
  td.num { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.neg, .neg { color: #b42318; }
  td.strong { font-weight: 800; }
  td.products { max-width: 230px; }
  tfoot th, tfoot td { font-weight: 800; background: #eef2f6; border-top: 2px solid #374151; }
  .page-break { break-before: page; }
  .notes { margin-top: 8px; }
  .notes p { margin: 0 0 2px; font-size: 8.5px; color: #4b5563; }
  .sign { display: grid; grid-template-columns: repeat(${Math.max(1, input.signatures?.length ?? 1)}, 1fr); gap: 28px; margin-top: 26px; break-inside: avoid; }
  .sign span { font-size: 9px; color: #4b5563; }
  .sign i { display: block; height: 30px; border-bottom: 1px solid #6b7280; }
  @media screen { .doc { background: #fff; max-width: ${landscape ? 1180 : 820}px; margin: 0 auto; padding: 18px 20px 24px; border: 1px solid #d5dbe2; } }
</style></head><body><main class="doc">
<header class="doc-head"><div><h1>${xmlText(input.title)}</h1><p class="meta">${input.meta.map((m) => `<span>${textHtml(m)}</span>`).join('')}</p></div><div class="brand" dir="ltr">LEVONIS</div></header>
<p class="no-print">${xmlText(input.printHint)}</p>
${figures}${parts}${notes}${sign}
</main><script>${AUTO_PRINT_SCRIPT}</script></body></html>`;
}
