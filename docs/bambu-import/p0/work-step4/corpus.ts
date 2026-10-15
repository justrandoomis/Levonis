/**
 * (Copied into p0/work/step4 for the final pass; unchanged logic.) Parses every crawled page (decompressed in memory, never written) with the
 * step 4 package and writes p0/parse-report.json. Scratch tool; not committed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { step4CodeState } from './codestate';
import { gunzipSync } from 'node:zlib';
import { extractPage, identityCrossCheck, ExtractError } from '/home/user/levonis-import/packages/catalog/src/bambuImport/extract';
import { buildImportPayload, assertImportPayload, ImportPayloadRefused } from '/home/user/levonis-import/packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '/home/user/levonis-import/packages/catalog/src/bambuImport/fingerprint';
import { harvestCrossSell } from '/home/user/levonis-import/packages/catalog/src/bambuImport/crossSell';
import { KNOWN_ROUTE_L1 } from '/home/user/levonis-import/packages/catalog/src/bambuImport/registry/types';
import { parseFlight } from '/home/user/levonis-import/packages/catalog/src/bambuImport/rsc';

const P0 = '/tmp/claude-0/-home-user-Levonis/f168c507-ccde-51da-80be-0fda576cd519/scratchpad/bambu/p0';
const manifest = JSON.parse(readFileSync(`${P0}/manifest.json`, 'utf8'));
const targets = JSON.parse(readFileSync(`${P0}/compat-targets.json`, 'utf8'));
const identity = JSON.parse(readFileSync(`${P0}/identity-map.json`, 'utf8')).entries ?? {};
const only = process.argv.slice(2);
const rows: any[] = manifest.rows.filter((r: any) => !only.length || only.includes(r.handle));
const FORMAT_LETTER: Record<string, string> = { legacy_html: 'A', sections_html: 'B', page_builder: 'C', bespoke_shopify_port: 'D1', bespoke_new: 'D2', component_list: 'E', none: '-' };
const fileOf = (h: string) => `${P0}/raw/${h.replace(/[^A-Za-z0-9._-]/g, '_')}.html.gz`;

const items: any[] = [];
const unknown = new Map<string, number>();
const unknownRoutes = new Map<string, number>();
const t0 = Date.now();
for (const [n, r] of rows.entries()) {
  const it: any = { handle: r.handle, source_product_id: r.source_product_id, manifest_type: r.type, queue_position: r.queue_position, status: 'ok', errors: [], holds: [] };
  const started = Date.now();
  try {
    const html = gunzipSync(readFileSync(fileOf(r.handle))).toString('utf8');
    it.html_bytes = html.length;
    const page = extractPage(html);
    const x = page.extraction;
    it.flight = { rows: page.stats.rows, bad_rows: page.stats.badRows, bytes: page.stats.bytes };
    it.product_candidates = page.productCandidates;
    it.reads = page.reads.length;
    if (x.handle !== r.handle) it.errors.push(`HANDLE_MISMATCH`);
    if (x.sourceProductId !== String(r.source_product_id)) it.errors.push('SOURCE_ID_MISMATCH');
    const idc = identityCrossCheck(x);
    if (!idc.ok) it.errors.push(...idc.problems.map((p) => `IDENTITY_AMBIGUOUS:${p}`));
    const l1 = x.route.split('>')[0]?.trim() ?? '';
    if (!KNOWN_ROUTE_L1.has(l1)) unknownRoutes.set(l1, (unknownRoutes.get(l1) ?? 0) + 1);
    // Cross-sell harvest on this page (codes for any product).
    const flight = parseFlight(html);
    const harvest = harvestCrossSell(flight.rows, new Set());
    it.cross_sell_codes_seen = harvest.length;
    const res = buildImportPayload({
      extraction: x,
      writeMode: 'create',
      extractionSha256: extractionFingerprint(x),
      skuCodes: r.sku_codes ?? {},
      identity: identity[r.handle] ?? null,
      targets,
      retrievedAt: '2026-10-15T00:00:00Z',
    });
    const rep = res.report;
    it.product_type = rep.productType;
    it.format = FORMAT_LETTER[rep.format] ?? rep.format;
    it.manifest_format = r.description_format ?? '';
    it.counts = rep.counts;
    it.option_groups = rep.counts.groups;
    it.option_values = rep.counts.values;
    it.variants = rep.counts.variants;
    it.media = { gallery_rows: rep.counts.images, distinct: rep.counts.distinct_images, swatches: rep.counts.swatches, content_images: rep.counts.content_images, content_images_omitted: rep.counts.content_images_omitted, box_images: rep.counts.box_images, shares_image_with_siblings: res.media.report.sharesImageWithSiblings.length, heroes_not_in_gallery: res.media.report.heroesNotInGallery.length, review_list: res.media.report.reviewList.length, collapsed: res.media.report.collapsed.length };
    it.specs_by_status = rep.specsByStatus;
    it.specs_by_region = rep.specsByRegion;
    it.relations_by_state = rep.relationsByState;
    it.sentence_counts = rep.sentenceCounts;
    it.unknown_labels = rep.unknownLabels.length;
    it.sold_out_variants = rep.soldOutCount;
    for (const l of rep.unknownLabels) unknown.set(l, (unknown.get(l) ?? 0) + 1);
    if (rep.errors.length) it.errors.push(...rep.errors);
    if (rep.hold) it.holds.push(rep.hold);
    if (r.hold_code && !it.holds.includes(r.hold_code)) it.holds.push(`manifest:${r.hold_code}`);
    try {
      assertImportPayload(JSON.parse(JSON.stringify(res.payload)));
      it.allow_list = 'ok';
    } catch (e) {
      if (!(e instanceof ImportPayloadRefused)) throw e;
      it.allow_list = `${e.reason}${e.textClass ? `:${e.textClass}` : ''} at ${e.path.replace(/\[\d+\]/g, '[]')}`;
      it.holds.push(`IMPORT_PAYLOAD_KEY_REFUSED:${e.reason}${e.textClass ? `:${e.textClass}` : ''}`);
    }
    it.payload_bytes = JSON.stringify(res.payload).length;
    if (it.errors.length) it.status = 'blocked';
    else if (it.holds.length) it.status = 'hold';
  } catch (e) {
    it.status = 'failed';
    it.errors.push(e instanceof ExtractError ? `${e.code}` : `EXCEPTION:${(e as Error).name}:${String((e as Error).message).slice(0, 160)}`);
    it.stack = String((e as Error).stack ?? '').split('\n').slice(0, 4).join(' | ').slice(0, 400);
  }
  it.ms = Date.now() - started;
  items.push(it);
  if ((n + 1) % 50 === 0) console.error(`${n + 1}/${rows.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

const byType: Record<string, Record<string, number>> = {};
for (const it of items) {
  const k = it.manifest_type ?? '?';
  byType[k] ??= { total: 0, ok: 0, hold: 0, blocked: 0, failed: 0 };
  byType[k].total++;
  byType[k][it.status]++;
}
const tally = (f: (it: any) => string[]) => {
  const m: Record<string, number> = {};
  for (const it of items) for (const k of f(it)) m[k] = (m[k] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
};
const sum = (f: (it: any) => number) => items.reduce((n, it) => n + (f(it) || 0), 0);
const report = {
  version: 1,
  step4_code: step4CodeState(),
  generated_at: new Date().toISOString(),
  generated_by: 'step 4 package (packages/catalog/src/bambuImport) over p0/raw, decompressed in memory',
  pages: items.length,
  totals: {
    ok: items.filter((i) => i.status === 'ok').length,
    hold: items.filter((i) => i.status === 'hold').length,
    blocked: items.filter((i) => i.status === 'blocked').length,
    failed: items.filter((i) => i.status === 'failed').length,
  },
  by_type: byType,
  by_format: tally((i) => [i.format ?? '?']),
  format_disagreements_with_manifest: items.filter((i) => i.manifest_format && i.format && i.manifest_format !== i.format).map((i) => ({ handle: i.handle, parsed: i.format, manifest: i.manifest_format })),
  by_product_type: tally((i) => [i.product_type ?? '?']),
  errors: tally((i) => i.errors.map((e: string) => e.split(':')[0])),
  holds: tally((i) => i.holds),
  allow_list_refusals: tally((i) => (i.allow_list && i.allow_list !== 'ok' ? [i.allow_list] : [])),
  sums: {
    option_groups: sum((i) => i.option_groups),
    option_values: sum((i) => i.option_values),
    variants: sum((i) => i.variants),
    gallery_rows: sum((i) => i.media?.gallery_rows),
    distinct_gallery_images: sum((i) => i.media?.distinct),
    swatches: sum((i) => i.media?.swatches),
    content_images: sum((i) => i.media?.content_images),
    content_images_omitted_by_cap: sum((i) => i.media?.content_images_omitted),
    box_images: sum((i) => i.media?.box_images),
    specs: sum((i) => i.counts?.specs),
    documents: sum((i) => i.counts?.documents),
    relations: sum((i) => i.counts?.relations),
    sold_out_variants: sum((i) => i.sold_out_variants),
  },
  specs_by_status: tally((i) => Object.entries(i.specs_by_status ?? {}).flatMap(([k, n]) => Array(n as number).fill(k))),
  specs_by_region: tally((i) => Object.entries(i.specs_by_region ?? {}).flatMap(([k, n]) => Array(n as number).fill(k))),
  relations_by_state: tally((i) => Object.entries(i.relations_by_state ?? {}).flatMap(([k, n]) => Array(n as number).fill(k))),
  sentence_counts: tally((i) => Object.entries(i.sentence_counts ?? {}).flatMap(([k, n]) => Array(n as number).fill(k))),
  unknown_route_l1: Object.fromEntries(unknownRoutes),
  top_unknown_labels: [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50),
  slowest_ms: [...items].sort((a, b) => b.ms - a.ms).slice(0, 5).map((i) => [i.handle, i.ms]),
  items,
};
const out = only.length ? `${P0}/../work/parse-report.partial.json` : `${P0}/parse-report.json`;
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ out, pages: report.pages, totals: report.totals, by_type: report.by_type, errors: report.errors, holds: report.holds, allow_list_refusals: report.allow_list_refusals, by_format: report.by_format, fmt_disagree: report.format_disagreements_with_manifest.length, unknown_route_l1: report.unknown_route_l1, secs: (Date.now() - t0) / 1000 }, null, 1));
