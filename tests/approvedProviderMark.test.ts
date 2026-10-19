/**
 * «مزوّد معتمد» — THE APPROVED-PROVIDER MARK (owner decision C4; P1-02).
 *
 * What this pins:
 *   - the mark is derived from the approval stamp alone, through the one public
 *     predicate (`approvedProvider` IS `merchantIsPublic`, `approvedProviderSql`
 *     IS `merchantPublicSql`): approved AND not suspended, closed on a database
 *     without 0204's column;
 *   - it reaches the four surfaces the plan names — the store header (the
 *     storefront read and the in-site store page), the directory card, the
 *     community product card and the maker page — `true` only for an approved,
 *     non-suspended merchant;
 *   - it never says anything about an unapproved or suspended merchant: those
 *     are on no public surface, and the maker page of one reads exactly like a
 *     plain member's (no `false` that would single them out);
 *   - `verified` stays its own mark: an admin's verified flag neither gives nor
 *     takes the approved mark;
 *   - the UI draws it only when the server says `approved_provider: true`, in
 *     ar, en and real Sorani, said one way everywhere (the community cards'
 *     table and the store header's facts row hold the same words). The store
 *     header draws it in the hero's facts row, whose words are its own lazy
 *     chunk, so the storefront's fixed weight never carries them
 *     (tests/bundleBudget.test.ts).
 *
 * Run: node --import tsx --test tests/approvedProviderMark.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, hasColumn, asD1, stubApp, get, json, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { communityRoutes } from '../worker/routes/community';
import { communityPostRoutes } from '../worker/routes/communityPosts';
import { communitySocialRoutes } from '../worker/routes/communitySocial';
import { communitySearchRoutes } from '../worker/routes/communitySearch';
import { storefrontRoutes } from '../worker/routes/storefront';
import { approvedProvider, approvedProviderSql } from '../worker/lib/merchantOps';
import { merchantPublicSql } from '../worker/lib/merchantApproval';

let storedLang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (k === 'levo_lang' ? storedLang : null),
  setItem: () => undefined,
  removeItem: () => undefined,
};
const { LanguageProvider } = await import('../src/LanguageContext');
const { AuthProvider } = await import('../src/AuthContext');
const { WalletProvider } = await import('../src/WalletContext');
const { CurrencyProvider } = await import('../src/CurrencyContext');
const { default: HeroBlock } = await import('../src/components/storefront/blocks/Hero');
const { WorkshopFacts, WORKSHOP_WORDS } = await import('../src/components/storefront/blocks/workshopFacts');
const { ApprovedMark } = await import('../src/components/community/hub/parts');
const { HUB_STRINGS } = await import('../src/components/community/hub/strings');
const { default: StoreCard } = await import('../src/components/community/hub/StoreCard');
const { default: ProductTile } = await import('../src/components/community/hub/ProductTile');
const { StorefrontRuntimeProvider } = await import('../src/components/storefront/runtime');
const { previewRuntime } = await import('../src/components/storefront/preview');
const { normalizeLayout } = await import('../packages/storeLayout/src/normalize');
const { emptyBlockData } = await import('../packages/storeLayout/src/data');

const STAMP = '2026-10-18T09:00:00.000Z';
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;

// ================================================================== the rule

test('the mark is the public predicate on the approval stamp — approved AND not suspended, closed without the column', () => {
  assert.equal(approvedProviderSql('cm'), merchantPublicSql('cm'), 'one SQL definition');
  assert.equal(approvedProviderSql('m', false), '(0)', 'a database without 0204: no mark (C11)');
  assert.equal(approvedProvider({ status: 'active', approved_at: STAMP }), true);
  assert.equal(approvedProvider({ status: 'restricted', approved_at: STAMP }), true, 'only a suspension takes it away');
  assert.equal(approvedProvider({ status: 'suspended', approved_at: STAMP }), false, 'a sanctioned merchant never carries it');
  assert.equal(approvedProvider({ status: 'active', approved_at: null }), false, 'no stamp, no mark');
  assert.equal(approvedProvider({ status: 'active', approved_at: '  ' }), false);
  assert.equal(approvedProvider({ status: 'active' }), false, 'a row read without the column');
  assert.equal(approvedProvider(null), false);
});

// =================================================================== the API

/**
 * Four merchants: `ali` approved; `noor` approved and then suspended; `omar`
 * never approved (with a public maker page); `rana` approved AND verified by an
 * admin. `sara` is a plain member with a public maker page.
 */
