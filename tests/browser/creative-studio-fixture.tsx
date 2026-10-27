/**
 * Local fixture that MOUNTS the real Creative Studio page
 * (src/pages/CreativeStudio.tsx) against a stub of its HTTP contract
 * (packages/creativeDoc/src/api.ts), for scripts/e2e-creative-studio.mjs.
 *
 * EVERYTHING HERE IS MARKED TEST DATA. The one product is «TEST», its snapshot
 * has `source: 'test'` (so the studio labels the price «تجريبي»), its price is
 * a fixture number, and its picture and the logo are synthetic PNGs the e2e
 * script generates and serves for `/files/…` — none of it is a Levonis
 * product, price or picture.
 *
 * The stub keeps its documents in sessionStorage so a page RELOAD reads back
 * exactly what the studio saved (the save → reopen check). Any route the
 * contract does not have answers 404 loudly instead of a quiet success.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import { AuthContext } from '../../src/AuthContext';
import CreativeStudio from '../../src/pages/CreativeStudio';
import { defaultBrandKit } from '../../packages/creativeDoc/src/brand';
import type { DocumentDto, ProviderStatusDto } from '../../packages/creativeDoc/src/api';
import type { ProductSnapshot } from '../../packages/creativeDoc/src/snapshot';
import '../../src/index.css';

const BASE = '/api/admin/creative-studio';
const NOW = '2026-10-27T09:00:00.000Z';

const name = { ar: 'طابعة Bambu Lab A1 Combo مع 4 بكرات (AMS lite)', en: 'TEST Bambu Lab A1 Combo with 4 spools (AMS lite)', ckb: 'چاپکەری Bambu Lab A1 Combo لەگەڵ 4 بکەرە (AMS lite) — تاقیکاری' };
const picture = { url: '/files/products/test/e2e-a1-combo.png', width: 1200, height: 800, alt: 'TEST', primary: true, variant_key: null, same_origin: true };
const remote = { url: 'https://cdn.example.test/remote-copy.jpg', width: 1200, height: 800, alt: 'remote', primary: false, variant_key: null, same_origin: false };
const price = { status: 'priced' as const, amount_iqd: 1250000, regular_iqd: null, from: false, offer: null, member_price_iqd: null };

const snapshot: ProductSnapshot = {
  id: 'snap_e2e_0001', hash: 'f'.repeat(64), source: 'test', fetched_at: NOW,
  data: {
    product_id: 'p_test_a1', slug: 'test-a1-combo', path: '/product/test-a1-combo', variant_key: null, variant_label: null, name,
    brand: { ar: 'Bambu Lab', en: 'Bambu Lab', ckb: 'Bambu Lab' }, category: null, sku: 'TEST-A1C',
    short_description: { ar: '', en: '', ckb: '' }, specs: [], contents: [], price, availability: 'available', sale_types: ['direct_sale'],
    images: [picture, remote], source_updated_at: NOW,
  },
};

const provider: ProviderStatusDto = {
  migrated: true, provider: 'anthropic', key: { source: 'none', hint: null, set_at: null }, encryption_ready: true, model: null, effort: null, last_test: null,
  capabilities: { structured_outputs: null, vision: null, effort: null },
  budget: { daily_requests: 50, daily_tokens: 200000, daily_usd: null, monthly_usd: null, max_parallel: 2, auto_fix_rounds: 2 },
  rates: null, vision_review: false,
  today: { requests: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: null }, month: { requests: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: null },
  can_manage: true, ready: false, not_ready_code: 'KEY_NOT_CONFIGURED',
};

interface Db { seq: number; docs: Record<string, DocumentDto>; versions: Record<string, Array<{ version: number; origin: string; job_id: string | null; content: unknown; created_at: string }>>; exports: number; puts: number; applied: Array<{ job: string; version: number }>; cancelled: string[] }
const KEY = 'cs-e2e-db';
const load = (): Db => {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Db;
  } catch { /* fresh */ }
  return { seq: 0, docs: {}, versions: {}, exports: 0, puts: 0, applied: [], cancelled: [] };
};
const save = (db: Db) => sessionStorage.setItem(KEY, JSON.stringify(db));
(window as unknown as { __csDb: () => Db }).__csDb = load;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (body: Record<string, unknown>) => json({ success: true, ...body });
const fail = (status: number, code: string, error: string) => json({ success: false, code, error }, status);

