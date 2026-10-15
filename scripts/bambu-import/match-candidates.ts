/**
 * EXISTING-PRODUCT MATCH CANDIDATES (Bambu import spec §E.1; HANDOFF-PLAN §3.5).
 *
 * RUNS ONLY IN THE AGENT'S SANDBOX. It reads an UNSEALED live snapshot
 * (workflow 60 `mode=snapshot`, opened with unseal.mjs) and the manifest, and
 * writes the candidate set for the reviewer to the path given on the command
 * line — never anywhere else, never inside a git checkout, never over an
 * existing file (mode 0600). The output holds private data (names and slugs of
 * hidden and draft products, owner-only image provenance): it is never
 * committed and never uploaded. It refuses to run inside GitHub Actions.
 *
 *   node --import tsx scripts/bambu-import/match-candidates.ts \
 *        --snapshot <snapshot.json> --manifest <manifest.json> --out <file outside the checkout>
 *
 * SIGNALS (§E.1.1), per Levonis product:
 *   - brand Bambu (brands.slug 'bambu-lab', or the legacy brand text);
 *   - model tokens of the registry (A1, A1 mini, P1S, X1C, H2D, AMS lite …) and
 *     material tokens (PLA Basic, PETG HF …) shared with a manifest title;
 *   - existing image `source_url` on store.bblcdn.com / cdn.shopify.com;
 *   - a slug / handle overlap.
 * Names are evidence for review only (§13): a candidate is never a decision.
 * The reviewer writes `existing-matches.json` (ids, public slugs, a decision,
 * a reason code) by hand from this list.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { modelsInText } from '@levonis/catalog/bambuImport/registry/models';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const rows = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);

export interface SnapshotTables {
  products: Rec[];
  brands: Rec[];
  image_sources: Rec[];
  option_values: Rec[];
  colors: Rec[];
}

export interface ManifestEntry {
  source_product_id: string;
  handle: string;
  title: string;
  type: string;
}

const MATERIAL = /\b(PLA|PETG|ABS|ASA|TPU|PCTG|PC|PAHT|PA6|PA|PPA|PET|PVA|HIPS|PPS|PEEK|BVOH)(?:[- ]?(CF|GF|HF))?(?:\s+(Basic|Matte|Silk\+?|Lite|Tough\+?|Translucent|Metal|Marble|Sparkle|Galaxy|Glow|Aero|Wood|Dynamic|Gradient|Pro|Pure|Support|Wood|Galaxy|for AMS|90A|95A|68D|Breakaway))?\b/g;

/** Material tokens of a title ("PLA Basic", "PETG-HF", "TPU 95A"), normalised. */
export function materialTokens(title: string): string[] {
  const out = new Set<string>();
  for (const m of title.matchAll(MATERIAL)) {
    const base = m[1].toUpperCase();
    const fibre = m[2] ? `-${m[2].toUpperCase()}` : '';
    const line = m[3] ? ` ${m[3].toLowerCase()}` : '';
    out.add(`${base}${fibre}${line}`);
  }
  return [...out];
}

export function modelTokens(title: string): string[] {
  return [...new Set(modelsInText(title).map((m) => m.token))];
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/^bambu-lab-|^bambu-/, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !['bambu', 'lab', 'the', 'and', 'for', 'with', '3d', 'printer'].includes(w));

/** A slug and a handle overlap: one contains the other, or they share most of their words. */
export function slugOverlap(slug: string, handle: string): boolean {
  const a = words(slug);
  const b = words(handle);
  if (!a.length || !b.length) return false;
  const sa = a.join('-');
  const sb = b.join('-');
  if (sa === sb || sa.includes(sb) || sb.includes(sa)) return true;
  const set = new Set(a);
  const shared = b.filter((w) => set.has(w)).length;
  return shared / Math.max(a.length, b.length) >= 0.6;
}

export interface Candidate {
  source_product_id: string;
  handle: string;
  title: string;
  score: number;
  reasons: string[];
}

export interface ProductCandidates {
  levonis_product_id: string;
  /** Present only for an ACTIVE product (the only slugs a committed file may carry). */
  levonis_slug: string;
  status: string;
  /** For the reviewer's eyes only (§13: names never merge on their own). */
  name: string;
  signals: { brand_bambu: boolean; bambu_image_sources: number; model_tokens: string[]; material_tokens: string[] };
  candidates: Candidate[];
}

export function tablesOf(snapshot: unknown): SnapshotTables {
  const t = isRec(snapshot) && isRec(snapshot.tables) ? snapshot.tables : {};
  return { products: rows(t.products), brands: rows(t.brands), image_sources: rows(t.image_sources), option_values: rows(t.option_values), colors: rows(t.colors) };
}

export function manifestEntries(manifest: unknown): ManifestEntry[] {
  const list = isRec(manifest) && Array.isArray(manifest.rows) ? manifest.rows : Array.isArray(manifest) ? manifest : [];
  return rows(list).map((r) => ({ source_product_id: str(r.source_product_id), handle: str(r.handle), title: str(r.title), type: str(r.type) }));
}

