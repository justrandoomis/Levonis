/**
 * «حاسبة الأسعار: خيار الرابط … وأهمّها: تغيير الطابعة لا يغيّر السعر».
 *
 * Two owner symptoms, run against the real migrations and the real router:
 *
 *   THE LINK DOOR. POST /api/print-quote/link is open to a guest, reads the
 *   URL alone when no provider API is configured (the default: every provider
 *   ships with `api_url: ''`), and says so instead of inventing a weight. When
 *   a provider IS configured and answers with a weight, the price comes from
 *   the SAME engine as the grams door — to the dinar.
 *
 *   THE PRINTER. The public catalogue now says which machines the engine cannot
 *   tell apart (`price_group`), so the screen can be honest about a printer
 *   change that cannot move a price; and the admin editor writes a model's
 *   economics, after which the X1 Carbon and the H2D — identical on the seed —
 *   quote the same file differently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, patch, post, row, stubApp, type App } from './fixtures/app';
import { adminPrintQuoteRoutes, printQuoteRoutes } from '../worker/routes/printQuote';
import type { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';

const mount = (a: Hono<AppContext>) => {
  a.route('/api/print-quote', printQuoteRoutes);
  a.route('/api/admin/print-quote', adminPrintQuoteRoutes);
};
type Raw = ReturnType<typeof freshDb>;

function stlBytes(): Uint8Array {
  const S = 20;
  const v: Array<[number, number, number]> = [
    [0, 0, 0], [S, 0, 0], [S, S, 0], [0, S, 0],
    [0, 0, S], [S, 0, S], [S, S, S], [0, S, S],
  ];
  const tris: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    o += 12;
    for (const i of [a, b, c]) {
      dv.setFloat32(o, v[i][0], true);
      dv.setFloat32(o + 4, v[i][1], true);
      dv.setFloat32(o + 8, v[i][2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

function appWithBucket(raw: Raw, user: { id: string; role: string } | null = null): App {
  const bytes = stlBytes();
  const bucket = {
    put: async () => ({}),
    get: async () => ({ arrayBuffer: async () => bytes.buffer.slice(0) }),
    head: async () => null,
    delete: async () => undefined,
  };
  return stubApp(asD1(raw), user as never, mount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });
}

async function fileQuote(a: App, printerModelId: string, token: string): Promise<number> {
  const form = new FormData();
  form.append('file', new File([stlBytes()], 'cube.stl', { type: 'application/octet-stream' }));
  form.append('guest_token', token);
  const up = await json(await a.request('/api/print-quote/uploads', { method: 'POST', body: form }));
  const h = { 'X-Guest-Token': token };
  const measured = await json(
    await post(a, `/api/print-quote/analyses/${up.analysis_id}/measure`, { printer_model_id: printerModelId, material_id: 'pla' }, h)
  );
  assert.equal(measured.success, true, JSON.stringify(measured));
  const priced = await json(await post(a, `/api/print-quote/analyses/${up.analysis_id}/quote`, {}, h));
  assert.equal(priced.success, true, JSON.stringify(priced));
  return priced.quote.price_iqd as number;
}

/** Point the MakerWorld provider at an API, and answer it from `payload`. */
function withProvider(raw: Raw, payload: Record<string, unknown>) {
  raw
    .prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(
      'printLinkProviders',
      JSON.stringify([{ id: 'makerworld', hosts: ['makerworld.com'], api_url: 'https://api.makerworld.com/v1/design/{id}', enabled: true }])
    );
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

// ------------------------------------------------------------------ the link

test('a guest pastes a MakerWorld link: it is read, not priced, and the reason is named', async () => {
  const raw = freshDb();
  const a = appWithBucket(raw);
  const res = await post(a, '/api/print-quote/link', {
    url: 'https://makerworld.com/en/models/123456-desk-organiser?from=search&utm_source=x',
    printer_model_id: 'bbl-a1',
    material_id: 'pla',
  });
  assert.equal(res.status, 200, 'the link door is open to a guest');
  const body = await json(res);
  assert.equal(body.link.provider, 'makerworld');
  assert.equal(body.link.external_id, '123456');
  assert.equal(body.link.canonical_url, 'https://makerworld.com/en/models/123456-desk-organiser');
  // No provider API is configured on a fresh database — the shipped state —
  // so there is no weight, and none is invented.
  assert.equal(body.info.resolved, false);
  assert.equal(body.info.reason, 'NO_API_CONFIGURED');
  assert.equal(body.quote, null);
});

test('something that is not a model link — including an ordinary page on another site — is refused with BAD_URL', async () => {
  const a = appWithBucket(freshDb());
  for (const url of ['not a link at all', 'ftp://makerworld.com/models/1', 'https://127.0.0.1/models/1', 'https://example.com/some/page']) {
    const res = await post(a, '/api/print-quote/link', { url });
    assert.equal(res.status, 400, url);
    assert.equal((await json(res)).code, 'BAD_URL', url);
  }
});

test('a configured provider that gives a weight and a time is priced on the grams engine, to the dinar', async () => {
  const raw = freshDb();
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();
  const a = appWithBucket(raw);
  const stub = withProvider(raw, { data: { title: 'Desk organiser', cover: 'https://img.example/c.jpg', weight: 120, printTime: 180 } });
  try {
    const body = await json(
      await post(a, '/api/print-quote/link', {
        url: 'https://makerworld.com/en/models/123456',
        printer_model_id: 'bbl-a1',
        material_id: 'pla',
      })
    );
    assert.equal(body.success, true, JSON.stringify(body));
    assert.equal(stub.calls[0], 'https://api.makerworld.com/v1/design/123456');
    assert.equal(body.info.resolved, true);
    assert.equal(body.info.name, 'Desk organiser');
    assert.ok(body.quote.price_iqd > 0, 'a real price');
    assert.equal(body.grams_total, 120);
    assert.equal(body.print_minutes, 180);
    assert.equal(body.covers.material_only, false, 'the provider gave a time, so machine hours are in');

    // THE SAME ENGINE: the grams door, asked the same question, answers the same.
    const grams = await json(
      await post(a, '/api/print-quote/grams-quote', {
        printer_model_id: 'bbl-a1',
        rows: [{ material_id: 'pla', grams: 120 }],
        print_minutes: 180,
      })
    );
    assert.equal(body.quote.price_iqd, grams.quote.price_iqd);
    // §22: a guest never sees a cost line.
    assert.ok(!JSON.stringify(body.quote).toLowerCase().includes('margin'));
  } finally {
    stub.restore();
  }
});

test('a provider weight with no time is priced as material only, and says so', async () => {
  const raw = freshDb();
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();
  const a = appWithBucket(raw);
  const stub = withProvider(raw, { name: 'Vase', weight: 60 });
  try {
    const body = await json(
      await post(a, '/api/print-quote/link', { url: 'https://makerworld.com/models/77', printer_model_id: 'bbl-a1', material_id: 'pla' })
    );
    assert.ok(body.quote.price_iqd > 0);
    assert.equal(body.print_minutes, 0);
    assert.equal(body.covers.material_only, true);
  } finally {
    stub.restore();
  }
});

// ------------------------------------------------------------ the printer

test('the catalogue says which printers the engine cannot tell apart — and nothing about why', async () => {
  const raw = freshDb();
  const a = appWithBucket(raw);
  const body = await json(await a.request('/api/print-quote/printers'));
  const byId = new Map<string, Record<string, string>>(body.printers.map((p: Record<string, string>) => [p.id, p]));
  // On the seed the two flagships an owner compares share every priced input.
  assert.equal(byId.get('bbl-x1c')!.price_group, byId.get('bbl-h2d')!.price_group);
  // The A1 series lays plastic down at 28 mm³/s against 32: a different group.
  assert.notEqual(byId.get('bbl-a1')!.price_group, byId.get('bbl-x1c')!.price_group);
  // With no stated time only the success rate is left, and it is the platform's everywhere.
  assert.equal(new Set(body.printers.map((p: Record<string, string>) => p.untimed_price_group)).size, 1);
  // Opaque: a label, never a figure.
  assert.match(byId.get('bbl-x1c')!.price_group, /^f\d+$/);
  assert.ok(!JSON.stringify(body).includes('purchase'));
});

test('the admin enters the X1 Carbon\'s economics, and the X1C and the H2D stop quoting the same file alike', async () => {
  const raw = freshDb();
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();
  raw.prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES ('boss','boss@x.co','Boss','x','admin')`).run();
  const guest = appWithBucket(raw);
  const admin = appWithBucket(raw, { id: 'boss', role: 'admin' });

  // The premise, on the seed: the same file, the same dinar.
  const x1cBefore = await fileQuote(guest, 'bbl-x1c', 'tok-a');
  const h2dBefore = await fileQuote(guest, 'bbl-h2d', 'tok-b');
  assert.equal(x1cBefore, h2dBefore, 'premise: the seed cannot tell these two apart');

  const listed = await json(await admin.request('/api/admin/print-quote/printer-models'));
  assert.equal(listed.success, true);
  const x1cRow = listed.models.find((m: Record<string, unknown>) => m.id === 'bbl-x1c');
  assert.equal(x1cRow.purchase_iqd, null, 'nothing invented on the seed');
  assert.ok(listed.platform_machine_hour_iqd.fdm > 0);

  const res = await patch(admin, '/api/admin/print-quote/printer-models/bbl-x1c', {
    purchase_iqd: 2_600_000,
    residual_iqd: 400_000,
    useful_print_hours: 3000,
    maintenance_iqd_per_hour: 150,
    printing_watts: 200,
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual((await json(res)).changed.sort(), [
    'maintenance_iqd_per_hour',
    'printing_watts',
    'purchase_iqd',
    'residual_iqd',
    'useful_print_hours',
  ]);

  const x1cAfter = await fileQuote(guest, 'bbl-x1c', 'tok-c');
  const h2dAfter = await fileQuote(guest, 'bbl-h2d', 'tok-d');
  assert.equal(h2dAfter, h2dBefore, 'the machine nobody priced is untouched');
  assert.notEqual(x1cAfter, h2dAfter, 'two machines, one file, two prices');

  // And the catalogue now says so.
  const printers = await json(await guest.request('/api/print-quote/printers'));
  const g = (id: string) => printers.printers.find((p: Record<string, string>) => p.id === id).price_group;
  assert.notEqual(g('bbl-x1c'), g('bbl-h2d'));

  // Audited, naming who and what moved.
  const auditRow = row<{ actor_id: string; detail: string }>(
    raw,
    "SELECT actor_id, detail FROM audit_log WHERE action = 'print_quote.printer_model_update' AND target = 'bbl-x1c'"
  )!;
  assert.equal(auditRow.actor_id, 'boss');
  const detail = JSON.parse(auditRow.detail);
  assert.equal(detail.before.purchase_iqd, null);
  assert.equal(detail.after.purchase_iqd, 2_600_000);
});

test('the editor refuses what it cannot honour, and clears with an explicit null', async () => {
  const raw = freshDb();
  raw.prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES ('boss','boss@x.co','Boss','x','admin')`).run();
  const admin = appWithBucket(raw, { id: 'boss', role: 'admin' });
  const path = '/api/admin/print-quote/printer-models/bbl-x1c';

  for (const [bad, code] of [
    [{ purchase_iqd: -1 }, 'FIELD_OUT_OF_RANGE'],
    [{ purchase_iqd: 1.5 }, 'FIELD_OUT_OF_RANGE'],
    [{ useful_print_hours: 0 }, 'FIELD_OUT_OF_RANGE'],
    [{ baseline_success_rate: 1.2 }, 'FIELD_OUT_OF_RANGE'],
    [{ max_volumetric_flow_mm3_s: null }, 'FIELD_REQUIRED'],
    [{ purchase_iqd: 100_000, residual_iqd: 200_000 }, 'RESIDUAL_ABOVE_PURCHASE'],
  ] as const) {
    const res = await patch(admin, path, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await json(res)).code, code, JSON.stringify(bad));
  }
  assert.equal(row<{ p: number | null }>(raw, "SELECT purchase_iqd p FROM printer_models WHERE id='bbl-x1c'")!.p, null);

  await patch(admin, path, { purchase_iqd: 900_000, max_volumetric_flow_mm3_s: 40 });
  await patch(admin, path, { purchase_iqd: null });
  const after = row<{ p: number | null; f: number }>(raw, "SELECT purchase_iqd p, max_volumetric_flow_mm3_s f FROM printer_models WHERE id='bbl-x1c'")!;
  assert.equal(after.p, null, 'an explicit null clears it back to "not recorded"');
  assert.equal(after.f, 40, 'an absent field is left alone');

  assert.equal((await patch(admin, '/api/admin/print-quote/printer-models/nope', { purchase_iqd: 1 })).status, 404);
});

test('the editor is admin-only', async () => {
  const raw = freshDb();
  raw.prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES ('u1','u1@x.co','U','x','customer')`).run();
  const customer = appWithBucket(raw, { id: 'u1', role: 'customer' });
  assert.equal((await customer.request('/api/admin/print-quote/printer-models')).status, 403);
  assert.equal((await patch(customer, '/api/admin/print-quote/printer-models/bbl-x1c', { purchase_iqd: 1 })).status, 403);
  assert.equal((await appWithBucket(raw).request('/api/admin/print-quote/printer-models')).status, 401);
});
