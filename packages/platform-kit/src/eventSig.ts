/**
 * Event signatures (`03-EVENTS.md` §1): `sig` = `<b64url(header{alg,kid})>.<b64url(signature)>`
 * over the canonical envelope minus `sig`, by the producer's `<SVC>_SIGNING_KEY`.
 * Consumers verify against the producer's registered key and the per-type
 * `producers` allowlist — in rpc AND queue mode.
 */
import type { EventEnvelope, UnsignedEnvelope } from '@levonis/contracts/envelope';
import { isAllowedProducer } from '@levonis/contracts/subscriptions';
import { canonicalJson, utf8, b64url, b64urlDecode } from '@levonis/contracts/canonical';
import { signBytes, verifyBytes, type KeyRing, type SigningKey } from './keys';

export async function signEnvelope<T>(key: SigningKey, env: UnsignedEnvelope<T>): Promise<EventEnvelope<T>> {
  const header = b64url(utf8(canonicalJson({ alg: 'EdDSA', kid: key.kid })));
  const sig = await signBytes(key, utf8(canonicalJson(env)));
  return { ...env, sig: `${header}.${sig}` };
}

export type EnvelopeVerification =
  | { ok: true; kid: string; producer: string }
  | { ok: false; reason: 'MALFORMED_SIG' | 'UNKNOWN_KID' | 'PRODUCER_KEY_MISMATCH' | 'PRODUCER_NOT_ALLOWED' | 'BAD_SIGNATURE' };

export async function verifyEnvelope(
  env: EventEnvelope,
  ring: KeyRing,
  opts: { eventKey: string; hopIss?: string | null }
): Promise<EnvelopeVerification> {
  const parts = env.sig.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'MALFORMED_SIG' };
  let kid: string;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as { alg?: unknown; kid?: unknown };
    if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') return { ok: false, reason: 'MALFORMED_SIG' };
    kid = header.kid;
  } catch {
    return { ok: false, reason: 'MALFORMED_SIG' };
  }
  const key = ring.get(kid);
  if (!key) return { ok: false, reason: 'UNKNOWN_KID' };
  if (key.service !== env.source_service) return { ok: false, reason: 'PRODUCER_KEY_MISMATCH' };
  if (!isAllowedProducer(opts.eventKey, env.source_service)) return { ok: false, reason: 'PRODUCER_NOT_ALLOWED' };
  if (opts.hopIss && opts.hopIss !== env.source_service && !isAllowedProducer(opts.eventKey, opts.hopIss)) {
    return { ok: false, reason: 'PRODUCER_NOT_ALLOWED' };
  }
  const { sig: _sig, ...unsigned } = env;
  if (!(await verifyBytes(key, utf8(canonicalJson(unsigned)), parts[1]))) return { ok: false, reason: 'BAD_SIGNATURE' };
  return { ok: true, kid, producer: env.source_service };
}
