/**
 * THE JOB SUMMARY (Bambu import spec §H.3, §I.3; written after every product).
 *
 * Counts only. The §H.3 progress fields come from `/run/status` (D1
 * aggregates). A SHAPE IS NOT ENOUGH: a hidden product's slug has the shape of
 * a handle, a draft SKU the shape of a code, an inactive catalog's key the
 * shape of a reason. So nothing the Worker writes is printed as text: a count
 * is a whole number; the current product is the REVIEWED manifest's handle of
 * the item `/run/status` names by source id (never the Worker's own text); a
 * code is one of the fixed §B.5 codes; a stage is one of the seven stages; a
 * reason or finance key is one of its fixed list; a public product URL is
 * `<site>/product/<slug>` of a COMPLETE item. Anything else prints as "-".
 * No name, no id, no source URL, no conflict text.
 *
 * WORDING (§I.3): the summary says "partial" and names the exact BLOCKED and
 * WITHDRAWN items when any exists, and the items the reviewed manifest holds
 * (end-of-queue holds: never counted as open work). A hold still queued is
 * not a block: it is listed under an "in progress" headline until it blocks
 * at its turn or the close finds it (/run/finish then closes the run partial).
 * It never says «تم» or "100 %": completion is
 * stated as a count ("1,115 of 1,115 complete") and only when the counts prove
 * it.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { ImportLog } from './log';
import { BLOCKER_CODES, TRANSIENT_CODES, type StatusAnswer } from './opsClient';

export const PROGRESS_FIELDS = [
  'discovered_total',
  'queued_total',
  'complete_count',
  'current_product',
  'blocked_count',
  'withdrawn_count',
  'remaining_count',
  'created_count',
  'updated_existing_count',
  'deduplicated_references',
  'category_links',
  'subcategory_links',
  'option_count',
  'variant_count',
  'color_count',
  'saved_media_count',
  'linked_variant_media_count',
  'failed_media_count',
  'extracted_specs_count',
  'verified_specs_count',
  'missing_info_by_reason',
  'document_count',
  'tds_count',
  'sds_count',
  'public_product_url',
  'failed_stage',
  'attempts',
  'blocker',
  'resumption_instruction',
  'finance_protection',
] as const;

/** The dashboard's resume sentence (§H.2), in the three languages. */
export const RESUME_INSTRUCTION = {
  ar: 'لاستئناف هذا المنتج: عالج السبب أعلاه ثم شغّل سير العمل 60 بوضع run مع resume.',
  en: 'To resume this product: fix the cause above, then run workflow 60 in run mode with resume.',
  ckb: 'بۆ دەستپێکردنەوەی ئەم بەرهەمە: هۆکارەکەی سەرەوە چارەسەر بکە، پاشان ڕێڕەوی کاری 60 بە دۆخی run لەگەڵ resume کار پێبکە.',
} as const;

const HEADLINES = {
  running: { en: 'Bambu Lab import: in progress', ar: 'استيراد Bambu Lab: جارٍ', ckb: 'هاوردەکردنی Bambu Lab: بەردەوامە' },
  partial: { en: 'Bambu Lab import: partial', ar: 'استيراد Bambu Lab: جزئي', ckb: 'هاوردەکردنی Bambu Lab: بەشێکی' },
  closed: { en: 'Bambu Lab import: closed', ar: 'استيراد Bambu Lab: مُغلق', ckb: 'هاوردەکردنی Bambu Lab: داخراوە' },
} as const;

