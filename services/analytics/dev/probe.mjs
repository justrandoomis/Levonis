#!/usr/bin/env node
/**
 * The local rig's proof for `levonis-analytics`.
 *
 * Drives the service as a REAL Worker inside workerd — over a REAL service
 * binding, against a REAL local D1 — which is what the unit suites cannot do.
 * Start the rig first (see README.md):
 *
 *   npx wrangler d1 execute levonis-analytics-db-dark --local \
 *       -c services/analytics/wrangler.jsonc --env dark \
 *       --file services/analytics/migrations/0001_analytics_init.sql \
 *       --persist-to .wrangler/dev-analytics
 *
 *   npx wrangler dev -c services/analytics/dev/producer-stub/wrangler.jsonc \
 *                    -c services/analytics/wrangler.jsonc \
 *                    --env dark --port 8813 --persist-to .wrangler/dev-analytics
 *
 *   node services/analytics/dev/probe.mjs http://localhost:8813
 *
 * Nothing here touches Cloudflare: local workerd, a local stub, a local SQLite
 * file. No account, no deploy, no outbound network.
 */
import http from 'node:http';

const base = new URL(process.argv[2] || 'http://localhost:8813');

function call(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: base.hostname, port: base.port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          /* left null on purpose: the assertion prints the raw text */
        }
        resolve({ status: res.statusCode, text, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failures += 1;
    results.push(`  FAIL ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const DAY = new Date().toISOString().slice(0, 10);
const MERCHANT = 'mch_rig';

console.log(`analytics rig probe → ${base.origin}\n`);

await check('the service is healthy behind the binding', async () => {
  const res = await call('/health');
  must(res.status === 200, `status ${res.status}: ${res.text.slice(0, 200)}`);
  must(res.body?.ok === true, res.text.slice(0, 200));
  must(res.body?.svc === 'analytics', `svc ${res.body?.svc}`);
  must(res.body?.checks?.db === 'ok', 'the local D1 is not reachable — did the migration step run?');
  return `ver=${res.body.ver}`;
});

await check('four signed envelopes are verified against the published keys and ingested', async () => {
  const res = await call(`/emit/seed?merchant=${MERCHANT}`);
  const outcomes = (res.body?.result?.results ?? []).map((r) => r.result);
  must(outcomes.length === 4, `got ${JSON.stringify(res.body).slice(0, 300)}`);
  must(
    outcomes.every((o) => o === 'acked'),
    `outcomes ${outcomes.join(',')}`
  );
  return outcomes.join(',');
});

await check('a personal envelope is refused whatever the transport says', async () => {
  const res = await call('/emit/personal');
  const outcome = res.body?.result?.results?.[0]?.result;
  must(outcome === 'pii_refused' || outcome === 'invalid', `outcome ${JSON.stringify(res.body?.result)}`);
  return outcome;
});

let ordersAfterSeed = 0;
await check('the counters are there, and the overview reads them', async () => {
  const res = await call('/overview');
  must(res.body?.orders, res.text.slice(0, 200));
  ordersAfterSeed = res.body.orders.total;
  must(ordersAfterSeed === 2, `orders.total ${ordersAfterSeed}`);
  must(res.body.orders.delivered === 1, `orders.delivered ${res.body.orders.delivered}`);
  must(res.body.users.total === 1, `users.total ${res.body.users.total}`);
  must(res.body.users.investors === 0, 'investors is a number Analytics may never know');
  return `orders=${ordersAfterSeed} delivered=${res.body.orders.delivered}`;
});

await check('a redelivery adds nothing to the rollups', async () => {
  const res = await call('/emit/twice');
  must(res.body?.first?.results?.[0]?.result === 'acked', `first ${JSON.stringify(res.body?.first)}`);
  must(res.body?.second?.results?.[0]?.result === 'replayed', `second ${JSON.stringify(res.body?.second)}`);
  const after = (await call('/overview')).body.orders.total;
  must(after === ordersAfterSeed + 1, `orders.total went ${ordersAfterSeed} → ${after}; a replay was counted`);
  ordersAfterSeed = after;
  return `orders=${after} after one new order and one replay`;
});

await check('the daily series carries today', async () => {
  const res = await call('/daily?metric=orders_created');
  const today = (res.body ?? []).find((p) => p.day === DAY);
  must(today, `no point for ${DAY}: ${res.text.slice(0, 200)}`);
  must(today.value === ordersAfterSeed, `value ${today.value} vs overview ${ordersAfterSeed}`);
  return `${DAY}=${today.value}`;
});

await check('the merchant rollup holds only the merchant`s own order', async () => {
  const res = await call(`/merchant?merchant=${MERCHANT}`);
  const created = (res.body ?? []).find((p) => p.metric === 'orders_created');
  must(created, `no orders_created: ${res.text.slice(0, 200)}`);
  must(created.value === 1, `merchant orders_created ${created.value} (the platform order must not be counted here)`);
  return `${MERCHANT}: ${(res.body ?? []).length} metrics`;
});

await check('the HTTP surface refuses an unsigned caller and answers a signed admin', async () => {
  const anon = await call('/http?as=none');
  must(anon.status === 401, `anonymous got ${anon.status}`);
  const admin = await call('/http?as=admin');
  must(admin.status === 200, `admin got ${admin.status}: ${admin.text.slice(0, 200)}`);
  must(admin.body?.success === true, admin.text.slice(0, 200));
  return `401 then 200`;
});

await check('a merchant reads its own numbers over HTTP and nobody else`s', async () => {
  const own = await call(`/http?as=${MERCHANT}&path=${encodeURIComponent(`/api/v1/analytics/merchant/daily?merchant_id=${MERCHANT}`)}`);
  must(own.status === 200, `own numbers got ${own.status}: ${own.text.slice(0, 200)}`);
  const theirs = await call(`/http?as=${MERCHANT}&path=${encodeURIComponent('/api/v1/analytics/merchant/daily?merchant_id=mch_someone_else')}`);
  must(theirs.status === 403, `another store's numbers got ${theirs.status}`);
  return '200 own, 403 other';
});

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
