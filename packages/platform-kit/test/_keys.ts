/** Fresh throwaway key pairs for tests — generated per run, never committed. */
import { generateKeyPair, importSigningKey, KeyRing, type SigningKey } from '../src/keys';

export interface TestIdentity {
  service: string;
  key: SigningKey;
  publicKeyB64: string;
}

export async function testIdentity(service: string): Promise<TestIdentity> {
  const m = await generateKeyPair();
  return { service, key: await importSigningKey(m.privateKeyB64, m.publicKeyB64), publicKeyB64: m.publicKeyB64 };
}

export async function ringOf(...ids: TestIdentity[]): Promise<KeyRing> {
  const ring = new KeyRing();
  for (const id of ids) await ring.add(id.service, id.publicKeyB64);
  return ring;
}
