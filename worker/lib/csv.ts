/**
 * A CSV THE MERCHANT DOWNLOADS — one way of saying it (merchant platform v2
 * §4.2, CSV export).
 *
 * The catalogue export (worker/routes/merchantCatalog.ts `/products/export.csv`)
 * had the shape right and kept it to itself: `toCsv`'s quoting and formula
 * defusing, a UTF-8 BOM so Excel opens Arabic as Arabic rather than as
 * mojibake, and an attachment filename. The orders export needed the same
 * three lines, so they live here and both say it identically.
 *
 * `private, no-store`: every CSV served this way is one merchant's own data,
 * read under their session — nothing in front of the Worker may keep it.
 */
import { toCsv } from './importCsv';

/** The most rows one export carries; a bigger range is asked for in pieces. */
export const CSV_MAX_ROWS = 5000;

/** A filename the `Content-Disposition` grammar accepts without quoting games. */
export function csvFilename(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|_+$/g, '');
  const base = safe || 'export';
  return base.toLowerCase().endsWith('.csv') ? base : `${base}.csv`;
}

export function csvResponse(rows: string[][], filename: string): Response {
  return new Response('\uFEFF' + toCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename(filename)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
