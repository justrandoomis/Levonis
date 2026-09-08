/**
 * The notifications test harness.
 *
 * As in `services/ads`, the database under test is built from
 * `migrations/0001_notifications.sql` itself — a test that invents its own
 * tables proves nothing about the file the deploy will apply — and `fetchImpl`
 * defaults to a function that THROWS, so "a disabled transport never fetches"
 * is proven by construction rather than by an assertion someone can forget.
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

export const migrationSql = (): string => readFileSync(join(SERVICE_ROOT, 'migrations', '0001_notifications.sql'), 'utf8');

/** The committed contract fixture for an event type, as a fresh object every call. */
export const fixture = (name: string): EventEnvelope => JSON.parse(readFileSync(join(FIXTURES, `${name}.v1.json`), 'utf8')) as EventEnvelope;

export function notifyDb(): { db: D1Database; raw: DatabaseSync } {
  return memoryDb(migrationSql());
}

/** A fetch that fails loudly. The default everywhere: a test must opt into the network. */
export const forbiddenFetch = ((): typeof fetch =>
  (async () => {
    throw new Error('the network was reached — a disabled transport or a disabled pump may not make a request');
  }) as unknown as typeof fetch)();

/** A fetch that replays one response and captures the requests it was given. */
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

export async function sign(p: TestProducer, env: EventEnvelope): Promise<EventEnvelope> {
  const { sig: _sig, ...unsigned } = env;
  return signEnvelope(p.key, unsigned as UnsignedEnvelope);
}

/** A Worker with both transports configured and delivery on. Obvious fakes; no real credential exists in this repo. */
export const CONFIGURED_ENV: Record<string, string | undefined> = {
  NOTIFY_DELIVERY: 'on',
  EMAIL_API_KEY: 'test-email-key',
  EMAIL_FROM: 'no-reply@levonis.invalid',
  TELEGRAM_BOT_TOKEN: 'test-bot-token',
  TELEGRAM_ADMIN_CHAT_ID: '-100123',
};

/** Delivery on, and NOT ONE transport credential set. */
export const UNCONFIGURED_ENV: Record<string, string | undefined> = { NOTIFY_DELIVERY: 'on' };

/**
 * An Identity key ring for principal tests: the signing key plus the
 * `ALLOWED_CALLER_KIDS` entry that makes this Worker trust it. A test that
 * omits the var gets an empty ring and therefore a 401 — which is the
 * deployment state until the gateway mints principals, and is asserted as
 * such.
 */
export interface TestIdentity {
  key: SigningKey;
  allowlist: string;
  mint(overrides?: Record<string, unknown>): Promise<string>;
}

export async function identity(service = 'identity'): Promise<TestIdentity> {
  const m = await generateKeyPair();
  const key = await importSigningKey(m.privateKeyB64, m.publicKeyB64);
  const now = Math.floor(Date.now() / 1000);
  return {
    key,
    allowlist: `${service}:${key.kid}:${m.publicKeyB64}`,
    mint: (overrides = {}) =>
      signCompact(key, {
        v: 1,
        sub: 'usr_1',
        sid_hash: null,
        role: 'customer',
        scope: null,
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
