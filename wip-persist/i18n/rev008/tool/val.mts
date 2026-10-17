import { readFileSync } from 'node:fs';
import { validateTranslationRow, normalizeSource } from '/home/user/levonis-i18n/packages/catalog/src/bambuImport/i18n.ts';
import { IDENTITY } from '/home/user/levonis-i18n/scripts/bambu-import/i18nData.ts';
const [file, namesFile] = process.argv.slice(2);
const names = new Set<string>(JSON.parse(readFileSync(namesFile, 'utf8')).names);
const rows = JSON.parse(readFileSync(file, 'utf8'));
let bad = 0;
for (const r of rows) {
  const row = { h: r.h, en: r.en, ar: normalizeSource(r.ar), ckb: normalizeSource(r.ckb), kind: r.kind ?? 'box_item', status: 'reviewed', products: ['p1'] };
  const v = validateTranslationRow(row, { names, identity: IDENTITY });
  if (!v.ok) { bad++; console.log(v.code, JSON.stringify(r.en), '|', r.ar, '|', r.ckb); }
  if (row.ar !== r.ar || row.ckb !== r.ckb) console.log('NOT_NORMALIZED_RAW', JSON.stringify(r.en));
}
console.log('rows', rows.length, 'bad', bad);
