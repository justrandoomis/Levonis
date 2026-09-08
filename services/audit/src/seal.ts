/**
 * The sealing pass and the verification walk — the two operations that turn the
 * append-only table into a chain and prove it is still one.
 *
 * Sealing runs from the per-minute cron and, opportunistically, right after a
 * delivery, so an entry is normally chained within a second of arriving. Both
 * callers use the same function and the same fence, so "two sealers at once" is
 * a rolled-back batch, never a forked chain.
 */
import { algFor, linkRows, startFrom, verifyPage, type ChainHead } from './chain';
import { advanceHeadStatement, headOf, sealLinkStatement, sealedPage, unsealedRows } from './store';

export interface SealResult {
  sealed: number;
  /** the chain index after this run */
  head_index: number;
  head_hash: string;
  alg: string;
  /** true when the fence was lost — another sealer had advanced the head */
  contended?: boolean;
}

export interface SealOptions {
  chainKey?: string;
  limit: number;
  now: string;
}

/**
 * Links every unsealed row (up to `limit`) onto the head, in one batch with the
 * head advance. Returns `sealed: 0` when there is nothing to do — the normal
 * case for most cron ticks — without writing anything.
 */
export async function sealOnce(db: D1Database, opts: SealOptions): Promise<SealResult> {
  const head: ChainHead | null = await headOf(db);
  const start = startFrom(head);
  const rows = await unsealedRows(db, opts.limit);
  if (rows.length === 0) return { sealed: 0, head_index: start.index, head_hash: start.hash, alg: head?.alg ?? algFor(opts.chainKey) };
  const alg = algFor(opts.chainKey);
  const links = await linkRows(rows, head, opts.chainKey);
  const last = links[links.length - 1];
  const statements = links.map((l) => sealLinkStatement(db, l, alg));
  statements.push(advanceHeadStatement(db, head, { chain_index: last.chain_index, head_hash: last.hash, alg, sealed_at: opts.now }));
  try {
    await db.batch(statements);
  } catch (e) {
    // The fence: another sealer advanced the head between our read and our
    // write, so this whole batch — links included — is gone. Nothing is
    // half-sealed; the next run picks the same rows up behind the new head.
    console.warn('audit: seal batch rolled back (the head moved under it):', e instanceof Error ? e.message : String(e));
    return { sealed: 0, head_index: start.index, head_hash: start.hash, alg, contended: true };
  }
  return { sealed: links.length, head_index: last.chain_index, head_hash: last.hash, alg };
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  head: string;
  anchored_head: string | null;
  broken_at?: number;
}

export interface VerifyOptions {
  chainKey?: string;
  pageSize: number;
  /** hard ceiling on rows walked in one call, so an admin request cannot run away */
  maxRows?: number;
}

/**
 * Walks the sealed chain from the genesis and re-computes every link. Stops at
 * the first row that does not match and reports its `chain_index`; a run that
 * reaches the end also checks that the recomputed head equals the stored one —
 * a head that disagrees with the rows it summarises is exactly what tampering
 * looks like.
 *
 * `maxRows` bounds one call so an admin request cannot run away on a long
 * chain. When the walk is cut short, `checked` is below the head's index and
 * `head` is the hash at that point rather than the chain head — the caller sees
 * "this prefix is intact", which is true, instead of a fabricated verdict on
 * rows nobody looked at.
 */
export async function verifyChain(db: D1Database, opts: VerifyOptions): Promise<VerifyResult> {
  const head = await headOf(db);
  const max = opts.maxRows ?? 50_000;
  let cursor = { index: 0, hash: startFrom(null).hash };
  let checked = 0;
  let truncated = false;
  for (;;) {
    const page = await sealedPage(db, cursor.index, Math.min(opts.pageSize, max - checked));
    if (page.length === 0) break;
    const res = await verifyPage(page, cursor, opts.chainKey);
    checked += res.checked;
    cursor = { index: cursor.index + res.checked, hash: res.head };
    if (!res.ok) return { ok: false, checked, head: res.head, anchored_head: head?.anchored_hash ?? null, broken_at: res.broken_at };
    if (checked >= max) {
      truncated = true;
      break;
    }
    if (page.length < opts.pageSize) break;
  }
  const anchored_head = head?.anchored_hash ?? null;
  if (truncated) {
    console.warn('audit: verifyChain stopped at the row ceiling', { checked, max });
    return { ok: true, checked, head: cursor.hash, anchored_head };
  }
  const storedIndex = head?.chain_index ?? 0;
  const storedHead = head?.head_hash ?? startFrom(null).hash;
  if (checked !== storedIndex || cursor.hash !== storedHead) {
    // The rows and the head disagree: either a link was removed (fewer rows
    // than the head counts) or the head was rewritten.
    return { ok: false, checked, head: cursor.hash, anchored_head, broken_at: Math.min(checked, storedIndex) + 1 };
  }
  return { ok: true, checked, head: cursor.hash, anchored_head };
}
