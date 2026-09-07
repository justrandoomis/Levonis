/**
 * Least-privilege checks over a service's `wrangler.jsonc` + `OWNERSHIP.json` +
 * `SECRETS.md` (`01-TARGET.md` §4 item 5, §1.1 "Visibility", ADR-011, ADR-015).
 * Pure so the rules are unit-tested against inline configs.
 */
import type { OwnershipManifest } from './boundaries';

/** Strips line and block comments and trailing commas (outside string literals) so wrangler.jsonc parses as JSON. */
export function parseJsonc(text: string): Record<string, unknown> {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // copy the whole string literal verbatim, honouring escapes
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end - 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    out += ch;
  }
  // trailing commas before } or ] — strings are already copied, so this cannot touch a literal containing ", }"
  let cleaned = '';
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < out.length && out[j] !== '"') {
        if (out[j] === '\\') j++;
        j++;
      }
      cleaned += out.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === ',') {
      let k = i + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    cleaned += ch;
  }
  return JSON.parse(cleaned) as Record<string, unknown>;
}

export interface WranglerLike {
  name?: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  routes?: unknown;
  route?: unknown;
  custom_domains?: unknown;
  services?: Array<{ binding: string; service: string; entrypoint?: string }>;
  env?: Record<string, WranglerLike>;
  [key: string]: unknown;
}

export const FORBIDDEN_GATEWAY_CALL = /Admin|\bset|credit|debit|decide|lookupContacts/;
export const GATEWAY_ALLOWED_CALLS = ['IDENTITY.resolveSession', 'IDENTITY.revoke', 'IDENTITY.getPublicKeys', 'IDENTITY.rateLimitHit', '*.deliver', '*.health', '*.forward'];

/** The binding a `calls` entry names: `IDENTITY.resolveSession` -> `IDENTITY`; `*.health` -> any. */
export function bindingOfCall(call: string): string {
  return call.split('.')[0];
}

export function checkVisibility(cfg: WranglerLike, opts: { isGateway: boolean; label: string }): string[] {
  const out: string[] = [];
  const check = (block: WranglerLike, where: string, isDark: boolean) => {
    if (block.workers_dev === undefined) out.push(`${opts.label} ${where}: workers_dev must be declared explicitly`);
    if (block.preview_urls === undefined) out.push(`${opts.label} ${where}: preview_urls must be declared explicitly`);
    if (block.preview_urls === true) out.push(`${opts.label} ${where}: preview_urls must be false (a version Preview URL bypasses every gateway control)`);
    if (block.workers_dev === true && !(isDark && !opts.isGateway)) out.push(`${opts.label} ${where}: workers_dev must be false (only dark non-gateway Workers may enable it)`);
    if (block.routes !== undefined || block.route !== undefined || block.custom_domains !== undefined) out.push(`${opts.label} ${where}: routes/custom_domains are dashboard-managed and never declared in the repo`);
  };
  check(cfg, 'top-level', false);
  for (const [env, block] of Object.entries(cfg.env ?? {})) check(block, `env.${env}`, env === 'dark');
  const name = cfg.name ?? '';
  if (/staging/.test(name) || Object.values(cfg.env ?? {}).some((b) => /staging/.test(b.name ?? ''))) out.push(`${opts.label}: a new Worker name must never contain "staging" (on this account that suffix means live)`);
  return out;
}

export function checkBindingsAgainstManifest(cfg: WranglerLike, manifest: OwnershipManifest, label: string): string[] {
  const out: string[] = [];
  const declared = new Set((manifest.calls ?? []).map(bindingOfCall));
  const blocks: Array<[string, WranglerLike]> = [['top-level', cfg], ...Object.entries(cfg.env ?? {}).map(([k, v]) => [`env.${k}`, v] as [string, WranglerLike])];
  for (const [where, block] of blocks) {
    for (const s of block.services ?? []) {
      if (!declared.has(s.binding) && !declared.has('*')) out.push(`${label} ${where}: services binding ${s.binding} is not declared in OWNERSHIP.json calls`);
    }
  }
  return out;
}

export function secretNamesIn(secretsMd: string): string[] {
  const out = new Set<string>();
  for (const m of secretsMd.matchAll(/^\s*[-*|]?\s*`?([A-Z][A-Z0-9_]{2,})`?\s*(?:[-–—:|]|$)/gm)) out.add(m[1]);
  return [...out];
}

export function checkSecrets(secretNames: string[], manifest: OwnershipManifest, label: string): string[] {
  const declared = new Set(manifest.secrets ?? []);
  return secretNames.filter((n) => !declared.has(n)).map((n) => `${label}: SECRETS.md names ${n} but OWNERSHIP.json secrets does not declare it`);
}

/** ADR-015: the gateway's key is on no privileged allowlist. */
export function checkGatewayCalls(manifest: OwnershipManifest, label: string): string[] {
  const out: string[] = [];
  for (const call of manifest.calls ?? []) {
    if (FORBIDDEN_GATEWAY_CALL.test(call)) out.push(`${label}: the gateway must never call ${call}`);
    if (!GATEWAY_ALLOWED_CALLS.includes(call) && !/^[A-Z_]+\.(forward|deliver|health)$/.test(call)) out.push(`${label}: ${call} is not in the gateway's pinned call set`);
  }
  return out;
}
