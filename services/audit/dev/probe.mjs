#!/usr/bin/env node
/**
 * The local rig's proof for `levonis-audit`.
 *
 * Drives the service as a REAL Worker inside workerd — reached over a REAL
 * service binding, writing to a REAL local D1 — which is the one thing the unit
 * suites cannot do, because they call the consumer in process and hand it a
 * SQLite shim. Start the rig first (see README.md):
 *
 *   npx wrangler d1 execute levonis-audit-db-dark --local \
 *       -c services/audit/wrangler.jsonc --env dark \
 *       --file services/audit/migrations/0001_audit_init.sql \
 *       --persist-to .wrangler/dev-audit
 *
 *   npx wrangler dev -c services/audit/dev/producer-stub/wrangler.jsonc \
 *                    -c services/audit/wrangler.jsonc \
 *                    --env dark --port 8811 --persist-to .wrangler/dev-audit
 *
 *   node services/audit/dev/probe.mjs http://localhost:8811
 *
 * Nothing here touches Cloudflare: `wrangler dev` runs workerd locally, the
 * stub is a local file, the database is a local SQLite file. No account, no
 * deploy, no outbound network.
 */
import http from 'node:http';

const base = new URL(process.argv[2] || 'http://localhost:8811');

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
          /* left null on purpose: the assertion below prints the raw text */
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
const outcome = (res) => res.body?.result?.results?.[0]?.result ?? JSON.stringify(res.body).slice(0, 200);

console.log(`audit rig probe → ${base.origin}\n`);

await check('the service is healthy behind the binding', async () => {
  const res = await call('/health');
  must(res.status === 200, `status ${res.status}: ${res.text.slice(0, 200)}`);
  must(res.body?.ok === true, `health not ok: ${res.text.slice(0, 200)}`);
  must(res.body?.svc === 'audit', `svc ${res.body?.svc}`);
  must(res.body?.checks?.db === 'ok', 'the local D1 is not reachable — did the migration step run?');
  return `ver=${res.body.ver} chain=${res.body.checks?.deps?.[0]?.ver ?? '?'}`;
});

await check('an AuditRecorded envelope is verified against the published key and recorded', async () => {
  const res = await call('/emit/audit-recorded?action=wallet.credit&target=wallet:usr_dev');
  must(outcome(res) === 'acked', `outcome ${outcome(res)}`);
  return res.body.event_id;
});

await check('a RoleChanged envelope from Identity is recorded too', async () => {
  const res = await call('/emit/role-changed?user=usr_dev&actor=usr_admin');
  must(outcome(res) === 'acked', `outcome ${outcome(res)}`);
  return res.body.event_id;
});

await check('the same envelope twice is acked once and replayed once', async () => {
  const res = await call('/emit/twice');
  must(res.body?.first?.results?.[0]?.result === 'acked', `first ${JSON.stringify(res.body?.first)}`);
  must(res.body?.second?.results?.[0]?.result === 'replayed', `second ${JSON.stringify(res.body?.second)}`);
  return 'acked, then replayed';
});

await check('a tampered envelope is refused as forged', async () => {
  const res = await call('/emit/forged');
  must(res.body?.result?.results?.[0]?.result === 'forged', `outcome ${JSON.stringify(res.body?.result)}`);
  return 'refused';
});

await check('record() writes a direct entry over RPC', async () => {
  const res = await call('/record?action=admin.settings_changed&target=settings:exchangeRate');
  must(res.body?.ok === true, JSON.stringify(res.body));
  must(res.body?.replayed === false, 'a fresh id must not report a replay');
  return res.body.event_id;
});

await check('query() returns the entries, newest first, with chain hashes', async () => {
  const res = await call('/query?limit=10');
  const rows = res.body?.rows ?? [];
  must(rows.length >= 4, `only ${rows.length} rows`);
  must(rows[0].seq > rows[1].seq, 'not newest-first');
  must(rows.some((r) => r.action === 'wallet.credit'), 'the recorded action is missing');
  const sealed = rows.filter((r) => r.hash);
  must(sealed.length >= 1, 'nothing was chained — the post-delivery seal did not run');
  return `${rows.length} rows, ${sealed.length} chained`;
});

await check('verifyChain() walks the chain and finds it intact', async () => {
  const res = await call('/verify');
  must(res.body?.ok === true, JSON.stringify(res.body));
  must(res.body?.checked >= 1, `checked ${res.body?.checked}`);
  must(/^[0-9a-f]{64}$/.test(res.body?.head ?? ''), `head ${res.body?.head}`);
  must(res.body?.anchored_head === null, 'nothing is anchored to R2 in Phase 1');
  return `checked=${res.body.checked}`;
});

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
