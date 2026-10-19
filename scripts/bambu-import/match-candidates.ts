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
import { manifestEntries, matchCandidates, tablesOf } from '@levonis/catalog/bambuImport/matchSignals';

// The rule itself is pure and shared with the Worker's delta gate (packages/catalog/src/bambuImport/matchSignals.ts).
export * from '@levonis/catalog/bambuImport/matchSignals';

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
