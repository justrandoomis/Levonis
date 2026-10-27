/**
 * THE CREATIVE STUDIO'S KEY VAULT (docs/CREATIVE_STUDIO.md §4; DECISIONS row 270).
 *
 * A provider key the owner types in the studio settings is stored as
 * AES-256-GCM ciphertext, under a key that is NOT in the database: the Worker
 * secret `CREATIVE_STUDIO_ENC_KEY`, in the same format and ring as
 * `KYC_ENC_KEY` ("v1:<base64 32 bytes>", a comma-separated ring for rotation —
 * the last key encrypts, every older one still decrypts; worker/lib/sealbox.ts).
 * A dump of D1 alone opens nothing.
 *
 * THE CIPHERTEXT IS BOUND TO ITS ROW. The AES-GCM additional data names the
 * table, the row and the column (`creative_provider_settings:anthropic:key`),
 * so the sealed value copied into any other column — or a KYC ciphertext
 * copied here — fails to open. Separate secret, separate binding: the KYC key
 * never seals a provider key and this one never opens a KYC field.
 *
 * This module only seals and opens. It never reads the settings row: the one
 * reader of the stored key is worker/lib/creative/anthropic.ts, which hands
 * the sealed value here and the plain key straight to the provider's header.
 */
import { sealWith, sealboxConfigured, unsealWith } from '../sealbox';
import type { Env } from '../types';

/** The additional data that binds the ciphertext to `creative_provider_settings.key_sealed` of row `anthropic`. */
export const PROVIDER_KEY_AAD = 'creative_provider_settings:anthropic:key';
const SECRET_NAME = 'CREATIVE_STUDIO_ENC_KEY';

type VaultEnv = Pick<Env, 'CREATIVE_STUDIO_ENC_KEY'>;

export function vaultConfigured(env: VaultEnv): boolean {
  return sealboxConfigured(env.CREATIVE_STUDIO_ENC_KEY);
}

/**
 * `encryption_ready` of the provider page: the secret is set AND a seal → open
 * round trip through it works. A set but malformed secret (wrong length, bad
 * base64, a stray character pasted with it) is not ready, and a key is then
 * refused with ENCRYPTION_NOT_CONFIGURED instead of being stored unreadable.
 */
export async function encryptionReady(env: VaultEnv): Promise<boolean> {
  if (!vaultConfigured(env)) return false;
  try {
    const probe = 'creative-studio-vault-probe';
    const sealed = await sealWith(env.CREATIVE_STUDIO_ENC_KEY, probe, { aad: PROVIDER_KEY_AAD, secretName: SECRET_NAME });
    return (await unsealWith(env.CREATIVE_STUDIO_ENC_KEY, sealed, { aad: PROVIDER_KEY_AAD, secretName: SECRET_NAME })) === probe;
  } catch {
    return false;
  }
}

/** Seal the provider key. Throws when the vault is not ready — the caller has already asked `encryptionReady`. */
export async function sealProviderKey(env: VaultEnv, apiKey: string): Promise<string> {
  return sealWith(env.CREATIVE_STUDIO_ENC_KEY, apiKey, { aad: PROVIDER_KEY_AAD, secretName: SECRET_NAME });
}

/** Open the stored key; null when it cannot be opened (no secret, a rotated-away key version, a moved ciphertext). */
export async function openProviderKey(env: VaultEnv, sealed: string | null | undefined): Promise<string | null> {
  if (!sealed) return null;
  return unsealWith(env.CREATIVE_STUDIO_ENC_KEY, sealed, { aad: PROVIDER_KEY_AAD, secretName: SECRET_NAME });
}
