/**
 * THE JOB SUMMARY (Bambu import spec §H.3, §I.3; written after every product).
 *
 * Counts only. The §H.3 progress fields come from `/run/status` (D1
 * aggregates); every value is printed only when it has its field's shape: a
 * count is a whole number, a code is a code, the current product is a store
 * handle, a public product URL is `<site>/product/<slug>` of a COMPLETE item.
 * Anything else prints as "-". No name, no id, no source URL, no conflict text.
 *
 * WORDING (§I.3): the summary says "partial" and names the exact BLOCKED and
 * WITHDRAWN items when any exists. It never says «تم» or "100 %": completion is
 * stated as a count ("1,115 of 1,115 complete") and only when the counts prove
 * it.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { ImportLog } from './log';
import type { StatusAnswer } from './opsClient';

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

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const STAGE = /^[A-Z_]{3,32}$/;
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
  /** This job's items, in order. */
  items: readonly SummaryItem[];
  /** BLOCKED and WITHDRAWN items of the whole run (handles and codes), when known. */
  blocked: ReadonlyArray<{ handle: string; code: string }>;
  withdrawn: readonly string[];
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
  const partial = (typeof blockedCount === 'number' && blockedCount > 0) || (typeof withdrawnCount === 'number' && withdrawnCount > 0) || inp.closedState === 'partial';
  const headline = inp.closedState === 'closed' && !partial ? HEADLINES.closed : partial ? HEADLINES.partial : HEADLINES.running;
  const lines: string[] = [`## ${headline.en} — ${headline.ar} — ${headline.ckb}`, ''];
  lines.push(`Mode \`${/^[a-z]+$/.test(inp.mode) ? inp.mode : '-'}\`, run \`${/^cir_[0-9a-f]{24}$/.test(inp.runId) ? inp.runId : '-'}\`.`);
  if (typeof complete === 'number' && total > 0) lines.push(`${count(complete)} of ${count(total)} items complete.`);
  if (partial) lines.push('The run is **partial**: the items below are BLOCKED or withdrawn at the source and are named here.');
  lines.push('', '| field | value |', '|---|---|');
  for (const field of PROGRESS_FIELDS) {
    const v = progress[field];
    let shown = '-';
    if (field === 'current_product') shown = typeof v === 'string' ? ImportLog.handle(v) : inp.status?.current ? ImportLog.handle(inp.status.current.handle) : '-';
    else if (field === 'public_product_url') shown = log.liveUrl(v) ?? log.liveUrl(inp.status?.last_verified_url) ?? '-';
    else if (field === 'failed_stage') shown = typeof v === 'string' && STAGE.test(v) ? v : '-';
    else if (field === 'blocker') shown = typeof v === 'string' && CODE.test(v) ? v : '-';
    else if (field === 'resumption_instruction') shown = partial || blockedCount ? RESUME_INSTRUCTION.en : '-';
    else if (field === 'missing_info_by_reason' || field === 'finance_protection') {
      shown =
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.entries(v as Record<string, unknown>)
              .filter(([k, n]) => /^[a-z_]{1,48}$/.test(k) && (typeof n === 'number' || typeof n === 'boolean'))
              .map(([k, n]) => `${k} ${typeof n === 'boolean' ? (n ? 'yes' : 'no') : count(n)}`)
              .join(', ') || '-'
          : '-';
    } else if (field === 'complete_count') shown = count(complete);
    else if (field === 'blocked_count') shown = count(blockedCount);
    else if (field === 'withdrawn_count') shown = count(withdrawnCount);
    else if (field === 'discovered_total') shown = total ? count(total) : '-';
    else shown = count(v);
    lines.push(`| ${field} | ${shown} |`);
  }
  if (inp.items.length) {
    lines.push('', '### This job', '', '| # | handle | outcome | code | public page |', '|---|---|---|---|---|');
    for (const it of inp.items) {
      lines.push(`| ${count(it.position)} | ${ImportLog.handle(it.handle)} | ${it.outcome} | ${it.code && CODE.test(it.code) ? it.code : ''} | ${it.outcome === 'complete' ? log.liveUrl(it.url) ?? '' : ''} |`);
    }
  }
  if (inp.blocked.length || inp.withdrawn.length) {
    lines.push('', '### BLOCKED and withdrawn items');
    for (const b of inp.blocked) lines.push(`- BLOCKED \`${ImportLog.handle(b.handle)}\` ${CODE.test(b.code) ? b.code : ''}`);
    for (const w of inp.withdrawn) lines.push(`- WITHDRAWN_AT_SOURCE \`${ImportLog.handle(w)}\``);
    lines.push('', `${RESUME_INSTRUCTION.ar}`, `${RESUME_INSTRUCTION.en}`, `${RESUME_INSTRUCTION.ckb}`);
  }
  lines.push('', `More to do: ${inp.more ? 'yes' : 'no'}.`);
  return `${lines.join('\n')}\n`;
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
