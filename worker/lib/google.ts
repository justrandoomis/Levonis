import { b64urlDecode } from './crypto';

/**
 * Server-side verification of a Google Identity Services ID token (JWT):
 * RS256 signature against Google's published JWKS, plus issuer, audience,
 * expiry and email_verified checks. Never trusts a decoded token alone.
 */

export interface GoogleIdentity {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
}

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

let jwksCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;

async function getJwks(): Promise<JsonWebKey[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 3_600_000) return jwksCache.keys;
  const res = await fetch(JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit);
  if (!res.ok) throw new Error('Failed to fetch Google signing keys');
  const data = (await res.json()) as { keys: (JsonWebKey & { kid?: string })[] };
  jwksCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

export async function verifyGoogleIdToken(credential: string, expectedAudience: string): Promise<GoogleIdentity> {
  if (!expectedAudience) throw new Error('GOOGLE_CLIENT_ID is not configured');
  const parts = credential.split('.');
  if (parts.length !== 3) throw new Error('Malformed credential');

  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as { alg: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm');

  const keys = (await getJwks()) as (JsonWebKey & { kid?: string })[];
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown signing key');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(parts[2]) as BufferSource,
    data
  );
  if (!ok) throw new Error('Invalid token signature');

  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as Record<string, unknown>;
  if (!ISSUERS.includes(String(payload.iss))) throw new Error('Invalid token issuer');
  if (String(payload.aud) !== expectedAudience) throw new Error('Token audience mismatch');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now - 60) throw new Error('Token expired');
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new Error('Google account email is not verified');
  }
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw new Error('Token missing subject or email');
  }

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    email_verified: true,
    name: typeof payload.name === 'string' ? payload.name : '',
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  };
}
