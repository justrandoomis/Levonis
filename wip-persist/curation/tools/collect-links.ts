/** Offline: parse each curated product's corpus page and list the official document / wiki / tracker links it gives. */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { extractPage } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/extract';
import { describe } from '/home/user/levonis-curated/packages/catalog/src/bambuImport/describe';

const S = '/tmp/claude-0/-home-user-Levonis/aa8068a2-6eee-5a26-9836-675f1c2740c2/scratchpad';
const manifest = JSON.parse(readFileSync('/home/user/Levonis/docs/bambu-import/p0/manifest.json', 'utf8'));
const rows = manifest.rows.filter((r: any) => r.curated);
const out: any[] = [];
const rawCount = new Map<string, number>();
for (const r of rows) {
  const safe = r.handle.replace(/[^A-Za-z0-9._-]/g, '_');
  const f = `${S}/corpus/p0/raw/${safe}.html.gz`;
  if (!existsSync(f)) { out.push({ handle: r.handle, type: r.type, subtype: r.subtype, title: r.title, withdrawn: true }); continue; }
  const html = gunzipSync(readFileSync(f)).toString('utf8');
  const px = extractPage(html);
  const x = px.extraction;
  const d = describe(x.description);
  const links: any[] = [];
  const push = (src: string, l: { url: string; text: string; via?: string; section?: string }) => links.push({ src, url: l.url, text: l.text, via: l.via ?? '', section: l.section ?? '' });
  for (const l of d.documents) push('documents', l);
  for (const l of d.wikiLinks) push('wiki', l);
  for (const l of d.trackerLinks) push('tracker', l);
  for (const l of d.otherLinks) push('other', l);
  // variant notes and features: run the same describer on their HTML
  for (const s of x.skus) if (s.description) { const dd = describe({ kind: 'legacy_html', html: s.description }); for (const l of [...dd.documents, ...dd.wikiLinks, ...dd.trackerLinks]) push('sku:' + s.id, l); }
  for (const ft of x.features) { const dd = describe({ kind: 'legacy_html', html: ft.html }); for (const l of [...dd.documents, ...dd.wikiLinks, ...dd.trackerLinks]) push('feature', l); }
  // raw scan (for a cross-check only)
  const raw = new Set<string>();
  for (const m of html.matchAll(/https?:(?:\\?\/){2}(?:store\.bblcdn\.com|wiki\.bambulab\.com|e\.bambulab\.com|cdn\.shopify\.com|public-cdn\.bblmw\.com|[a-z0-9.-]*bambulab\.com)[^"'\s<>\\)]*/gi)) {
    const u = m[0].replace(/\\\//g, '/');
    if (/\.(png|jpe?g|webp|gif|svg|mp4|css|js|woff2?|ico)(\?|$)/i.test(u)) continue;
    if (/us\.store\.bambulab\.com|\/\/store\.bambulab\.com|bambulab\.com\/(?:en|_next)/i.test(u) && !/\.pdf/i.test(u)) continue;
    raw.add(u);
  }
  for (const u of raw) rawCount.set(u, (rawCount.get(u) ?? 0) + 1);
  out.push({ handle: r.handle, type: r.type, subtype: r.subtype, title: r.title, format: d.format, links, raw: [...raw] });
}
// raw URLs present on many pages are site chrome
const common = new Set([...rawCount].filter(([, n]) => n >= 20).map(([u]) => u));
for (const o of out) if (o.raw) o.raw = o.raw.filter((u: string) => !common.has(u));
writeFileSync(`${S}/curation/links.json`, JSON.stringify({ common: [...common], products: out }, null, 1));
console.log('products', out.length, 'common', common.size);