function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,username,email,password_hash,role,creator_public) VALUES
      ('ali','Ali','ali','ali@x.co','h','merchant',0),
      ('noor','Noor','noor','noor@x.co','h','merchant',1),
      ('omar','Omar','omar','omar@x.co','h','merchant',1),
      ('rana','Rana','rana','rana@x.co','h','merchant',0),
      ('sara','Sara','sara','sara@x.co','h','customer',1);
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
    INSERT INTO community_merchants (id,user_id,name,status,verified,created_at) VALUES
      ('m_ali','ali','Ali 3D','active',0,'2026-09-01T00:00:00.000Z'),
      ('m_noor','noor','Noor Prints','suspended',0,'2026-09-02T00:00:00.000Z'),
      ('m_omar','omar','Omar Works','active',1,'2026-09-03T00:00:00.000Z'),
      ('m_rana','rana','Rana Lab','active',1,'2026-09-04T00:00:00.000Z');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{}'),
      ('s_noor','m_noor','noor','noorprints','Noor Prints','active','{}'),
      ('s_omar','m_omar','omar','omarworks','Omar Works','active','{}'),
      ('s_rana','m_rana','rana','ranalab','Rana Lab','active','{}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,category,created_at) VALUES
      ('p_ali','m_ali','s_ali','clip','Clip','active','active',5000,3,1,'toys','2026-09-10T00:00:00.000Z'),
      ('p_noor','m_noor','s_noor','vase','Vase','active','active',5000,3,1,'toys','2026-09-11T00:00:00.000Z'),
      ('p_omar','m_omar','s_omar','gear','Gear','active','active',5000,3,1,'toys','2026-09-12T00:00:00.000Z'),
      ('p_rana','m_rana','s_rana','mini','Mini','active','active',5000,3,1,'toys','2026-09-13T00:00:00.000Z');
  `);
  assert.ok(hasColumn(raw, 'community_merchants', 'approved_at'), 'the fresh database carries 0204');
  raw.prepare("UPDATE community_merchants SET approved_at = ? WHERE id IN ('m_ali','m_noor','m_rana')").run(STAMP);
  return raw;
}

const visitor = (raw: DatabaseSync, user: StubUser | null = null) =>
  stubApp(asD1(raw), user, (a) => {
    a.route('/api/storefront', storefrontRoutes);
    a.route('/api/community', communityRoutes);
    a.route('/api/community', communityPostRoutes);
    a.route('/api/community', communitySocialRoutes);
    a.route('/api/community', communitySearchRoutes);
  });

type Row = Record<string, unknown>;

test('the directory card: only approved, non-suspended merchants are listed, and each carries the mark', async () => {
  const raw = seed();
  const body = await json(await get(visitor(raw), '/api/community/merchants'));
  const cards = body.merchants as Row[];
  assert.deepEqual(cards.map((m) => m.id).sort(), ['m_ali', 'm_rana']);
  for (const m of cards) assert.equal(m.approved_provider, true, `${m.id} carries «مزوّد معتمد»`);
  assert.equal(JSON.stringify(body).includes('"approved_provider":false'), false, 'never a false about anybody');
  // `verified` stays its own answer.
  assert.equal(cards.find((m) => m.id === 'm_ali')!.verified, false);
  assert.equal(cards.find((m) => m.id === 'm_rana')!.verified, true);

  const searched = await json(await get(visitor(raw), '/api/community/search?q=Lab&types=stores'));
  assert.ok(JSON.stringify(searched).includes('"approved_provider":true'), 'the search card is the directory card');
});

test('the store header: the storefront read and the in-site page carry it for an approved merchant; the others are unavailable', async () => {
  const raw = seed();
  const shop = await json(await get(visitor(raw), '/api/storefront/ali3d'));
  const merchant = (shop.store as Row).merchant as Row;
  assert.equal(merchant.approved_provider, true);
  assert.equal(merchant.verified, false, 'approval does not make a shop «verified»');

  const page = await json(await get(visitor(raw), '/api/community/store/m_rana'));
  assert.equal((page.merchant as Row).approved_provider, true);
  assert.equal((page.merchant as Row).verified, true);

  for (const [slug, id] of [['noorprints', 'm_noor'], ['omarworks', 'm_omar']]) {
    const sf = await get(visitor(raw), `/api/storefront/${slug}`);
    assert.equal(sf.status, 404, `${slug}: not public`);
    assert.equal((await json(sf)).code, 'STORE_UNAVAILABLE');
    const inSite = await get(visitor(raw), `/api/community/store/${id}`);
    assert.equal(inSite.status, 404);
    assert.equal(JSON.stringify(await json(inSite)).includes('approved_provider'), false, 'nothing about them at all');
  }
});

test('the product card: the feed, search and recommendations carry the store\'s mark, and only approved shops are there', async () => {
  const raw = seed();
  const feed = await json(await get(visitor(raw), '/api/community/products'));
  const products = feed.products as Row[];
  assert.deepEqual(products.map((p) => p.id).sort(), ['p_ali', 'p_rana']);
  for (const p of products) assert.equal((p.store as Row).approved_provider, true, `${p.id}'s store`);

  const searched = await json(await get(visitor(raw), '/api/community/search?q=Clip&types=products'));
  assert.ok(JSON.stringify(searched).includes('"approved_provider":true'));
  assert.equal(JSON.stringify(searched).includes('"approved_provider":false'), false);

  const recommended = await json(await get(visitor(raw), '/api/community/recommend?for=product:p_ali'));
  const text = JSON.stringify(recommended);
  assert.ok(text.includes('"p_rana"'), 'another approved shop\'s product of the same category');
  assert.equal(text.includes('"p_omar"') || text.includes('"p_noor"'), false, 'never an unapproved or suspended shop\'s');
  assert.ok(text.includes('"approved_provider":true'));
  assert.equal(text.includes('"approved_provider":false'), false);
});