/** The §E.1 candidate set. Only products with a Bambu signal are considered. */
export function matchCandidates(tables: SnapshotTables, manifest: readonly ManifestEntry[]): ProductCandidates[] {
  const bambuBrands = new Set(tables.brands.filter((b) => /^bambu(-lab)?$/.test(str(b.slug)) || /bambu/i.test(str(b.name_en))).map((b) => str(b.id)));
  const sources = new Map<string, number>();
  for (const s of tables.image_sources) {
    const url = str(s.source_url);
    if (/^https:\/\/(store\.bblcdn\.com|cdn\.shopify\.com)\//.test(url)) sources.set(str(s.product_id), (sources.get(str(s.product_id)) ?? 0) + 1);
  }
  const index = manifest.map((m) => ({ m, models: modelTokens(m.title), materials: materialTokens(m.title) }));
  const out: ProductCandidates[] = [];
  for (const p of tables.products) {
    const id = str(p.id);
    const name = str(p.name);
    const brand = bambuBrands.has(str(p.brand_id)) || /bambu/i.test(str(p.brand));
    const imageSources = sources.get(id) ?? 0;
    const models = modelTokens(`${name} ${str(p.slug).replace(/-/g, ' ')}`);
    const materials = materialTokens(name);
    if (!brand && imageSources === 0 && !/bambu/i.test(name)) continue;
    const candidates: Candidate[] = [];
    for (const { m, models: mm, materials: mat } of index) {
      const reasons: string[] = [];
      let score = 0;
      const sharedModels = models.filter((t) => mm.includes(t));
      const sharedMaterials = materials.filter((t) => mat.includes(t));
      if (sharedModels.length) {
        reasons.push(`model:${sharedModels.join('|')}`);
        score += 3 * sharedModels.length;
        // The same set of model tokens is a stronger hint than one shared family word.
        if (sharedModels.length === models.length && sharedModels.length === mm.length) score += 2;
      }
      if (sharedMaterials.length) {
        reasons.push(`material:${sharedMaterials.join('|')}`);
        score += 3 * sharedMaterials.length;
      }
      if (slugOverlap(str(p.slug), m.handle)) {
        reasons.push('slug_handle');
        score += 2;
      }
      if (!reasons.length) continue;
      if (brand) score += 1;
      if (imageSources) score += 1;
      candidates.push({ source_product_id: m.source_product_id, handle: m.handle, title: m.title, score, reasons });
    }
    candidates.sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle));
    const status = str(p.status);
    out.push({
      levonis_product_id: id,
      levonis_slug: status === 'active' ? str(p.slug) : '',
      status,
      name,
      signals: { brand_bambu: brand, bambu_image_sources: imageSources, model_tokens: models, material_tokens: materials },
      candidates: candidates.slice(0, 12),
    });
  }
  return out.sort((a, b) => a.levonis_product_id.localeCompare(b.levonis_product_id));
}

export class SandboxOnly extends Error {}

/** A path inside a git checkout is one `git add -A` away from a public repository. */
export function refuseCheckout(path: string): void {
  for (let at = dirname(resolve(path)); ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) throw new SandboxOnly(`refusing to write the candidates inside the git checkout at ${at}`);
    if (dirname(at) === at) return;
  }
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = (s) => process.stderr.write(`${s}\n`)): number {
  if (env.GITHUB_ACTIONS === 'true') {
    log('match-candidates: refused — it runs only in the agent sandbox, never in Actions');
    return 1;
  }
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1] ?? '');
  const snapshot = args.get('--snapshot');
  const manifest = args.get('--manifest');
  const out = args.get('--out');
  if (!snapshot || !manifest || !out || args.size !== 3) {
    log('usage: node --import tsx scripts/bambu-import/match-candidates.ts --snapshot <snapshot.json> --manifest <manifest.json> --out <file>');
    return 2;
  }
  try {
    refuseCheckout(out);
    const snapBytes = readFileSync(snapshot);
    const manBytes = readFileSync(manifest);
    const result = matchCandidates(tablesOf(JSON.parse(new TextDecoder().decode(snapBytes))), manifestEntries(JSON.parse(new TextDecoder().decode(manBytes))));
    const doc = {
      format: 'levonis-bambu-match-candidates/1',
      private: 'NEVER COMMIT OR UPLOAD: names and slugs of non-active products and owner-only image provenance',
      snapshot_sha256: createHash('sha256').update(snapBytes).digest('hex'),
      manifest_sha256: createHash('sha256').update(manBytes).digest('hex'),
      products: result,
    };
    writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    log(`match-candidates: ${result.length} Levonis products with a Bambu signal, ${result.filter((r) => r.candidates.length).length} with candidates; written to the given path`);
    return 0;
  } catch (err) {
    log(`match-candidates: refused — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
