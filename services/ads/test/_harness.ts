/**
 * The ads test harness.
 *
 * Two decisions worth stating:
 *
 *  - the database under test is built from `migrations/0001_ads.sql` itself, not
 *    from a schema restated in TypeScript. A test that invents its own tables
 *    proves nothing about the file the deploy will apply;
 *  - `fetchImpl` defaults to a function that THROWS. Every test therefore has to
 *    opt into being allowed to make a request, and "the sandbox never fetches"
 *    is proven by construction rather than by an assertion someone can forget.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { EventEnvelope, UnsignedEnvelope } from '@levonis/contracts/envelope';
import { signEnvelope } from '@levonis/platform-kit/eventSig';
import { generateKeyPair, importSigningKey, KeyRing, signCompact, type SigningKey } from '@levonis/platform-kit/keys';
import { memoryDb } from './_sqlite';

export const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(SERVICE_ROOT, '..', '..');
export const FIXTURES = join(REPO_ROOT, 'packages', 'contracts', 'src', 'events', 'fixtures');

export const migrationSql = (): string => readFileSync(join(SERVICE_ROOT, 'migrations', '0001_ads.sql'), 'utf8');

/** The committed contract fixture for an event type, as a fresh object every call. */
export const fixture = (name: string): EventEnvelope => JSON.parse(readFileSync(join(FIXTURES, `${name}.v1.json`), 'utf8')) as EventEnvelope;

export function adsDb(): { db: D1Database; raw: DatabaseSync } {
  return memoryDb(migrationSql());
}

/** A fetch that fails loudly. The default everywhere: a test must opt into the network. */
export const forbiddenFetch = ((): typeof fetch =>
  (async () => {
    throw new Error('the network was reached — no sandbox or kill-switch path may make a request');
  }) as unknown as typeof fetch)();

export interface RecordedExchange {
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: { status: number; body: unknown };
}

/** A fetch that replays one recorded response and captures the request it was given. */
export function recordingFetch(response: { status: number; body: unknown }): { impl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(typeof response.body === 'string' ? response.body : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

export interface TestProducer {
  service: string;
  key: SigningKey;
  publicKeyB64: string;
}

export async function producer(service: string): Promise<TestProducer> {
  const m = await generateKeyPair();
  return { service, key: await importSigningKey(m.privateKeyB64, m.publicKeyB64), publicKeyB64: m.publicKeyB64 };
}

export async function ringOf(...producers: TestProducer[]): Promise<KeyRing> {
  const ring = new KeyRing();
  for (const p of producers) await ring.add(p.service, p.publicKeyB64);
  return ring;
}

/** Signs a (possibly modified) fixture with a throwaway producer key, as the real bus would. */
export async function sign(p: TestProducer, env: EventEnvelope): Promise<EventEnvelope> {
  const { sig: _sig, ...unsigned } = env;
  return signEnvelope(p.key, unsigned as UnsignedEnvelope);
}

/** The env a fully configured Worker would have. Values are obvious fakes; no real credential exists in this repo. */
export const CONFIGURED_ENV: Record<string, string | undefined> = {
  ADS_ENABLED: 'on',
  META_CAPI_ACCESS_TOKEN: 'test-meta-token',
  META_CAPI_DATASET_ID: '1234567890',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'test-google-dev',
  GOOGLE_ADS_ACCESS_TOKEN: 'test-google-access',
  GOOGLE_ADS_CUSTOMER_ID: '1112223333',
  GOOGLE_ADS_CONVERSION_ACTION_ID: '987654321',
  TIKTOK_ADS_ACCESS_TOKEN: 'test-tiktok-token',
  TIKTOK_ADS_PIXEL_CODE: 'TESTPIXEL',
  SNAPCHAT_ADS_ACCESS_TOKEN: 'test-snap-token',
  SNAPCHAT_ADS_PIXEL_ID: 'snap-pixel-1',
};

/** The env of a Worker with the master switch on and NOT ONE provider secret set. */
export const UNCONFIGURED_ENV: Record<string, string | undefined> = { ADS_ENABLED: 'on' };

/**
 * An Identity key ring for the admin surface's principal check: the signing
 * key plus the `ALLOWED_CALLER_KIDS` entry that makes this Worker trust it. A
 * rig that omits the var gets an empty ring and therefore a 401 on every admin
 * route, which is asserted in `app.test.ts`.
 */
export interface TestIdentity {
  allowlist: string;
  mint(overrides?: Record<string, unknown>): Promise<string>;
}

export async function identity(service = 'identity'): Promise<TestIdentity> {
  const m = await generateKeyPair();
  const key = await importSigningKey(m.privateKeyB64, m.publicKeyB64);
  const now = Math.floor(Date.now() / 1000);
  return {
    allowlist: `${service}:${key.kid}:${m.publicKeyB64}`,
    mint: (overrides = {}) =>
      signCompact(key, {
        v: 1,
        sub: 'usr_admin',
        sid_hash: null,
        role: 'admin',
        scope: 'full',
        investor: false,
        tier: null,
        locale: 'en',
        host_kind: 'main',
        iat: now,
        exp: now + 120,
        cid: 'cid-test',
        ...overrides,
      }),
  };
}

/** Forget the per-isolate key-ring cache so each rig sees its own `ALLOWED_CALLER_KIDS`. */
export { resetKeyCache as resetPrincipalCache } from '../src/keys';
