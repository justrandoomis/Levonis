/**
 * Phase 4's pure helpers (spec §20, §21, §25): the Baghdad calendar day, the
 * month grid, a carousel's slides grouped by their first slide, and a batch
 * result's state. No React, no request — tests/creativeStudioPlanning.test.ts.
 */
import type { DocumentSummaryDto } from '../../../packages/creativeDoc/src/api';
import type { BuildResult } from '../../../packages/creativeDoc/src/layout';
import type { ProductSnapshot } from '../../../packages/creativeDoc/src/snapshot';
import { TEMPLATES, type TemplateId, type VariantId } from '../../../packages/creativeDoc/src/templates';

/** Asia/Baghdad has been UTC+3 all year since 2008 (no daylight saving). */
const BAGHDAD_OFFSET_MS = 3 * 3600_000;

/** Today's calendar day in Baghdad, 'YYYY-MM-DD'. */
export function baghdadToday(now = Date.now()): string {
  return new Date(now + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
}

/** 'YYYY-MM' of a day, and the month `delta` months away. */
export function monthOf(day: string, delta = 0): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** The first and last day of a month 'YYYY-MM'. */
export function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  return { from, to: addDays(`${monthOf(from, 1)}-01`, -1) };
}

/**
 * The month as weeks of seven cells, the week starting on Saturday as Iraqi
 * calendars do; a cell outside the month is null.
 */
export function monthWeeks(month: string): Array<Array<string | null>> {
  const { from, to } = monthRange(month);
  const lead = (new Date(`${from}T00:00:00Z`).getUTCDay() + 1) % 7; // Saturday = 0
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = from; d <= to; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Saturday … Friday, for the header row. */
export const WEEKDAY_ORDER = [6, 0, 1, 2, 3, 4, 5] as const;

/**
 * Slides grouped into carousels: a slide with no parent starts one, a slide
 * whose parent is in the list joins it; slides keep the order they were made
 * in. A slide whose first slide is not listed starts its own group.
 */
export function carouselGroups(slides: readonly DocumentSummaryDto[]): DocumentSummaryDto[][] {
  const ids = new Set(slides.map((s) => s.id));
  const groups = new Map<string, DocumentSummaryDto[]>();
  const sorted = [...slides].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
  for (const s of sorted) {
    const root = s.parent_id && ids.has(s.parent_id) ? s.parent_id : s.id;
    const g = groups.get(root) ?? [];
    g.push(s);
    groups.set(root, g);
  }
  return [...groups.values()].sort((a, b) => (a[0]!.updated_at < b[0]!.updated_at ? 1 : -1));
}

export type BatchState = 'pending' | 'working' | 'ready' | 'needs_text' | 'missing_asset' | 'price_issue' | 'failed';

/** The variants a template has (its own list: a batch offers no composition the template cannot draw). */
export function templateVariants(template: TemplateId): VariantId[] {
  return Object.keys(TEMPLATES[template].variants) as VariantId[];
}

/**
 * What one batch result needs (spec §21): a price-led composition of an
 * unpriced product is a price issue; a layout that dropped a block or has a
 * conflict needs a text edit; otherwise it is ready for review. A product with
 * no same-site picture is `missing_asset` before anything is built.
 */
export function batchState(template: TemplateId, variant: VariantId, snapshot: ProductSnapshot, result: BuildResult): BatchState {
  const priceLed = TEMPLATES[template].variants[variant]?.priority === 'price';
  if (priceLed && snapshot.data.price.status !== 'priced') return 'price_issue';
  if (result.conflicts.length || result.dropped.length) return 'needs_text';
  return 'ready';
}

/** The next 9 planned designs as a profile grid shows them: the latest date first (top-left). */
export function gridOrder<T extends { planned_for: string }>(items: readonly T[], size = 9): T[] {
  return [...items].sort((a, b) => (a.planned_for < b.planned_for ? -1 : a.planned_for > b.planned_for ? 1 : 0)).slice(0, size).reverse();
}
