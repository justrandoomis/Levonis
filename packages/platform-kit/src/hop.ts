/**
 * The hop envelope (`01-TARGET.md` §4 item 3, ADR-002 (d)): every service-to-service
 * call carries `{iss, kid, iat, exp: iat+30, nonce, method, args_hash,
 * principal_hash}` signed by the caller from day one. The callee verifies the
 * issuer is allowed FOR THAT METHOD, the signature, `args_hash`,
 * `principal_hash`, the 30-s window, and rejects replays by `(iss, nonce)`.
 */
import type { HopEnvelope } from '@levonis/contracts/rpc/common';
import { canonicalHash, canonicalJson, sha256Hex, utf8, b64url } from '@levonis/contracts/canonical';
import { obj, str, int, nullable, validator } from '@levonis/contracts/schema';
import { signBytes, verifyBytes, type KeyRing, type SigningKey } from './keys';

export const HOP_TTL_S = 30;
export const HOP_REPLAY_WINDOW_MS = 60_000;

const hopCheck = validator(
  obj({ iss: str, kid: str, iat: int, exp: int, nonce: str, method: str, args_hash: str, principal_hash: nullable(str), sig: str })
);

export interface HopSigner {
  iss: string;
  key: SigningKey;
}

export interface SignHopInput {
  method: string;
  args: unknown;
  principalHeader?: string | null;
  nowSeconds: number;
  nonce?: string;
}

export function newNonce(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function argsHash(args: unknown): Promise<string> {
  return canonicalHash(args ?? null);
}

export async function principalHash(header: string | null | undefined): Promise<string | null> {
  return header ? sha256Hex(header) : null;
}

/** Bytes the caller signs: the canonical envelope minus `sig`. */
function signingBytes(h: Omit<HopEnvelope, 'sig'>): Uint8Array {
  return utf8(canonicalJson(h));
}

export async function signHop(signer: HopSigner, input: SignHopInput): Promise<HopEnvelope> {
  const unsigned: Omit<HopEnvelope, 'sig'> = {
    iss: signer.iss,
    kid: signer.key.kid,
    iat: input.nowSeconds,
    exp: input.nowSeconds + HOP_TTL_S,
    nonce: input.nonce ?? newNonce(),
    method: input.method,
    args_hash: await argsHash(input.args),
    principal_hash: await principalHash(input.principalHeader),
  };
  return { ...unsigned, sig: await signBytes(signer.key, signingBytes(unsigned)) };
}

/** In-isolate replay set keyed `(iss, nonce)`; pruned lazily. A `Serializer`/KV adapter later. */
export class NonceSet {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs = HOP_REPLAY_WINDOW_MS) {}

  /** Returns false when the nonce was already seen inside the window. */
  remember(iss: string, nonce: string, nowMs: number): boolean {
    for (const [k, t] of this.seen) if (nowMs - t > this.windowMs) this.seen.delete(k);
    const key = `${iss} ${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, nowMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export type HopVerification =
  | { ok: true; hop: HopEnvelope; iss: string }
  | {
      ok: false;
      reason:
        | 'MALFORMED'
        | 'UNKNOWN_KID'
        | 'ISSUER_KEY_MISMATCH'
        | 'ISSUER_NOT_ALLOWED'
        | 'METHOD_MISMATCH'
        | 'BAD_SIGNATURE'
        | 'EXPIRED'
        | 'NOT_YET_VALID'
        | 'ARGS_MISMATCH'
        | 'PRINCIPAL_MISMATCH'
        | 'REPLAY';
    };

export interface VerifyHopInput {
  hop: unknown;
  method: string;
  args: unknown;
  principalHeader?: string | null;
  /** issuers allowed to call THIS method; `['*']` = any registered caller */
  allowedIssuers: readonly string[];
  ring: KeyRing;
  nonces: NonceSet;
  nowSeconds: number;
  leewaySeconds?: number;
}

export async function verifyHop(input: VerifyHopInput): Promise<HopVerification> {
  if (!hopCheck.is(input.hop)) return { ok: false, reason: 'MALFORMED' };
  const hop = input.hop as HopEnvelope;
  const key = input.ring.get(hop.kid);
  if (!key) return { ok: false, reason: 'UNKNOWN_KID' };
  if (key.service !== hop.iss) return { ok: false, reason: 'ISSUER_KEY_MISMATCH' };
  if (!input.allowedIssuers.includes('*') && !input.allowedIssuers.includes(hop.iss)) return { ok: false, reason: 'ISSUER_NOT_ALLOWED' };
  if (hop.method !== input.method) return { ok: false, reason: 'METHOD_MISMATCH' };
  const { sig, ...unsigned } = hop;
  if (!(await verifyBytes(key, signingBytes(unsigned), sig))) return { ok: false, reason: 'BAD_SIGNATURE' };
  const leeway = input.leewaySeconds ?? 5;
  if (hop.exp + leeway < input.nowSeconds) return { ok: false, reason: 'EXPIRED' };
  if (hop.iat - leeway > input.nowSeconds) return { ok: false, reason: 'NOT_YET_VALID' };
  if (hop.args_hash !== (await argsHash(input.args))) return { ok: false, reason: 'ARGS_MISMATCH' };
  if (hop.principal_hash !== (await principalHash(input.principalHeader))) return { ok: false, reason: 'PRINCIPAL_MISMATCH' };
  if (!input.nonces.remember(hop.iss, hop.nonce, input.nowSeconds * 1000)) return { ok: false, reason: 'REPLAY' };
  return { ok: true, hop, iss: hop.iss };
}

/** Per-method caller allowlist: `{ 'LedgerEntrypoint.credit': ['commerce', ...] }`. */
export type MethodAllowlist = Readonly<Record<string, readonly string[]>>;

export function allowedIssuersFor(allowlist: MethodAllowlist, method: string): readonly string[] {
  return allowlist[method] ?? [];
}