test('the maker page and card: the mark for an approved merchant; an unapproved or suspended one reads exactly like a member', async () => {
  const raw = seed();
  const ali = await json(await get(visitor(raw), '/api/community/creators/ali'));
  assert.equal(((ali.creator as Row).badges as Row).approved_provider, true);
  assert.equal(((ali.creator as Row).badges as Row).verified_merchant, false, 'separate from verified');

  const member = ((await json(await get(visitor(raw), '/api/community/creators/sara'))).creator as Row).badges;
  for (const who of ['omar', 'noor']) {
    const page = (await json(await get(visitor(raw), `/api/community/creators/${who}`))).creator as Row;
    assert.deepEqual(page.badges, member, `${who}'s page names no merchant state — the badges of any member`);
    assert.equal(page.store ?? null, null);
  }

  const list = await json(await get(visitor(raw), '/api/community/creators'));
  const byId = new Map((list.creators as Row[]).map((c) => [c.id, c]));
  assert.equal((byId.get('ali')!.badges as Row).approved_provider, true, 'the maker card');
  for (const who of ['omar', 'noor', 'sara']) {
    assert.ok(byId.has(who), `${who} has a public page, so a card`);
    assert.deepEqual(byId.get(who)!.badges, byId.get('sara')!.badges, `${who}: the badges of any member`);
  }
});

