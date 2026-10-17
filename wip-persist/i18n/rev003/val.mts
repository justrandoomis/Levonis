// Runs the package's row validator over one translator out file.
// usage: npx tsx val.mts <out.json> <batch.json> <names.json>
import { readFileSync } from 'node:fs';
import { validateTranslationRow, TM_KINDS } from '/home/user/levonis-i18n/packages/catalog/src/bambuImport/i18n.ts';
import { IDENTITY } from '/home/user/levonis-i18n/scripts/bambu-import/i18nData.ts';

const [outPath, batchPath, namesPath] = process.argv.slice(2);
const out = JSON.parse(readFileSync(outPath, 'utf8')) as Array<Record<string, unknown>>;
const batch = JSON.parse(readFileSync(batchPath, 'utf8')) as { strings: Array<{ h: string; en: string; kind: string }> };
const names = new Set<string>((JSON.parse(readFileSync(namesPath, 'utf8')) as { names: string[] }).names);
names.add('Bambu Lab');
const byH = new Map(batch.strings.map((s) => [s.h, s]));
let ok = 0, keep = 0, bad = 0, missing = 0;
for (const r of out) {
  const s = byH.get(String(r.h));
  if (!s) { missing++; console.log('NOT_IN_BATCH', r.h); continue; }
  if (r.keep) { keep++; continue; }
  const kind = (TM_KINDS as readonly string[]).includes(s.kind) ? s.kind : TM_KINDS[0];
  const row = { h: s.h, en: s.en, ar: String(r.ar ?? ''), ckb: String(r.ckb ?? ''), kind, status: r.needs_review ? 'needs_review' : 'reviewed', products: ['p_review'] };
  const v = validateTranslationRow(row, { names, identity: IDENTITY });
  if (v.ok) ok++;
  else { bad++; console.log('FAIL', v.code, batch.strings.indexOf(s), JSON.stringify(s.en).slice(0, 160)); }
}
console.log(JSON.stringify({ rows: out.length, ok, keep, bad, missing, batchStrings: batch.strings.length }));
