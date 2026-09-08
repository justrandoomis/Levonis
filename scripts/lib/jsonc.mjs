/**
 * The one JSONC reader the deploy scripts share.
 *
 * `wrangler.jsonc` files in this repository are heavily commented on purpose —
 * the comments are where the "why" of a binding lives — so every script that
 * reads one needs to strip comments without touching string contents. This is
 * the same character walker `scripts/prepare-deploy-config.mjs` has always
 * used, lifted so the six deploy scripts cannot drift apart from it (a stripper
 * that mangles `"http://x//y"` is the classic way this goes wrong).
 */
import { readFileSync } from 'node:fs';

/** Strip `//` and block comments, then trailing commas. String contents are untouched. */
export function stripJsonComments(src) {
  let out = '';
  let inStr = false;
  let esc = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export const parseJsonc = (text) => JSON.parse(stripJsonComments(text));
export const readJsonc = (path) => parseJsonc(readFileSync(path, 'utf8'));

/**
 * The effective configuration of one environment: the named block if there is
 * one, otherwise the top level. Wrangler does NOT inherit most top-level keys
 * into a named environment, so this returns the block itself and leaves the
 * caller to decide what a missing key means — guessing here is how a dark
 * Worker would end up bound to the live database.
 */
export function envBlock(cfg, env) {
  if (!env || env === 'production' || env === 'top') return cfg;
  const block = cfg.env?.[env];
  if (!block) throw new Error(`environment "${env}" is not defined in this wrangler config`);
  return block;
}