// ==================================================================== the UI

const render = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') => {
  storedLang = lang;
  return renderToStaticMarkup(
    createElement(AuthProvider, {
      children: createElement(LanguageProvider, {
        children: createElement(WalletProvider, {
          children: createElement(CurrencyProvider, { children: createElement(MemoryRouter, null, node) }),
        }),
      }),
    })
  );
};
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const marks = (h: string) => (h.match(/data-approved-provider/g) ?? []).length;
const WORDS = { ar: 'مزوّد معتمد', en: 'Approved provider', ckb: 'دابینکەری پەسەندکراو' } as const;

test('the words: «مزوّد معتمد» in Arabic, English and real Sorani — one way on every surface', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.equal(HUB_STRINGS[lang].approvedProvider, WORDS[lang], `${lang}: the community cards`);
    assert.equal(WORKSHOP_WORDS[lang].approved, WORDS[lang], `${lang}: the store header's facts row says it the same way`);
  }
  assert.notEqual(WORDS.ckb, WORDS.ar, 'ckb is not the Arabic (DECISIONS row 183)');
  assert.match(WORDS.ckb, KURDISH);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const mark = render(createElement(ApprovedMark), lang);
    assert.equal(marks(mark), 1);
    assert.match(mark, new RegExp(`aria-label="${WORDS[lang]}"`), `${lang}: the mark is named`);
    assert.match(mark, /role="img"/);
  }
});

const STORE = {
  id: 'st_1', slug: 'ali3d', url: 'https://ali3d.levonis-iq.com', name: 'Ali 3D', tagline: '', description: '',
  logoUrl: null, bannerUrl: null, accent: 'default', categories: [], governorate: 'baghdad', service_areas: [],
  contact_phone: null, business_hours: [], policies: {}, social_links: {}, profile_links: [], profile_facts: [],
  delivery_settings: {}, accepts_custom_requests: false, sells_direct_products: true, open: true, status: 'active',
  merchant: { id: 'm_ali', name: 'Ali', verified: false, badge: 'new', rating: null, rating_count: 0, completed_orders: 0 },
  created_at: '2025-01-01T00:00:00.000Z', product_count: 1, followers: 0, positive_pct: null,
};
type HeroStore = Parameters<typeof HeroBlock>[0]['store'];

test('the store header holds the facts row\'s place for an approved shop, under every hero variant — and only then', () => {
  for (const variant of ['profile', 'cover'] as const) {
    const layout = normalizeLayout({ schema_version: 1, blocks: [{ id: 'h', type: 'hero', variant, settings: {} }] }, { ownerUserId: 'owner' }).layout;
    const block = layout.blocks[0] as Parameters<typeof HeroBlock>[0]['block'];
    const hero = (merchant: Record<string, unknown>) =>
      render(createElement(StorefrontRuntimeProvider, { value: previewRuntime() },
        createElement(HeroBlock, { block, store: { ...STORE, merchant: { ...STORE.merchant, ...merchant } } as unknown as HeroStore, data: emptyBlockData() })));
    const frame = /<div class="h-7" aria-hidden="true"><\/div>/;
    assert.match(hero({ approved_provider: true }), frame, `${variant}: the row (and the mark in it) is on its way`);
    assert.doesNotMatch(hero({}), frame, `${variant}: no mark, no facts — no row`);
    assert.doesNotMatch(hero({ approved_provider: false }), frame);
    assert.doesNotMatch(hero({ verified: true }), frame, `${variant}: verified alone is not the approved mark`);
  }
});

