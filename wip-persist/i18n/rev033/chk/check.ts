import { readFileSync } from 'node:fs';
import { validateTranslationRow } from '/home/user/levonis-i18n/packages/catalog/src/bambuImport/i18n.ts';
import { IDENTITY_TERMS } from '/home/user/levonis-i18n/worker/lib/translate/dictionary.ts';
const D = '/tmp/claude-0/-home-user-Levonis/aa8068a2-6eee-5a26-9836-675f1c2740c2/scratchpad/i18n';
const file = process.argv[2];
const names = new Set<string>(JSON.parse(readFileSync(D + '/names.json', 'utf8')).names);
const identity = new Set(IDENTITY_TERMS);
const rows = JSON.parse(readFileSync(file, 'utf8')) as any[];
let ok = 0, keep = 0; const bad: string[] = [];
for (const r of rows) {
  if (r.keep) { keep++; continue; }
  const kind = 'usage_body';
  const v = validateTranslationRow({ h: r.h, en: r.en, ar: r.ar, ckb: r.ckb, kind, status: 'reviewed', products: ['p1'] }, { names, identity });
  if (v.ok) ok++; else bad.push(`${v.code} :: ${r.en.slice(0, 90)}`);
}
console.log(JSON.stringify({ total: rows.length, ok, keep, bad }, null, 1));