/** The codes a summary names: §B.5's blockers and transients, and the few the runner and the Worker add. */
export const SUMMARY_CODES: ReadonlySet<string> = new Set([...BLOCKER_CODES, ...TRANSIENT_CODES, 'BLOCKED', 'UNCLASSIFIED', 'DEADLINE_EXIT']);
/** The seven working stages (run.ts STAGES): `failed_stage` is one of them. */
export const SUMMARY_STAGES: ReadonlySet<string> = new Set(['EXTRACTING', 'ENRICHING', 'VALIDATING', 'INGESTING_MEDIA', 'WRITING', 'PUBLISHING', 'VERIFYING_LIVE']);
/** `missing_info_by_reason` keys: the payload's `missing_reason` values (§C.6), and the Worker's name for none. */
export const MISSING_REASONS: ReadonlySet<string> = new Set(['not_found_in_checked_sources', 'not_published_by_manufacturer', 'not_applicable', 'unspecified']);
/** `finance_protection` keys (§H.3 "Finance protection"), one nested level read as `<key>.<phase>`. */
export const FINANCE_KEYS: ReadonlySet<string> = new Set([
  'guard_hits',
  'write_equal',
  'write_unequal',
  'stock_not_configured',
  'snapshots.before',
  'snapshots.after',
  'snapshots.write',
]);
const code = (v: unknown): string => (typeof v === 'string' && SUMMARY_CODES.has(v) ? v : '');
const count = (v: unknown): string => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v.toLocaleString('en-US') : '-');

export interface SummaryItem {
  position: number;
  handle: string;
  outcome: 'complete' | 'blocked' | 'retrying' | 'deadline' | 'withdrawn';
  code?: string;
  url?: string;
}

export interface SummaryInput {
  mode: string;
  runId: string;
  siteOrigin: string;
  status: StatusAnswer | null;
  /** The reviewed manifest's handle of a source product id (null when the id is not in it). */
  handleOf?: (sourceProductId: string) => string | null;
  /** This job's items, in order. */
  items: readonly SummaryItem[];
  /** BLOCKED and WITHDRAWN items of the whole run (handles and codes), when known. */
  blocked: ReadonlyArray<{ handle: string; code: string }>;
  withdrawn: readonly string[];
  /**
   * Items the reviewed manifest holds (`/run/status` and `/run/finish` `held`), named by the reviewed manifest's
   * handle and hold code: never open work, always named, and the run that ends with them is partial (the close's
   * `closedState`); while the run goes on they make nothing partial.
   */
  held?: ReadonlyArray<{ handle: string; code: string }>;
  more: boolean;
  closedState?: string;
}

