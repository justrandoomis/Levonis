/**
 * «وزن الشاشة الأولى» — what a phone downloads before the first row of
 * products, heaviest first (merchant platform v2 storefront §3.9 / §3.10,
 * §4.5 S4). The rows are the server's audit (worker/lib/storeSpeed.ts
 * `auditWeight`): no visitor is needed, so this list stands even while the
 * real-user figures are still being collected.
 *
 * DataList's row anatomy on one surface (`lv-surface divide-y`): the slot's
 * word and where it sits, its size in figures, and a bar — `h-1.5
 * rounded-full`, the `bg-surface-selected` track, filled in the one accent to
 * an INLINE width (the share of the heaviest row). The slots of one place are
 * one row: a first product row's four pictures are «صور المنتجات (أول صف) ×4».
 * The last row is the fixed weight every store pays — the app and the Arabic
 * font — shown as context in a muted fill and never with a door: it is not
 * the merchant's to change.
 */
import { Fragment, type ReactNode } from 'react';
import { formatBytes } from '../refusal';
import { useSpeedStrings } from '../strings';
import type { FirstViewLabel, LayoutSource, WeightAudit } from './api';

export interface WeightRow {
  /** `label:block` for a slot, `fixed` for the app's own weight. */
  id: string;
  /** null for the fixed row. */
  label: FirstViewLabel | null;
  fixed: boolean;
  /** The measured bytes of the slot's files; null when none of them is measured. */
  bytes: number | null;
  /** How many files the row stands for. */
  count: number;
  /** «GIF», «MP4» — the files' one format, or null when they differ or are unmeasured. */
  format: string | null;
  /** Where the slot is edited (a block id, `header`, `background`); null for the fixed row. */
  blockId: string | null;
}

const FORMATS: Readonly<Record<string, string>> = {
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/svg+xml': 'SVG',
  'video/mp4': 'MP4',
  'video/webm': 'WebM',
  'video/quicktime': 'MOV',
};

/** A file format's name as people know it, from the ledger's mime; null for anything else. */
export function formatOf(mime: string | null | undefined): string | null {
  return (mime && FORMATS[mime.toLowerCase()]) || null;
}

/**
 * The audit as rows: one per slot label and place, heaviest first, the
 * unmeasured after the measured, and the fixed row last.
 */
export function weightRows(audit: WeightAudit): WeightRow[] {
  const groups = new Map<string, WeightRow>();
  for (const it of audit.first_view ?? []) {
    const id = `${it.label_key}:${it.block_id}`;
    const row = groups.get(id) ?? { id, label: it.label_key, fixed: false, bytes: null, count: 0, format: null, blockId: it.block_id || null };
    const format = formatOf(it.mime);
    row.format = row.count === 0 ? format : row.format === format ? format : null;
    row.count += 1;
    if (typeof it.bytes === 'number' && Number.isFinite(it.bytes)) row.bytes = (row.bytes ?? 0) + Math.max(0, it.bytes);
    groups.set(id, row);
  }
  const rows = [...groups.values()].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  const fixedKb = Math.max(0, Number(audit.fixed?.app_kb) || 0) + Math.max(0, Number(audit.fixed?.font_kb) || 0);
  rows.push({ id: 'fixed', label: null, fixed: true, bytes: Math.round(fixedKb * 1024), count: 1, format: null, blockId: null });
  return rows;
}

/** Everything the first screen weighs that was measured, the fixed row included. */
export function weightTotal(rows: readonly WeightRow[]): number {
  return rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
}

/**
 * A row's bar as a percentage of the heaviest row. A file that weighs
 * something keeps a sliver (2%) so it never reads as weighing nothing.
 */
export function barPercent(bytes: number | null, max: number): number {
  if (bytes === null || !(bytes > 0) || !(max > 0)) return 0;
  return Math.min(100, Math.max(2, Math.round((bytes / max) * 1000) / 10));
}

export default function WeightList({
  audit,
  source,
  control,
  blockName,
  renderDoor,
}: {
  audit: WeightAudit;
  source: LayoutSource;
  /** The published | draft switch, when the draft differs from what visitors see. */
  control?: ReactNode;
  /** A layout block's name, to say which section a picture sits in. */
  blockName?: (blockId: string) => string | null;
  /** The row's door («افتح»), or nothing. */
  renderDoor?: (row: WeightRow) => ReactNode;
}) {
  const s = useSpeedStrings();
  const rows = weightRows(audit);
  const max = Math.max(0, ...rows.map((r) => r.bytes ?? 0));
  const measured = rows.some((r) => !r.fixed);
  return (
    <section aria-labelledby="sd-speed-weight" data-speed-weight className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id="sd-speed-weight" className="text-[13px] font-bold text-text-primary">
          {s.weight.title}
        </h3>
        <bdi className="text-[13px] font-bold tabular-nums text-text-primary" data-speed-weight-total>
          {formatBytes(weightTotal(rows))}
        </bdi>
        {control}
      </div>
      <p className="text-[12px] leading-relaxed text-text-muted">{s.weight.lead}</p>
      {source === 'default' && <p className="text-[12px] leading-relaxed text-text-secondary">{s.weight.defaultPage}</p>}
      <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
        {!measured && <li className="px-4 py-3 text-[13px] text-text-muted">{s.weight.none}</li>}
        {rows.map((r) => {
          const where = r.blockId && r.label?.startsWith('block_') ? blockName?.(r.blockId) : null;
          // Which section, the format, how many files: each an isolate, the separators outside
          // them, so «GIF» and «×4» never run into an Arabic word.
          // A count reads «×4» in every language (a direction of its own, not the row's).
          const meta: Array<[text: string, dir: 'ltr' | undefined]> = [];
          if (where) meta.push([where, undefined]);
          if (r.format) meta.push([r.format, 'ltr']);
          if (r.count > 1) meta.push([`×${r.count}`, 'ltr']);
          const door = r.fixed ? null : renderDoor?.(r);
          return (
            <li key={r.id} data-weight-row={r.fixed ? 'fixed' : r.label ?? ''} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-3">
                  <p className={`min-w-0 flex-1 text-[13px] leading-snug ${r.fixed ? 'text-text-secondary' : 'text-text-primary'}`}>
                    {r.fixed ? s.weight.fixed : s.label[r.label!]}
                    {meta.length > 0 && (
                      <span className="text-text-muted" data-weight-meta>
                        {meta.map(([text, dir]) => (
                          <Fragment key={text}>
                            {' · '}
                            <bdi dir={dir} className="tabular-nums">
                              {text}
                            </bdi>
                          </Fragment>
                        ))}
                      </span>
                    )}
                  </p>
                  <bdi className="shrink-0 text-[12.5px] font-semibold tabular-nums text-text-secondary" data-weight-bytes={r.bytes ?? ''}>
                    {r.bytes === null ? s.weight.unmeasured : formatBytes(r.bytes)}
                  </bdi>
                </div>
                <div aria-hidden="true" className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-selected">
                  {r.bytes !== null && (
                    <div data-weight-bar className={`h-full rounded-full ${r.fixed ? 'bg-text-muted' : 'bg-gold'}`} style={{ width: `${barPercent(r.bytes, max)}%` }} />
                  )}
                </div>
              </div>
              {door}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
