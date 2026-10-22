/**
 * PRINTER TOKENS AS ENUM-SAFE ALIASES (assistant plan push B, §6.3). PURE.
 *
 * Push A's printer tokens carry spaces and capitals ('A1 mini', 'H2D Pro').
 * The enums a model answers in use one lowercase `[a-z0-9_]` alias per token
 * instead, so a schema enum never depends on whitespace or case; the
 * validators map an alias back to its token and refuse anything else.
 * tests/aiSchemas.test.ts checks they are unique and round-trip.
 */
import { MODEL_TOKENS, type ModelToken } from '../types';

export const aliasOfToken = (token: ModelToken): string => token.toLowerCase().replace(/[^a-z0-9]+/g, '_');

/** alias → token, generated from push A's closed set. */
export const MODEL_ALIAS: Readonly<Record<string, ModelToken>> = Object.freeze(
  Object.fromEntries(MODEL_TOKENS.map((t) => [aliasOfToken(t), t]))
);

/** Every alias, in push A's token order: the printer enum a model answers in. */
export const MODEL_ALIASES: readonly string[] = MODEL_TOKENS.map(aliasOfToken);

/** The token an alias names, or null. Case-insensitive, nothing else is accepted. */
export function tokenOfAlias(alias: unknown): ModelToken | null {
  if (typeof alias !== 'string') return null;
  return MODEL_ALIAS[alias.trim().toLowerCase()] ?? null;
}
