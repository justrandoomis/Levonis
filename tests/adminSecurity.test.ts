/**
 * «الأمان» — THE OWNER'S SECURITY CONSOLE (worker/routes/adminSecurity.ts,
 * src/components/adminSecurity/; DECISIONS row 206), through the REAL Worker.
 *
 *   owner only     every other admin (assistant, full, legacy), the owner row
 *                  before its address is verified, a customer and a guest are
 *                  refused — one body for a real and an invented id
 *   no secrets     lists and the incident view hold no address, user agent,
 *                  password, token or query string; «ما الذي أُعطي له» is the
 *                  decoy answer regenerated from its batch, byte for byte
 *   lift           one block or the whole incident: the next request passes,
 *                  the scores reset, an audit row is written
 *   words          every string in Arabic, English and real Sorani — never a
 *                  copy of the Arabic, never an Arabic-only letter
 *
 * Local only. Run: node --import tsx --test tests/adminSecurity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json } from './fixtures/app';
import { ATTACKER_IP, OTHER_IP, SCRIPT, TYPED, blocks, deceptionWorld, setCookieValue, type Who } from './fixtures/deception';
import { sourceOf } from './fixtures/source';
import { SECURITY_STRINGS, EVENT_CODE_TEXT } from '../src/components/adminSecurity/strings';
import { ACCESS_BLOCKED_TEXT } from '../src/components/security/AccessBlockedScreen';
import { BLOCK_STRINGS, DECEPTION_BELL } from '../worker/lib/deception/strings';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const ROUTES: Array<[string, string]> = [
  ['GET', '/api/admin/security/summary'],
  ['GET', '/api/admin/security/blocks?state=all'],
  ['GET', '/api/admin/security/events'],
  ['GET', '/api/admin/security/scores'],
  ['GET', '/api/admin/security/incidents/:id'],
  ['POST', '/api/admin/security/blocks/:id/lift'],
];

test('OWNER ONLY: every other admin, the unverified owner, a customer and a guest are refused — one body for a real and an invented id', async () => {
  const w = await deceptionWorld();
  await w.call('/.env', { ip: ATTACKER_IP });
  const b = blocks(w.raw)[0]!;
  const real = { ':id': '' };
  const callers: Array<[string, Who | null, number, string | undefined]> = [
    ['guest', null, 401, 'UNAUTHORIZED'],
    ['customer', 'customer', 403, 'FORBIDDEN'],
    ['assistant', 'assistant', 403, 'OWNER_ONLY'],
    ['full', 'full', 403, 'OWNER_ONLY'],
  ];
  for (const [who, as, status, code] of callers) {
    for (const [method, route] of ROUTES) {
      const answers: string[] = [];
      for (const id of [route.includes('incidents') ? b.incident_id : b.id, route.includes('incidents') ? 'sin_inventedinvented' : 'sbk_inventedinvented']) {
        real[':id'] = String(id);
        const path = route.replace(':id', String(id));
        const res = await w.call(path, { method, as, ip: OTHER_IP, body: method === 'POST' ? { incident: true } : undefined, headers: SCRIPT });
        assert.equal(res.status, status, `${who} ${method} ${path}`);
        const body = await json(res);
        if (code) assert.equal(body.code, code, `${who} ${method} ${path}`);
        answers.push(JSON.stringify(body));
      }
      if (route.includes(':id')) assert.equal(answers[0], answers[1], `${who} ${method} ${route}: the refusal differs between a real and an invented id`);
    }
  }
  assert.equal(blocks(w.raw).filter((x) => x.lifted_at).length, 0, 'nobody but the owner lifted anything');
  // The owner row before its address is verified hears the way to verify it, never the console.
  const unverified = await deceptionWorld();
  unverified.raw.exec("UPDATE users SET email_verified_at = NULL WHERE id = 'usr_owner'");
  const r = await unverified.call('/api/admin/security/summary', { as: 'owner', headers: SCRIPT });
  assert.equal(r.status, 403);
  assert.equal((await json(r)).code, 'OWNER_EMAIL_UNVERIFIED');
});

test('THE CONSOLE: summary, blocks, the log, scores and an incident — ids, codes and counts; no address, user agent, password, token or query string', async () => {
  const w = await deceptionWorld();
  const decoy = await w.call('/config.json', { ip: ATTACKER_IP, headers: { 'User-Agent': 'sqlmap/1.7 (secret-ua-marker)' } });
  const served = await decoy.text();
  const cfg = JSON.parse(served) as { api: { key: string }; admin: { password: string; session: string } };
  await w.call(`/api/products?key=${cfg.api.key}&note=secret-query-marker`, { ip: OTHER_IP, headers: { 'User-Agent': 'curl/8 (other-ua-marker)' } });
  await w.call('/backup.sql', { as: 'customer', ip: '192.0.2.77' });
  const out: string[] = [];
  const summary = await json(await w.call('/api/admin/security/summary', { as: 'owner', headers: SCRIPT }));
  out.push(JSON.stringify(summary));
  assert.equal(summary.summary.installed, true);
  assert.ok(summary.summary.active_blocks.device >= 3);
  assert.ok(summary.summary.decoy_hits_7d >= 2);
  assert.ok(summary.summary.canary_uses_7d >= 1);
  assert.ok(summary.summary.incidents_7d >= 3);
  const list = await json(await w.call('/api/admin/security/blocks', { as: 'owner', headers: SCRIPT }));
  out.push(JSON.stringify(list));
  const account = list.blocks.find((x: { actor_kind: string }) => x.actor_kind === 'account');
  assert.equal(account.actor.name, 'customer');
  assert.equal(account.actor.email, 'cust@x.co');
  const network = list.blocks.find((x: { actor_kind: string }) => x.actor_kind === 'network');
  assert.deepEqual(Object.keys(network.actor).sort(), ['asn', 'cc', 'kind'], 'a network is its country and operator, never its hash');
  const device = list.blocks.find((x: { actor_kind: string }) => x.actor_kind === 'device');
  assert.equal(device.actor.tag.length, 6);
  const events = await json(await w.call('/api/admin/security/events', { as: 'owner', headers: SCRIPT }));
  out.push(JSON.stringify(events));
  assert.ok(events.events.some((e: { code: string }) => e.code === 'CANARY_USED'));
  const scores = await json(await w.call('/api/admin/security/scores', { as: 'owner', headers: SCRIPT }));
  out.push(JSON.stringify(scores));
  // The first incident: the decoy answer regenerated, byte for byte, from its batch.
  const first = blocks(w.raw)[0]!;
  const inc = await json(await w.call(`/api/admin/security/incidents/${first.incident_id}`, { as: 'owner', headers: SCRIPT }));
  out.push(JSON.stringify(inc));
  assert.equal(inc.incident.reference, first.reference);
  assert.ok(inc.incident.batch && inc.incident.batch.decoy === 'config_json');
  assert.equal(inc.incident.batch.use_count, 1, 'the later use from another address is linked to the batch');
  assert.deepEqual(inc.incident.preview, served.split('\n').slice(0, 60), 'what he was given, regenerated');
  const text = out.join('\n');
  for (const secret of [ATTACKER_IP, OTHER_IP, '192.0.2.77', 'secret-ua-marker', 'other-ua-marker', 'secret-query-marker']) {
    assert.ok(!text.includes(secret), `the console shows ${secret}`);
  }
  // The key and passwords appear ONLY inside the regenerated fake answer, never as stored values.
  const withoutPreview = out.filter((x) => !x.includes('"preview"')).join('\n');
  assert.ok(!withoutPreview.includes(cfg.api.key) && !withoutPreview.includes(cfg.admin.password) && !withoutPreview.includes(cfg.admin.session));
  assert.match((await w.call('/api/admin/security/summary', { as: 'owner', headers: SCRIPT })).headers.get('cache-control') ?? '', /no-store/);
});

test('LIFT: one block, then the whole incident — the next request passes, the scores reset, an audit row is written', async () => {
  const w = await deceptionWorld();
  const res = await w.call('/.env', { as: 'customer', ip: ATTACKER_IP });
  const tag = setCookieValue(res, 'lv_pref')!;
  assert.equal((await w.call('/api/cart', { as: 'customer', cookies: { lv_pref: tag }, headers: SCRIPT })).status, 403);
  const account = blocks(w.raw).find((b) => b.actor_kind === 'account')!;
  // One block: the account. The tagged browser stays blocked; a fresh one of that account passes.
  const one = await w.call(`/api/admin/security/blocks/${account.id}/lift`, { as: 'owner', body: {}, headers: SCRIPT });
  assert.equal(one.status, 200, await one.clone().text());
  assert.equal((await json(one)).lifted, 1);
  assert.equal((await w.call('/api/cart', { as: 'customer', ip: OTHER_IP, headers: SCRIPT })).status, 200);
  assert.equal((await w.call('/api/cart', { as: 'customer', cookies: { lv_pref: tag }, headers: SCRIPT })).status, 403);
  assert.equal((await w.call(`/api/admin/security/blocks/${account.id}/lift`, { as: 'owner', body: {}, headers: SCRIPT })).status, 409);
  // The whole incident: the device too.
  const device = blocks(w.raw).find((b) => b.actor_kind === 'device' && !b.lifted_at)!;
  const all = await w.call(`/api/admin/security/blocks/${device.id}/lift`, { as: 'owner', body: { incident: true, note: 'my own test' }, headers: SCRIPT });
  assert.equal(all.status, 200);
  const after = await w.call('/api/cart', { as: 'customer', cookies: { lv_pref: tag }, headers: SCRIPT });
  assert.equal(after.status, 200);
  assert.equal(setCookieValue(after, 'lv_pref'), '', 'the lifted tag is deleted');
  assert.ok(blocks(w.raw).every((b) => b.lifted_at && b.lifted_by === 'usr_owner'));
  const audits = w.raw.prepare("SELECT actor_id, action, target, detail FROM audit_log WHERE action = 'security.block_lifted' ORDER BY rowid").all() as Array<{ actor_id: string; detail: string }>;
  assert.equal(audits.length, 2);
  assert.equal(audits[0]!.actor_id, 'usr_owner');
  assert.match(audits[1]!.detail, /my own test/);
  const s = w.raw.prepare("SELECT score FROM security_scores WHERE actor_key = 'u:usr_cust'").get() as { score: number } | undefined;
  assert.equal(s?.score ?? 0, 0);
  // An anonymous decoy hit: lifting the incident frees the network too.
  const w2 = await deceptionWorld();
  await w2.call('/.env', { ip: ATTACKER_IP });
  assert.equal((await w2.call('/api/products', { ip: ATTACKER_IP, headers: SCRIPT })).status, 403);
  const net = blocks(w2.raw).find((b) => b.actor_kind === 'network')!;
  assert.equal((await w2.call(`/api/admin/security/blocks/${net.id}/lift`, { as: 'owner', body: { incident: true }, headers: SCRIPT })).status, 200);
  assert.equal((await w2.call('/api/products', { ip: ATTACKER_IP, headers: SCRIPT })).status, 200);
  assert.equal((await w2.call('/api/admin/security/blocks/sbk_nosuchblock00/lift', { as: 'owner', body: {}, headers: SCRIPT })).status, 404);
});

test('the owner\'s bell links «الأمان», carries no figure, and is bounded', async () => {
  const w = await deceptionWorld();
  for (let i = 0; i < 12; i++) await w.call('/.env', { ip: `198.51.100.${100 + i}` });
  const bells = w.raw.prepare("SELECT title_ar, title_en, body_ar, link, meta, event_key FROM user_notifications WHERE user_id = 'usr_owner' AND kind = 'security_alert'").all() as Array<{ link: string; meta: string; event_key: string; body_ar: string }>;
  assert.equal(bells.length, 10, 'DECEPTION_BELL_CAP a day');
  for (const b of bells) {
    assert.equal(b.link, '/admin?tab=security');
    assert.match(b.event_key, /^security_deception:\d{4}-\d\d-\d\d:sin_/);
    assert.ok(JSON.parse(b.meta).title_ckb);
    assert.doesNotMatch(b.body_ar, /\d{3,}/, 'no figure in the bell');
  }
  assert.equal(blocks(w.raw).filter((b) => b.actor_kind === 'device').length, 12, 'every incident is still recorded');
  // The deep link opens the tab.
  assert.match(sourceOf('src/pages/Admin.tsx'), /DEEP_LINK_TABS[^;]*'security'/);
});

test('WORDS: every string in Arabic, English and real Sorani — never a copy, never an Arabic-only letter', () => {
  const tables: Array<[string, Record<string, { ar: string; en: string; ckb: string }>]> = [
    ['console', SECURITY_STRINGS as unknown as Record<string, { ar: string; en: string; ckb: string }>],
    ['event codes', EVENT_CODE_TEXT],
    ['block (server)', BLOCK_STRINGS as unknown as Record<string, { ar: string; en: string; ckb: string }>],
    ['block (app)', ACCESS_BLOCKED_TEXT as unknown as Record<string, { ar: string; en: string; ckb: string }>],
    ['bell', Object.fromEntries(Object.entries(DECEPTION_BELL).flatMap(([k, v]) => [[`${k}.title`, v.title], [`${k}.body`, v.body]]))],
    ['refusal', { ACCESS_BLOCKED: REFUSAL_STRINGS.ACCESS_BLOCKED! }],
  ];
  for (const [name, table] of tables) {
    for (const [key, t] of Object.entries(table)) {
      for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(typeof t[lang] === 'string' && t[lang].trim().length > 0, `${name}.${key}.${lang}`);
      assert.notEqual(t.ckb, t.ar, `${name}.${key}: the Sorani is the Arabic`);
      assert.notEqual(t.ckb, t.en, `${name}.${key}: the Sorani is the English`);
      assert.doesNotMatch(t.ckb, /[ةىيك]/, `${name}.${key}: an Arabic-only letter in the Sorani`);
      if (t.ckb.length > 8) assert.match(t.ckb, /[ڕڵۆێەپچژگڤکی]/, `${name}.${key}: no Sorani letter`);
    }
  }
  // The server's block answer and the app's notice say the same three sentences.
  assert.deepEqual(BLOCK_STRINGS.title, ACCESS_BLOCKED_TEXT.title);
  assert.deepEqual(BLOCK_STRINGS.mistake, ACCESS_BLOCKED_TEXT.mistake);
});

test('THE APP: the tab is the verified owner\'s; the notice is its own chunk, raised by any ACCESS_BLOCKED answer', () => {
  const admin = sourceOf('src/pages/Admin.tsx');
  assert.match(admin, /const canSeeSecurity = user\?\.is_owner === true && user\?\.owner_email_unverified !== true;/);
  assert.match(admin, /activeTab === 'security' && canSeeSecurity && <AdminSecurity \/>/);
  assert.match(admin, /React\.lazy\(\(\) => import\('\.\.\/components\/adminSecurity\/AdminSecurity'\)\)/);
  const api = sourceOf('src/lib/api.ts');
  assert.match(api, /if \(data\.code === 'ACCESS_BLOCKED'\) noteAccessBlocked\(data\.details\);/);
  const gate = sourceOf('src/components/security/AccessBlockedGate.tsx');
  assert.match(gate, /React\.lazy<.*?>+\(\(\) => import\('\.\/AccessBlockedScreen'\)/);
  assert.doesNotMatch(sourceOf('src/App.tsx'), /import AccessBlockedScreen/, 'the screen stays out of the entry chunk');
});

test('a document from a blocked browser, typed in the address bar, is the block page with a sign-in link for a visitor', async () => {
  const w = await deceptionWorld();
  const tag = setCookieValue(await w.call('/.env'), 'lv_pref')!;
  const page = await (await w.call('/products', { cookies: { lv_pref: tag }, headers: TYPED })).text();
  assert.match(page, /href="\/auth"/);
  assert.match(page, /بچۆ ژوورەوە/);
});
