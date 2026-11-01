/**
 * THE WORKSPACE'S LONG RUNS, AS PLAIN LOOPS (docs/SMART_PRICING.md §3.4,
 * §3.5, §4.8): the chunked upload, matching and compute page by page, and
 * the apply five products a call. Each takes its calls as arguments, so the
 * tabs pass the real requests and the tests pass stubs; none of them prices,
 * matches or decides anything — the server does.
 */
import type { ApplyAnswer, ApplyItem, ApplyOutcome, ComputeAnswer, MatchPageAnswer, SnapshotCreateBody } from './api';
import type { PreparedUpload } from './upload';

/** The most products one apply call takes (the server's ESTIMATE_APPLY_PAGE). */
export const APPLY_PAGE = 5;

export interface UploadCalls {
  create: (body: SnapshotCreateBody) => Promise<{ snapshot: { id: string } }>;
  items: (id: string, items: readonly unknown[], offset: number) => Promise<unknown>;
  complete: (id: string, body: { item_count: number; sku_count: number; file_sha256: string }) => Promise<unknown>;
}

export class RunStopped extends Error {
  constructor() {
    super('stopped');
    this.name = 'RunStopped';
  }
}

/**
 * Sends one prepared file: the snapshot is created (unless resuming one), the
 * chunks from `from` on are posted in order — a chunk posted twice writes once,
 * so a resumed upload starts at its first unsent chunk — and the snapshot is
 * completed with the file's counts and hash. `onProgress(snapshotId, sent)`
 * reports the chunks sent so far. Throws the failing call's error, or
 * RunStopped, with `sent` kept for a resume.
 */
export async function sendUpload(
  file: PreparedUpload,
  calls: UploadCalls,
  opts: { snapshotId?: string | null; from?: number; shouldStop?: () => boolean; onProgress?: (snapshotId: string, sent: number) => void } = {}
): Promise<string> {
  let id = opts.snapshotId ?? null;
  if (!id) {
    const h = file.header;
    id = (
      await calls.create({
        source: h.source,
        currency: h.currency,
        price_basis: h.price_basis,
        capture: h.capture,
        captured_on: h.captured_on,
        captured_by: h.captured_by,
        file_sha256: file.sha256,
        item_count: file.itemCount,
      })
    ).snapshot.id;
  }
  for (let i = opts.from ?? 0; i < file.chunks.length; i++) {
    opts.onProgress?.(id, i);
    if (opts.shouldStop?.()) throw new RunStopped();
    const chunk = file.chunks[i]!;
    await calls.items(id, chunk.items, chunk.offset);
  }
  opts.onProgress?.(id, file.chunks.length);
  await calls.complete(id, { item_count: file.itemCount, sku_count: file.skuCount, file_sha256: file.sha256 });
  return id;
}

/** Matching in pages of 25 products, from the start to the end (or a stop): the totals of what it wrote. */
export async function matchAllPages(
  match: (body: { cursor: string }) => Promise<MatchPageAnswer>,
  opts: { shouldStop?: () => boolean; onPage?: (products: number) => void } = {}
): Promise<{ products: number; confirmed: number; suggested: number; missing: number; stopped: boolean }> {
  const totals = { products: 0, confirmed: 0, suggested: 0, missing: 0, stopped: false };
  let cursor = '';
  for (;;) {
    const page = await match({ cursor });
    for (const p of page.products) {
      totals.products += 1;
      totals.confirmed += p.confirmed;
      totals.suggested += p.suggested;
      totals.missing += p.missing.length;
    }
    opts.onPage?.(totals.products);
    if (!page.next_cursor) break;
    if (opts.shouldStop?.()) {
      totals.stopped = true;
      break;
    }
    cursor = page.next_cursor;
  }
  return totals;
}

/**
 * Compute page by page, nothing published. A page that computed nothing and
 * resumes where it began would loop forever (the invocation budget too small
 * for one product): the run stops there instead.
 */
export async function computeAllPages(
  compute: (body: { cursor: string }) => Promise<ComputeAnswer>,
  opts: { shouldStop?: () => boolean; onPage?: (computed: number) => void } = {}
): Promise<{ n: number; ready: number; stopped: boolean }> {
  let cursor = '';
  let n = 0;
  let ready = 0;
  for (;;) {
    const a = await compute({ cursor });
    n += a.products.length;
    ready += a.products.filter((p) => !p.blocking).length;
    opts.onPage?.(n);
    if (!a.next_cursor || (a.products.length === 0 && a.next_cursor === cursor)) return { n, ready, stopped: false };
    if (opts.shouldStop?.()) return { n, ready, stopped: true };
    cursor = a.next_cursor;
  }
}

/**
 * Apply the items five a call; the items a call defers (the invocation budget)
 * are sent again as its `cursor` until none is left. Every product's outcome,
 * by id. One product's refusal never stops the others; a refusal of the whole
 * call (the switch off, the policy missing) is thrown.
 */
export async function applyInPages(
  items: readonly ApplyItem[],
  apply: (body: { items: ApplyItem[] } | { cursor: ApplyItem[] }) => Promise<ApplyAnswer>,
  opts: { shouldStop?: () => boolean; onResults?: (done: ReadonlyMap<string, ApplyOutcome>) => void } = {}
): Promise<Map<string, ApplyOutcome>> {
  const done = new Map<string, ApplyOutcome>();
  for (let i = 0; i < items.length && !opts.shouldStop?.(); i += APPLY_PAGE) {
    let sent = items.slice(i, i + APPLY_PAGE);
    let answer = await apply({ items: sent });
    for (;;) {
      for (const o of answer.results) done.set(o.product_id, o);
      opts.onResults?.(done);
      if (!answer.cursor?.length || opts.shouldStop?.()) break;
      // A call that attempted nothing and deferred everything it was sent would be sent forever: stop at it.
      if (!answer.results.length && answer.cursor.length >= sent.length) break;
      sent = answer.cursor;
      answer = await apply({ cursor: sent });
    }
  }
  return done;
}
