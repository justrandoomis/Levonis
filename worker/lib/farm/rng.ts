/**
 * Deterministic randomness for the farm — from SERVER-HELD seeds.
 *
 * Every outcome that matters — which offers appear, whether a print fails and
 * how — is rolled from a SEED stored on the row when it was created, mixed
 * with a stable salt. Replaying a request, re-reading the state, or a config
 * change cannot change the outcome, and nothing here reads Math.random.
 *
 * WHERE THE SEED COMES FROM is the whole game. Phase 1 derived it from ids
 * the player knew (their user id, their idempotency key), so a client could
 * search keys offline for a roll that never fails. A seed is now either
 * `randomSeedHex()` — 32 bytes from WebCrypto written on the row at insert
 * (print outcomes) — or `seedFrom(secret, …)` over a per-player secret the
 * server never returns (`farm_profiles.offer_salt`, offers). The row's stored
 * seed decides; a replayed request collides on the row and changes nothing.
 *
 * Seeds are 64-hex-char strings (`seedFrom`, async because WebCrypto is);
 * `roll` and `sequence` are synchronous so the simulation stays pure.
 */

import { sha256Hex } from '../crypto';

/** A 64-hex-char seed from stable parts, e.g. seedFrom(offerSalt, 'offers', '3'). */
export async function seedFrom(...parts: string[]): Promise<string> {
  return sha256Hex(parts.join(':'));
}

/** 32 random bytes as 64 hex chars — a seed no client input can reproduce. */
export function randomSeedHex(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** mulberry32 — small, fast, well-distributed 32-bit generator in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over UTF-16 code units — a synchronous string hash for salts. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Folds an arbitrary seed string (hex or not) and a salt into one uint32. */
export function mixSeed(seed: string, salt: string): number {
  let acc = 0x9e3779b9;
  // Fold every 8-hex-char chunk of a hex seed so the whole digest counts. The
  // fold is a multiply-xor, ORDER-SENSITIVE and never self-cancelling: a plain
  // XOR fold would send any seed made of repeated chunks ('aaaa…') to zero. A
  // non-hex seed hashes deterministically through FNV-1a instead.
  if (/^[0-9a-f]+$/i.test(seed)) {
    for (let i = 0; i < seed.length; i += 8) {
      const chunk = parseInt(seed.slice(i, i + 8).padEnd(8, '0'), 16);
      acc = (Math.imul(acc ^ chunk, 0x9e3779b1) + 0x7f4a7c15) >>> 0;
    }
  } else {
    acc = fnv1a(seed);
  }
  return (acc ^ fnv1a(salt)) >>> 0;
}

/** A generator whose every value is determined by (seed, salt). */
export function sequence(seed: string, salt: string): () => number {
  const next = mulberry32(mixSeed(seed, salt));
  // Discard the first output: mulberry32's first value correlates with small
  // seed differences more than later ones do.
  next();
  return next;
}

/** One deterministic number in [0, 1). */
export function roll(seed: string, salt: string): number {
  return sequence(seed, salt)();
}

/** A deterministic integer in [min, max] (inclusive). */
export function rollInt(seed: string, salt: string, min: number, max: number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(roll(seed, salt) * (hi - lo + 1));
}

/** Picks an index by weight from a deterministic value r in [0, 1). */
export function weightedIndex(weights: number[], r: number): number {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0) return 0;
  let acc = 0;
  const target = r * total;
  for (let i = 0; i < weights.length; i++) {
    acc += Math.max(0, weights[i]);
    if (target < acc) return i;
  }
  return weights.length - 1;
}
