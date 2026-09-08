/**
 * The hash chain (`01-TARGET.md` row 20: `audit_events`, `audit_chain_heads`,
 * hash-chained; `AUDIT_CHAIN_KEY`).
 *
 * WHY INGEST AND CHAINING ARE SEPARATE STEPS. A chain link needs the previous
 * link's hash, so writing one is read-then-write — and two deliveries racing on
 * D1 would either fork the chain or need a fence whose failure mode is
 * indistinguishable, to `defineConsumer`, from the `processed_events` PK
 * violation that means "already delivered". An audit entry silently reported as
 * a replay is exactly the failure this service exists to prevent. So ingest is
 * a plain INSERT (contention-free, idempotent by `event_id`), and the chain is
 * built by the sealing pass, which is serialised by ONE conditional head update
 * whose loss aborts its own batch and nothing else.
 *
 * WHY THE CHAIN IS WALKED IN SEAL ORDER. `seq` is assigned at INSERT; two
 * concurrent inserts can commit out of order, so a row with a smaller `seq` can
 * appear after a larger one was sealed. `chain_index` is assigned by the sealer
 * in the order it actually linked the rows, is contiguous, and is therefore the
 * only order in which the chain is a chain. Verification walks it.
 *
 * WHAT THE HASH COVERS: the entry's identity and content — including
 * `detail_hash`, never the `detail` body — so a body that arrives later (an
 * `AuditRecorded` envelope carries a hash and a reference, `03-EVENTS.md` §4)
 * can be filled in without breaking anything, while a body that does not match
 * the recorded hash is detectable.
 */
import { canonicalJson, sha256Hex, utf8, bytesToHex } from '@levonis/contracts/canonical';

export const CHAIN_MAIN = 'main';
/** The predecessor of the first link. */
export const GENESIS_HASH = '0'.repeat(64);

export type ChainAlg = 'hmac-sha256' | 'sha256';

/** The fields the chain commits to. Order is irrelevant — the JSON is canonical. */
export interface ChainCore {
  chain_index: number;
  prev_hash: string;
  id: string;
  event_id: string;
  event_type: string;
  actor_id: string | null;
  action: string;
  target: string;
  detail_hash: string;
  source_service: string;
  correlation_id: string;
  occurred_at: string;
  recorded_at: string;
}

let hmacKey: { material: string; key: CryptoKey } | null = null;

async function hmacKeyFor(material: string): Promise<CryptoKey> {
  if (hmacKey && hmacKey.material === material) return hmacKey.key;
  const key = await crypto.subtle.importKey('raw', utf8(material) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  hmacKey = { material, key };
  return key;
}

export const algFor = (chainKey: string | undefined): ChainAlg => (chainKey ? 'hmac-sha256' : 'sha256');

/**
 * The link hash. With `AUDIT_CHAIN_KEY` present it is an HMAC, so recomputing a
 * consistent chain needs the Worker's secret and not merely write access to the
 * table; without it a plain digest, which still detects an edit.
 */
export async function linkHash(core: ChainCore, chainKey: string | undefined): Promise<string> {
  const payload = canonicalJson(core);
  if (!chainKey) return sha256Hex(payload);
  const key = await hmacKeyFor(chainKey);
  return bytesToHex(await crypto.subtle.sign('HMAC', key, utf8(payload) as BufferSource));
}

export interface ChainHead {
  chain_index: number;
  head_hash: string;
  alg: string;
  anchored_index: number | null;
  anchored_hash: string | null;
}

/** The head as a starting point, treating "no head row yet" as the genesis. */
export const startFrom = (head: ChainHead | null): { index: number; hash: string } =>
  head ? { index: head.chain_index, hash: head.head_hash } : { index: 0, hash: GENESIS_HASH };

export interface UnsealedRow extends Omit<ChainCore, 'chain_index' | 'prev_hash'> {
  seq: number;
}

export interface SealedLink {
  seq: number;
  chain_index: number;
  prev_hash: string;
  hash: string;
}

/**
 * Links a run of unsealed rows onto the head. Pure: no database, no clock — the
 * caller turns the result into statements and decides whether to commit.
 */
export async function linkRows(rows: UnsealedRow[], head: ChainHead | null, chainKey: string | undefined): Promise<SealedLink[]> {
  const start = startFrom(head);
  const out: SealedLink[] = [];
  let prev = start.hash;
  let index = start.index;
  for (const row of rows) {
    index += 1;
    const core: ChainCore = {
      chain_index: index,
      prev_hash: prev,
      id: row.id,
      event_id: row.event_id,
      event_type: row.event_type,
      actor_id: row.actor_id,
      action: row.action,
      target: row.target,
      detail_hash: row.detail_hash,
      source_service: row.source_service,
      correlation_id: row.correlation_id,
      occurred_at: row.occurred_at,
      recorded_at: row.recorded_at,
    };
    const hash = await linkHash(core, chainKey);
    out.push({ seq: row.seq, chain_index: index, prev_hash: prev, hash });
    prev = hash;
  }
  return out;
}

export interface SealedRow extends ChainCore {
  hash: string;
  alg: string | null;
}

export interface VerifyPageResult {
  ok: boolean;
  checked: number;
  head: string;
  /** the first `chain_index` whose stored hash or predecessor did not match */
  broken_at?: number;
}

/**
 * Re-computes a page of the chain and compares it with what is stored. The
 * caller feeds pages in `chain_index` order, carrying `prev`/`index` forward.
 */
export async function verifyPage(
  rows: SealedRow[],
  start: { index: number; hash: string },
  chainKey: string | undefined
): Promise<VerifyPageResult> {
  let prev = start.hash;
  let index = start.index;
  let checked = 0;
  for (const row of rows) {
    index += 1;
    // `index` is the position the walk expects; when a link is missing the row
    // that turns up carries a LATER index, and the position that broke is the
    // one nobody wrote — so the expected index is what gets reported.
    if (row.chain_index !== index) return { ok: false, checked, head: prev, broken_at: index };
    if (row.prev_hash !== prev) return { ok: false, checked, head: prev, broken_at: index };
    const expected = await linkHash(
      {
        chain_index: row.chain_index,
        prev_hash: row.prev_hash,
        id: row.id,
        event_id: row.event_id,
        event_type: row.event_type,
        actor_id: row.actor_id,
        action: row.action,
        target: row.target,
        detail_hash: row.detail_hash,
        source_service: row.source_service,
        correlation_id: row.correlation_id,
        occurred_at: row.occurred_at,
        recorded_at: row.recorded_at,
      },
      // Verify each row under the algorithm it RECORDS, not the one configured
      // now: a key added later must not invalidate the rows written before it,
      // and a keyed row must not silently pass when the key is gone (it is
      // hashed with `undefined` only if it says it was).
      row.alg === 'sha256' ? undefined : chainKey
    );
    if (expected !== row.hash) return { ok: false, checked, head: prev, broken_at: index };
    prev = row.hash;
    checked += 1;
  }
  return { ok: true, checked, head: prev };
}
