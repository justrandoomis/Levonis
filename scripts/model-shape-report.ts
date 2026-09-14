/**
 * DID THE MERGE DO WHAT IT SAID, ON THE REAL DATABASE?
 *
 * Migration 0073 turns "A1 mini — Pre-order" + "A1 mini — Direct" into ONE
 * model with two order-type cells. A test proves that against a fixture; this
 * proves it against the rows that actually exist, which is the only evidence
 * that counts once the migration has run somewhere real.
 *
 * READ ONLY, by construction: every statement must begin with SELECT and must
 * not name a write, and the same guard as scripts/orphan-dry-run.ts enforces
 * it. Pointing this at production is safe because it cannot do anything else.
 *
 *   npx tsx scripts/model-shape-report.ts --db levonis-db-staging
 */
import { execFileSync } from 'node:child_process';
import { availabilityFromName } from '../worker/lib/availability';

const args = process.argv.slice(2);
const dbName = args[(args.indexOf('--db') + 1) || -1] ?? 'levonis-db-staging';
const remote = !args.includes('--local');

function assertReadOnly(sql: string): void {
  if (sql.trim().slice(0, 6).toUpperCase() !== 'SELECT') throw new Error(`refusing: ${sql.slice(0, 60)}`);
  if (/\b(DELETE|UPDATE|INSERT|DROP|ALTER|CREATE|REPLACE)\b/i.test(sql)) throw new Error(`refusing a write: ${sql.slice(0, 60)}`);
}

function query<T = Record<string, unknown>>(sql: string): T[] {
  assertReadOnly(sql);
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', dbName, remote ? '--remote' : '--local', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const start = out.indexOf('[');
  return (JSON.parse(out.slice(start >= 0 ? start : 0)) as Array<{ results?: T[] }>)[0]?.results ?? [];
}

const count = (sql: string): number => Number(query<{ n: number }>(sql)[0]?.n ?? 0);

const lines: string[] = [];
const say = (s = '') => lines.push(s);

say(`## Product model shape — \`${dbName}\`${remote ? ' (remote)' : ' (local)'}`);
say();
say('**Nothing was written. Every statement was a SELECT.**');
say();

let migrated = true;
try {
  count('SELECT COUNT(*) AS n FROM product_option_fulfillment');
} catch {
  migrated = false;
}

if (!migrated) {
  say('> Migration 0073 has not reached this database yet — there is nothing to report.');
} else {
  const products = count("SELECT COUNT(*) AS n FROM products WHERE status <> 'deleted'");
  const liveModels = count("SELECT COUNT(*) AS n FROM product_option_values WHERE merged_into = ''");
  const tombstones = count("SELECT COUNT(*) AS n FROM product_option_values WHERE merged_into <> ''");
  const cells = count('SELECT COUNT(*) AS n FROM product_option_fulfillment');
  const routes = count('SELECT COUNT(*) AS n FROM product_option_transports');
  const direct = count("SELECT COUNT(*) AS n FROM product_option_fulfillment WHERE fulfillment_type = 'direct_sale'");
  const pre = count("SELECT COUNT(*) AS n FROM product_option_fulfillment WHERE fulfillment_type = 'pre_order'");

  say('| figure | value |');
  say('| --- | ---: |');
  say(`| products (not deleted) | ${products} |`);
  say(`| LIVE models (\`merged_into = ''\`) | ${liveModels} |`);
  say(`| tombstones (merged away, kept for order history) | ${tombstones} |`);
  say(`| order-type cells | ${cells} — ${direct} direct, ${pre} pre-order |`);
  say(`| per-model route rows | ${routes} |`);
  say();

  /**
   * THE TWO THINGS THAT WOULD MEAN THE MERGE DID NOT TAKE.
   *
   * A live model still sharing a `variant_key` with another, and a live model
   * whose NAME still reads as an order type. Both are reported with their ids,
   * because a number alone would not let anyone fix one.
   */
  const dupes = query<{ product_id: string; variant_key: string; names: string; n: number }>(
    `SELECT product_id, variant_key, GROUP_CONCAT(name_en, ' | ') AS names, COUNT(*) AS n
       FROM product_option_values
      WHERE merged_into = '' AND variant_key <> '' AND active = 1
      GROUP BY product_id, group_id, variant_key
     HAVING COUNT(*) > 1`
  );
  say(`### Live models still sharing a variant_key: ${dupes.length}`);
  if (dupes.length) {
    say();
    say('| product | variant_key | rows | names |');
    say('| --- | --- | ---: | --- |');
    for (const d of dupes.slice(0, 50)) say(`| \`${d.product_id}\` | \`${d.variant_key}\` | ${d.n} | ${d.names} |`);
  }
  say();

  const named = query<{ id: string; product_id: string; name_en: string }>(
    "SELECT id, product_id, name_en FROM product_option_values WHERE merged_into = '' AND active = 1"
  ).filter((r) => availabilityFromName(String(r.name_en)));
  say(`### Live models whose NAME still reads as an order type: ${named.length}`);
  if (named.length) {
    say();
    say('| option | product | name |');
    say('| --- | --- | --- |');
    for (const r of named.slice(0, 50)) say(`| \`${r.id}\` | \`${r.product_id}\` | ${r.name_en} |`);
    say();
    say(
      '> A NAME is cosmetic: the row is one model with its own order-type cells either way. ' +
        'Migration 0073 renames a survivor only when 0043 stored a `variant_label` to rename it TO — ' +
        'inventing one by stripping words would turn "A1 mini Direct Drive" into "A1 mini".'
    );
  }
  say();

  // Cells pointing at a model that is gone would be the one way this could
  // leak; the delete registry covers it, and this says whether it ever did.
  const orphanCells = count(
    'SELECT COUNT(*) AS n FROM product_option_fulfillment WHERE option_id NOT IN (SELECT id FROM product_option_values)'
  );
  const orphanRoutes = count(
    'SELECT COUNT(*) AS n FROM product_option_transports WHERE fulfillment_id NOT IN (SELECT id FROM product_option_fulfillment)'
  );
  say(`- Cells naming a model that no longer exists: **${orphanCells}**`);
  say(`- Route rows naming a cell that no longer exists: **${orphanRoutes}**`);
  say(
    `- Cart lines carrying a stated order type: **${count(
      "SELECT COUNT(*) AS n FROM cart_items WHERE fulfillment_type <> ''"
    )}**`
  );
}

const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}
