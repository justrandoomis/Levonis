import { readFileSync, writeFileSync } from 'node:fs';
import { parseFlight } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/rsc';
const html = readFileSync(process.argv[2], 'utf8');
const f: any = parseFlight(html);
const rows = f.rows as Map<string, unknown>;
for (const id of process.argv.slice(4)) {
  const v = rows.get(id);
  writeFileSync(`${process.argv[3]}/row_${id}.txt`, typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  console.log(id, typeof v, (typeof v === 'string' ? v : JSON.stringify(v)).length);
}
console.log(Object.keys(f));