async function bodyOf(init?: RequestInit): Promise<Record<string, unknown>> {
  if (!init?.body) return {};
  if (typeof init.body === 'string') return JSON.parse(init.body) as Record<string, unknown>;
  if (init.body instanceof FormData) return Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `blob:${(v as Blob).size}:${(v as Blob).type}`]));
  return {};
}

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.origin);
  if (!url.pathname.startsWith(BASE)) {
    if (url.pathname.startsWith('/api/')) return fail(404, 'NOT_FOUND', 'not stubbed');
    return realFetch(input as RequestInfo, init);
  }
  const path = url.pathname.slice(BASE.length);
  const method = (init?.method ?? 'GET').toUpperCase();
  const db = load();
  const body = await bodyOf(init);
  let m: RegExpMatchArray | null;
  // `cs-e2e-ai` switches the stub provider to READY so the e2e can walk the AI edit path. The
  // model name below is a fixture string, not a model id the studio knows: the studio never names one.
  const aiReady = sessionStorage.getItem('cs-e2e-ai') === '1';
  if (method === 'GET' && path === '/provider') return ok(aiReady ? { ...provider, ready: true, not_ready_code: null, model: 'model-e2e-fixture', key: { source: 'worker_secret', hint: null, set_at: null } } : { ...provider });
  if (method === 'POST' && path === '/ai/edit') {
    if (!aiReady) return fail(503, 'KEY_NOT_CONFIGURED', 'no key');
    // The STUB's answer (marked): one bounded operation on the selected headline, for the version asked about.
    return ok({
      job_id: 'job_e2e_1',
      patch: {
        schema_version: 1, document_id: body.document_id, base_document_version: body.base_version, intent: 'shorten',
        target_layer_ids: ['headline'], operations: [{ op: 'set_text', layer_id: 'headline', value: 'طباعة دقيقة بألوان أكثر' }],
        reason: 'اختصرت العنوان كما طلبت (رد اختبار)', warnings: [], clarification: '',
      },
      usage: { input_tokens: 1200, output_tokens: 90, est_cost_usd: null, model: 'model-e2e-fixture' },
    });
  }
  if (method === 'POST' && (m = path.match(/^\/jobs\/([^/]+)\/applied$/))) {
    // The Worker requires both (worker/routes/adminCreativeStudio.ts; tests/creativeStudioContract.test.ts).
    if (typeof body.document_id !== 'string' || !body.document_id) return fail(400, 'INVALID_INPUT', 'document_id is required');
    db.applied.push({ job: m[1], version: Number(body.version) });
    save(db);
    return ok({ job: { id: m[1], status: 'succeeded' } });
  }
  if (method === 'POST' && (m = path.match(/^\/jobs\/([^/]+)\/cancel$/))) {
    db.cancelled.push(m[1]);
    save(db);
    return ok({ job: { id: m[1], status: 'cancelled' } });
  }
  if (method === 'GET' && path === '/usage') return ok({ migrated: true, records: [], days: [], today: provider.today, month: provider.month });
  if (method === 'GET' && path === '/brand') return ok({ migrated: true, version: null, status: 'default', kit: defaultBrandKit(), site_logo: { width: 600, height: 600 } });
  if (method === 'GET' && path === '/brand/versions') return ok({ versions: [] });
  if (method === 'GET' && path === '/claims') return ok({ claims: [] });
  if (method === 'GET' && path === '/assets') return ok({ assets: [] });
  if (method === 'GET' && path === '/opportunities') return ok({ opportunities: [] });
  if (method === 'GET' && path === '/products') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const hit = 'test bambu a1 طابعة'.includes(q) || name.en.toLowerCase().includes(q) || name.ar.includes(q);
    return ok({ products: hit ? [{ id: 'p_test_a1', slug: 'test-a1-combo', name, brand: snapshot.data.brand, image: { url: picture.url, same_origin: true, width: 1200, height: 800 }, price_status: 'priced', display_price_iqd: 1250000, availability: 'available', has_variants: false, category_id: null }] : [] });
  }
  if (method === 'GET' && (m = path.match(/^\/products\/([^/]+)$/))) {
    if (m[1] !== 'p_test_a1') return fail(404, 'NOT_FOUND', 'no product');
    return ok({ product: { id: 'p_test_a1', slug: 'test-a1-combo', path: '/product/test-a1-combo', name, brand: snapshot.data.brand, category: null, images: [picture, remote], price, availability: 'available', variants: [], specs: [], contents: [] } });
  }
  if (method === 'POST' && path === '/snapshots') return ok({ snapshot });
  if (method === 'GET' && (m = path.match(/^\/snapshots\/([^/]+)$/))) return m[1] === snapshot.id ? ok({ snapshot }) : fail(404, 'NOT_FOUND', 'no snapshot');
  if (method === 'POST' && (m = path.match(/^\/snapshots\/([^/]+)\/verify$/))) return ok({ snapshot_id: m[1], fresh: snapshot, changes: [] });
  if (method === 'GET' && path === '/documents') {
    const docs = Object.values(db.docs).map(({ content: _c, issues: _i, brand_version: _b, updated_by_name: _u, ...summary }) => summary);
    return ok({ migrated: true, documents: docs });
  }
  if (method === 'POST' && path === '/documents') {
    db.seq += 1;
    const id = `doc_e2e_${db.seq}`;
    const content = body.content as DocumentDto['content'];
    const doc: DocumentDto = {
      id, title: String(body.title ?? ''), status: 'draft', kind: 'post', format: content.format, product_id: 'p_test_a1', product_name: name, template_id: content.template?.id ?? null,
      version: 1, approved_version: null, needs_review: [], campaign_id: null, parent_id: (body.parent_id as string | null) ?? null, updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      thumb_export_id: null, content, brand_version: null, updated_by_name: 'TEST OWNER', issues: [],
    };
    db.docs[id] = doc;
    db.versions[id] = [{ version: 1, origin: String(body.origin ?? 'template'), job_id: (body.job_id as string | null) ?? null, content, created_at: doc.created_at }];
    save(db);
    return ok({ document: doc });
  }
  if ((m = path.match(/^\/documents\/([^/]+)$/))) {
    const doc = db.docs[m[1]];
    if (!doc) return fail(404, 'NOT_FOUND', 'no document');
    if (method === 'GET') return ok({ document: doc });
    if (method === 'PUT') {
      if (body.base_version !== doc.version) return json({ success: false, code: 'VERSION_CONFLICT', error: 'version conflict', details: { current_version: doc.version } }, 409);
      doc.content = body.content as DocumentDto['content'];
      doc.version += 1;
      doc.updated_at = new Date().toISOString();
      db.versions[doc.id].push({ version: doc.version, origin: String(body.origin ?? 'manual'), job_id: (body.job_id as string | null) ?? null, content: doc.content, created_at: doc.updated_at });
      db.puts += 1;
      save(db);
      return ok({ document: doc });
    }
    if (method === 'PATCH') {
      // A rename only: the Worker changes no version for it.
      if (typeof body.title !== 'string' || !body.title) return fail(400, 'INVALID_INPUT', 'title is required');
      doc.title = body.title;
      save(db);
      return ok({ document: doc });
    }
  }
  if (method === 'GET' && (m = path.match(/^\/documents\/([^/]+)\/versions$/))) {
    return ok({ versions: (db.versions[m[1]] ?? []).map((v) => ({ version: v.version, origin: v.origin, change_summary: '', created_at: v.created_at, created_by_name: 'TEST OWNER', job_id: null })).reverse() });
  }
  if (method === 'POST' && (m = path.match(/^\/documents\/([^/]+)\/exports$/))) {
    // The Worker reads the facts from ONE JSON field, `meta`, beside the file.
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(String(body.meta)) as Record<string, unknown>;
    } catch {
      return fail(400, 'INVALID_INPUT', 'meta must be JSON');
    }
    db.exports += 1;
    save(db);
    return ok({ export: { id: `exp_e2e_${db.exports}`, document_id: m[1], version: Number(meta.version), kind: meta.kind, width: Number(meta.width), height: Number(meta.height), bytes: 1, final: meta.final === true, source_check: 'fresh', created_at: NOW, url: '' } });
  }
  return fail(404, 'NOT_FOUND', `not stubbed: ${method} ${path}`);
}) as typeof window.fetch;

const OWNER = { id: 'usr_test_owner', email: 'owner@test.invalid', name: 'TEST OWNER', role: 'admin', isAdmin: true, admin_scope: 'full', is_owner: true, owner_email_unverified: false };
const auth = {
  isAuthenticated: true, isLoaded: true, user: OWNER,
  login: async () => {}, loginWithGoogle: async () => 'ok' as const, register: async () => {}, refreshUser: async () => {}, adoptSession: async () => 'ok' as const, logout: async () => {},
};

createRoot(document.getElementById('root')!).render(
  <AuthContext.Provider value={auth as never}>
    <LanguageProvider>
      <MemoryRouter initialEntries={['/admin/creative-studio']}>
        <div style={{ height: '100dvh', display: 'flex' }}>
          <CreativeStudio />
        </div>
      </MemoryRouter>
    </LanguageProvider>
  </AuthContext.Provider>,
);
