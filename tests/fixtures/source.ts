/**
 * Reading source for STATIC tests: the file with its comments removed, so an
 * assertion about code is never satisfied — or failed — by prose.
 *
 * String-aware on purpose. A route path such as `'/invest/*'` or
 * `'/profiles/*'` holds a `/*` that a regex stripper reads as the start of a
 * block comment, silently deleting the code after it; this walks string
 * literals ('…', "…", `…`) and only strips `//` and `/* … *\/` outside them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './d1';

export function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += source[++i] ?? '';
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** A repository file, as text. */
export const sourceOf = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** A repository file with its comments removed. */
export const codeOf = (rel: string) => stripComments(sourceOf(rel));
