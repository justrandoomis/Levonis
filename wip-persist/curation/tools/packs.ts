import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { extractPage } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/extract';
import { describe } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/describe';
const S = '/tmp/claude-0/-home-user-Levonis/aa8068a2-6eee-5a26-9836-675f1c2740c2/scratchpad/corpus/p0/raw/';
for (const h of ['hwb-pumpkinfamily', 'hwb-hauntedhouse', 'pla-cmyk-lithophane']) {
  const x = extractPage(gunzipSync(readFileSync(S + h + '.html.gz')).toString('utf8')).extraction;
  const d = describe(x.description);
  console.log('==', h, '|', x.title, '| groups:', x.groups.map((g) => `${g.title}: ${g.values.map((v) => v.value).join(', ')}`).join(' / '));
  const text = d.sections.flatMap((s) => s.blocks.map((b: any) => b.text ?? (b.items ? b.items.join('; ') : ''))).join(' ').replace(/\s+/g, ' ');
  console.log(text.slice(0, 700));
}
