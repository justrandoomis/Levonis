/**
 * Envelopes for the tests, built from the COMMITTED fixtures
 * (`packages/contracts/src/events/fixtures/`) and signed at test time with
 * throwaway keys — no key material in the repository, and no hand-written
 * payload that could drift from the schema the producers actually emit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { unsigned } from '@levonis/contracts/envelope';
import { signEnvelope } from '@levonis/platform-kit/eventSig';
import { generateKeyPair, importSigningKey, KeyRing, type SigningKey } from '@levonis/platform-kit/keys';
import { uuidv7 } from '@levonis/platform-kit/correlation';
import { SERVICE_ROOT } from './_db';

export const FIXTURES = join(SERVICE_ROOT, '..', '..', 'packages', 'contracts', 'src', 'events', 'fixtures');

export const fixture = (key: string): EventEnvelope => JSON.parse(readFileSync(join(FIXTURES, `${key}.json`), 'utf8')) as EventEnvelope;

export interface Producers {
  ring: KeyRing;
  keys: Map<string, SigningKey>;
  /** signs an envelope as the service in its `source_service` */
  sign(env: EventEnvelope): Promise<EventEnvelope>;
}

/**
 * A key per service, registered in one ring, as Identity's registry would hand
 * them over. Services are created on demand, so a test signs "as whoever the
 * fixture says produced this" without restating the producer table.
 */
export async function producers(services: string[] = []): Promise<Producers> {
  const ring = new KeyRing();
  const keys = new Map<string, SigningKey>();
  const keyFor = async (svc: string): Promise<SigningKey> => {
    const known = keys.get(svc);
    if (known) return known;
    const material = await generateKeyPair();
    const key = await importSigningKey(material.privateKeyB64, material.publicKeyB64);
    keys.set(svc, key);
    await ring.add(svc, material.publicKeyB64);
    return key;
  };
  for (const svc of services) await keyFor(svc);
  return {
    ring,
    keys,
    async sign(env) {
      return signEnvelope(await keyFor(env.source_service), unsigned(env));
    },
  };
}

/** A fixture with fresh envelope identity, so two deliveries in one test are two events. */
export function withIds(env: EventEnvelope, patch: Partial<EventEnvelope>): EventEnvelope {
  return { ...env, ...patch } as EventEnvelope;
}

/** A fresh event id, minted by the same generator the producers use. */
export const nextEventId = (): string => uuidv7();