export function renderSummary(inp: SummaryInput): string {
  const log = new ImportLog(() => {}, { siteOrigin: inp.siteOrigin });
  const counts = inp.status?.counts ?? {};
  const progress = inp.status?.progress ?? {};
  const complete = typeof progress.complete_count === 'number' ? progress.complete_count : counts.COMPLETE;
  const blockedCount = typeof progress.blocked_count === 'number' ? progress.blocked_count : counts.BLOCKED ?? inp.blocked.length;
  const withdrawnCount = typeof progress.withdrawn_count === 'number' ? progress.withdrawn_count : counts.WITHDRAWN_AT_SOURCE ?? inp.withdrawn.length;
  const total = typeof progress.discovered_total === 'number' ? progress.discovered_total : Object.values(counts).reduce((a, b) => a + b, 0);
  const held = inp.held ?? [];
  // A hold still queued is not a block: it blocks at its turn (blocked_count), or the close finds it and /run/finish
  // closes the run partial (closedState). Until then the run is in progress and the hold is only listed.
  const partial = (typeof blockedCount === 'number' && blockedCount > 0) || (typeof withdrawnCount === 'number' && withdrawnCount > 0) || inp.closedState === 'partial';
  const headline = inp.closedState === 'closed' && !partial ? HEADLINES.closed : partial ? HEADLINES.partial : HEADLINES.running;
  const lines: string[] = [`## ${headline.en} — ${headline.ar} — ${headline.ckb}`, ''];
  lines.push(`Mode \`${/^[a-z]+$/.test(inp.mode) ? inp.mode : '-'}\`, run \`${/^cir_[0-9a-f]{24}$/.test(inp.runId) ? inp.runId : '-'}\`.`);
  if (typeof complete === 'number' && total > 0) lines.push(`${count(complete)} of ${count(total)} items complete.`);
  if (partial) lines.push('The run is **partial**: the items below — BLOCKED, withdrawn at the source, or held by the reviewed manifest — are named here.');
  if (held.length) lines.push(`${count(held.length)} items are held by the reviewed manifest (an owner decision is pending): they are not open work, and are named below.`);
  lines.push('', '| field | value |', '|---|---|');
  for (const field of PROGRESS_FIELDS) {
    const v = progress[field];
    let shown = '-';
    if (field === 'current_product') {
      // The Worker's own text (its `current_product`, `current.handle`) is never printed: only the reviewed handle of the id.
      const sid = inp.status?.current?.source_product_id ?? '';
      const reviewed = sid && inp.handleOf ? inp.handleOf(sid) : null;
      shown = reviewed ? ImportLog.handle(reviewed) : '-';
    } else if (field === 'public_product_url') shown = log.liveUrl(v) ?? log.liveUrl(inp.status?.last_verified_url) ?? '-';
    else if (field === 'failed_stage') shown = typeof v === 'string' && SUMMARY_STAGES.has(v) ? v : '-';
    else if (field === 'blocker') shown = code(v) || '-';
    else if (field === 'resumption_instruction') shown = partial || blockedCount ? RESUME_INSTRUCTION.en : '-';
    else if (field === 'missing_info_by_reason') shown = listed(v, MISSING_REASONS);
    else if (field === 'finance_protection') shown = listed(v, FINANCE_KEYS);
    else if (field === 'complete_count') shown = count(complete);
    else if (field === 'blocked_count') shown = count(blockedCount);
    else if (field === 'withdrawn_count') shown = count(withdrawnCount);
    else if (field === 'discovered_total') shown = total ? count(total) : '-';
    else shown = count(v);
    lines.push(`| ${field} | ${shown} |`);
  }
  if (inp.items.length) {
    lines.push('', '### This job', '', '| # | handle | outcome | code | public page |', '|---|---|---|---|---|');
    for (const it of inp.items) {
      lines.push(`| ${count(it.position)} | ${ImportLog.handle(it.handle)} | ${it.outcome} | ${code(it.code)} | ${it.outcome === 'complete' ? log.liveUrl(it.url) ?? '' : ''} |`);
    }
  }
  if (inp.blocked.length || inp.withdrawn.length) {
    lines.push('', '### BLOCKED and withdrawn items');
    for (const b of inp.blocked) lines.push(`- BLOCKED \`${ImportLog.handle(b.handle)}\` ${code(b.code)}`);
    for (const w of inp.withdrawn) lines.push(`- WITHDRAWN_AT_SOURCE \`${ImportLog.handle(w)}\``);
    lines.push('', `${RESUME_INSTRUCTION.ar}`, `${RESUME_INSTRUCTION.en}`, `${RESUME_INSTRUCTION.ckb}`);
  }
  if (held.length) {
    lines.push('', '### Held by the reviewed manifest');
    for (const h of held) lines.push(`- HELD \`${ImportLog.handle(h.handle)}\` ${code(h.code)}`);
  }
  lines.push('', `More to do: ${inp.more ? 'yes' : 'no'}.`);
  return `${lines.join('\n')}\n`;
}

/** `{key: count | boolean}` (one nested level as `key.sub`), only the keys of the fixed list, as "key n, …". */
function listed(v: unknown, keys: ReadonlySet<string>): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '-';
  const flat: Array<[string, unknown]> = [];
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (n && typeof n === 'object' && !Array.isArray(n)) for (const [sub, m] of Object.entries(n as Record<string, unknown>)) flat.push([`${k}.${sub}`, m]);
    else flat.push([k, n]);
  }
  return (
    flat
      .filter(([k, n]) => keys.has(k) && (typeof n === 'number' || typeof n === 'boolean'))
      .map(([k, n]) => `${k} ${typeof n === 'boolean' ? (n ? 'yes' : 'no') : count(n)}`)
      .join(', ') || '-'
  );
}

/** The summary file is rewritten after every product: the newest counts replace the previous ones. */
export class SummaryWriter {
  private baseline = '';

  constructor(private readonly path: string | undefined) {}

  /** Text other steps wrote before the importer: kept above ours. */
  begin(existing: string): void {
    this.baseline = existing;
  }

  write(text: string): void {
    if (!this.path) return;
    writeFileSync(this.path, `${this.baseline}${text}`);
  }

  append(text: string): void {
    if (this.path) appendFileSync(this.path, text);
  }
}