test('the facts row: the mark leads it only when approved, in its own chip, never the «verified» one', () => {
  const workshop = { technologies: ['fdm' as const], build: null, turnaround: 3, custom: true };
  const shop = (approved_provider?: boolean) => ({ merchant: { ...STORE.merchant, approved_provider } }) as never;
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const row = render(createElement(WorkshopFacts, { workshop, store: shop(true) }), lang);
    assert.equal(marks(row), 1, `${lang}: one mark`);
    assert.ok(text(row).includes(WORDS[lang]));
    assert.ok(row.indexOf('data-approved-provider') < row.indexOf('data-store-workshop-fact="custom"'), 'it leads the row');
  }
  assert.equal(marks(render(createElement(WorkshopFacts, { workshop }))), 0, 'no store handed over: the facts alone');
  assert.equal(marks(render(createElement(WorkshopFacts, { workshop, store: shop(false) }))), 0, 'not approved');
  assert.equal(marks(render(createElement(WorkshopFacts, { workshop, store: shop() }))), 0, 'an older reply without the field');
  const alone = render(createElement(WorkshopFacts, { workshop: null, store: shop(true) }));
  assert.equal(marks(alone), 1, 'a shop with no facts shows the mark alone');
  assert.equal((alone.match(/data-store-workshop-fact/g) ?? []).length, 0);
});

test('the directory card and the product card draw the mark only for `approved_provider: true`', () => {
  const card = (extra: Record<string, unknown>) =>
    render(createElement(StoreCard, {
      store: { id: 'm_ali', user_id: 'ali', name: 'Ali 3D', bio: '', avatarUrl: null, verified: false, created_at: STAMP, store_name: 'Ali 3D', ...extra } as never,
      canFollow: false, busy: false, onToggleFollow: () => undefined,
    } as never));
  assert.equal(marks(card({ approved_provider: true })), 1);
  assert.equal(marks(card({ approved_provider: false })), 0);
  assert.equal(marks(card({})), 0, 'an older reply without the field');
  assert.equal(marks(card({ verified: true })), 0, 'verified alone is not the approved mark');

  const tile = (store: Record<string, unknown> | null) =>
    render(createElement(ProductTile, {
      product: { id: 'p1', slug: 'clip', merchant_id: 'm_ali', name: 'Clip', name_ar: 'مشبك', description: '', images: [], price_iqd: 5000, original_price_iqd: null, created_at: STAMP, in_stock: true, url: '/community/store/ali3d/p/clip', store } as never,
    }));
  const base = { id: 's_ali', slug: 'ali3d', name: 'Ali 3D', logoUrl: null, url: '/community/store/s_ali' };
  assert.equal(marks(tile({ ...base, approved_provider: true })), 1);
  assert.match(tile({ ...base, approved_provider: true }), /aria-label="مزوّد معتمد"/);
  assert.equal(marks(tile({ ...base, approved_provider: false })), 0);
  assert.equal(marks(tile(base)), 0);
  assert.equal(marks(tile(null)), 0, 'a pre-store listing has no store line');
});

test('the maker card and page gate the mark on the server\'s `approved_provider`, beside — never instead of — verified', () => {
  const code = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\s*\}/g, '');
  const card = code('src/components/community/hub/CreatorCard.tsx');
  assert.match(card, /c\.badges\.approved_provider === true && <ApprovedMark \/>/);
  assert.match(card, /c\.badges\.verified_merchant && <BadgeCheck/);
  const page = code('src/pages/community/Creator.tsx');
  assert.match(page, /creator\.badges\.approved_provider === true && \(\s*<Badge icon=\{<ShieldCheck[^>]*\/>\} mark="approved-provider">\{hub\.approvedProvider\}<\/Badge>/);
  assert.match(page, /creator\.badges\.verified_merchant && <Badge icon=\{<BadgeCheck/);
  // The store header names no words of its own: they ride in the facts row's lazy chunk.
  const hero = code('src/components/storefront/blocks/Hero.tsx');
  assert.match(hero, /if \(!workshop && !store\.merchant\.approved_provider\) return null;/);
  assert.match(hero, /<WorkshopFacts workshop=\{workshop\} store=\{store\} \/>/);
  assert.equal(hero.includes(WORDS.ar) || hero.includes(WORDS.ckb), false);
});
