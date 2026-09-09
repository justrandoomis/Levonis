/**
 * A USAGE STEP'S PHOTO, ITS VIDEO AND ITS LINK REACH THE FORM (mandate §4).
 *
 * THE RULE THE OWNER SET: *"Parser acceptance is not enough."* A test that
 * stops at «the parser read the line» proves the first hop of seven. This one
 * walks the whole chain the owner named —
 *
 *   TXT → ProductDoc → D1 → GET admin product → ProductForm state
 *       → the usage-step editor → save → reload
 *
 * — and it reads the last hop through `toEditorDoc`, the transform ProductForm
 * actually runs over the GET, not a hand-shaped stand-in for it.
 *
 * THE DEFECT IT PINS. `usage_steps.N.images` was declared `csv` and joined and
 * split on a bare comma. A comma is a LEGAL CHARACTER IN A URL PATH and vendor
 * CDNs use it constantly — a Cloudinary transform reads
 * `.../upload/w_400,h_300/a.jpg`. One working image became two broken ones, on
 * export as well as on import, and every round trip multiplied them. The field
 * is now `urls`: whitespace always separates (a bare space cannot occur inside
 * a valid URL) and a comma separates only when a new address follows it, so
 * every file already written with the old join still reads.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, asD1, stubApp, post, get, json, row, type App } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { productRoutes } from '../worker/routes/products';
import { toEditorDoc } from '../src/components/adminProducts/types';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/template', templateRoutes);
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
  a.route('/api/products', productRoutes);
};

function setup() {
  const raw = freshDb();
  const db = asD1(raw);
  return { raw, db, app: stubApp(db, OWNER, mount) };
}

const apply = async (a: App, text: string, extra: Record<string, unknown> = {}) => {
  const res = await post(a, '/api/admin/template/apply', { text, mode: 'draft', confirm: true, ...extra });
  return { status: res.status, body: await json(res) };
};

/** Exactly the GET ProductForm issues, through exactly its own transform. */
async function formDoc(a: App, id: string) {
  const p = await json(await get(a, `/api/admin/products-v2/${id}`));
  assert.equal(p.success, true, JSON.stringify(p));
  return toEditorDoc(p.product);
}

// The three media the owner named, on one step, alongside a title and a body.
const STEP_IMAGE_A = 'https://cdn.bambulab.com/guide/a1-step1.jpg';
const STEP_IMAGE_B = 'https://res.cloudinary.com/levonis/image/upload/w_400,h_300/a1-step1b.jpg';
const STEP_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const STEP_LINK = 'https://wiki.bambulab.com/en/a1/manual/unboxing';

const TXT = `template_version=2
slug=a1-usage-media
name_ar=إيه1
name_en=Bambu Lab A1
status=draft
price_iqd=725000
usage_official_url=https://wiki.bambulab.com/en/a1
usage_steps.1.id=ustep_unbox
usage_steps.1.kind=setup
usage_steps.1.title=Unbox and remove the clips
usage_steps.1.body=Lift the printer out and cut the four orange transport clips.
usage_steps.1.images=${STEP_IMAGE_A} ${STEP_IMAGE_B}
usage_steps.1.video_url=${STEP_VIDEO}
usage_steps.1.link_url=${STEP_LINK}
usage_steps.2.id=ustep_level
usage_steps.2.kind=usage
usage_steps.2.title=Run the first calibration
usage_steps.2.body=Choose full auto calibration on the touchscreen.
`;

// ==================================================== the whole chain, once

test('§4 — a step’s image, video and official link survive TXT → DB → API → ProductForm', async () => {
  const { raw, app } = setup();

  // 1. TXT → ProductDoc → D1
  const created = await apply(app, TXT);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.product_id as string;

  // 2. THE DATABASE, not the parser's echo. A test that trusts the apply
  //    response proves the parser and nothing else.
  const stored = JSON.parse(
    String(row<{ usage_guide: string }>(raw, 'SELECT usage_guide FROM products WHERE id = ?', id)!.usage_guide)
  ) as { official_url: string; steps: Array<Record<string, unknown>> };
  assert.equal(stored.official_url, 'https://wiki.bambulab.com/en/a1');
  assert.equal(stored.steps.length, 2, 'both steps were stored');
  const unbox = stored.steps.find((s) => s.id === 'ustep_unbox')!;
  assert.deepEqual(unbox.images, [STEP_IMAGE_A, STEP_IMAGE_B], 'BOTH images, and neither one split in half');
  assert.equal(unbox.video_url, STEP_VIDEO);
  assert.equal(unbox.link_url, STEP_LINK);

  // 3. GET → ProductForm state. This is the hop the owner said a parser test
  //    does not cover.
  const doc = await formDoc(app, id);
  assert.equal(doc.usage_guide.official_url, 'https://wiki.bambulab.com/en/a1');
  assert.equal(doc.usage_guide.steps.length, 2);
  const inForm = doc.usage_guide.steps.find((s) => s.id === 'ustep_unbox')!;
  assert.equal(inForm.title, 'Unbox and remove the clips');
  assert.match(inForm.body, /orange transport clips/);
  assert.deepEqual(inForm.images, [STEP_IMAGE_A, STEP_IMAGE_B], 'the editor renders an ImgSlot per image');
  assert.equal(inForm.video_url, STEP_VIDEO, 'the video field is filled');
  assert.equal(inForm.link_url, STEP_LINK, 'the official-link field is filled');
  assert.equal(inForm.kind, 'setup');

  // 4. SAVE FROM THE FORM, unchanged, and RELOAD. A round trip that loses the
  //    media is the same defect one hop later.
  const saved = await json(
    await post(app, '/api/admin/products-v2', {
      ...doc,
      status: 'draft',
      expected_updated_at: String(row(raw, 'SELECT updated_at FROM products WHERE id = ?', id)!.updated_at),
    })
  );
  assert.equal(saved.success, true, JSON.stringify(saved));

  const reloaded = await formDoc(app, id);
  const after = reloaded.usage_guide.steps.find((s) => s.id === 'ustep_unbox')!;
  assert.deepEqual(after.images, [STEP_IMAGE_A, STEP_IMAGE_B]);
  assert.equal(after.video_url, STEP_VIDEO);
  assert.equal(after.link_url, STEP_LINK);
  assert.equal(reloaded.usage_guide.steps.length, 2, 'and the second step is still there');

  // 5. AND THE CUSTOMER SEES IT. The whole point of the guide.
  raw.prepare("UPDATE products SET status='active' WHERE id = ?").run(id);
  const pub = await json(await get(app, '/api/products/a1-usage-media'));
  const shown = (pub.product.usage_guide.steps as Array<Record<string, unknown>>).find((s) => s.id === 'ustep_unbox')!;
  assert.deepEqual(shown.images, [STEP_IMAGE_A, STEP_IMAGE_B]);
  assert.equal(shown.video_url, STEP_VIDEO);
});

// ============================================== the comma that broke a URL

test('a comma INSIDE an image URL no longer splits it in two', async () => {
  const { raw, app } = setup();
  const created = await apply(
    app,
    `template_version=2
slug=comma-url
name_ar=منتج
name_en=Comma URL
status=draft
price_iqd=1000
usage_steps.1.kind=setup
usage_steps.1.title=One picture
usage_steps.1.images=${STEP_IMAGE_B}
`
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const guide = JSON.parse(
    String(
      row<{ usage_guide: string }>(
        raw,
        'SELECT usage_guide FROM products WHERE id = ?',
        created.body.product_id as string
      )!.usage_guide
    )
  ) as { steps: Array<{ images: string[] }> };
  assert.deepEqual(guide.steps[0].images, [STEP_IMAGE_B], 'w_400,h_300 is one transform, not two images');
});

test('a file written with the OLD bare-comma join still reads', async () => {
  // Every template exported before this change joined with ','. Those files
  // must keep working, or the fix trades one data loss for another.
  const { raw, app } = setup();
  const created = await apply(
    app,
    `template_version=2
slug=legacy-comma
name_ar=منتج
name_en=Legacy Comma
status=draft
price_iqd=1000
usage_steps.1.kind=setup
usage_steps.1.title=Two pictures
usage_steps.1.images=${STEP_IMAGE_A},${STEP_IMAGE_B}
`
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const guide = JSON.parse(
    String(
      row<{ usage_guide: string }>(
        raw,
        'SELECT usage_guide FROM products WHERE id = ?',
        created.body.product_id as string
      )!.usage_guide
    )
  ) as { steps: Array<{ images: string[] }> };
  assert.deepEqual(
    guide.steps[0].images,
    [STEP_IMAGE_A, STEP_IMAGE_B],
    'a comma FOLLOWED BY a new address is still a separator'
  );
});

test('a site-relative R2 path list separates too', async () => {
  const { raw, app } = setup();
  const created = await apply(
    app,
    `template_version=2
slug=relative-imgs
name_ar=منتج
name_en=Relative
status=draft
price_iqd=1000
usage_steps.1.kind=setup
usage_steps.1.title=Uploaded
usage_steps.1.images=/api/media/a.jpg,/api/media/b.jpg
`
  );
  const guide = JSON.parse(
    String(
      row<{ usage_guide: string }>(
        raw,
        'SELECT usage_guide FROM products WHERE id = ?',
        created.body.product_id as string
      )!.usage_guide
    )
  ) as { steps: Array<{ images: string[] }> };
  assert.deepEqual(guide.steps[0].images, ['/api/media/a.jpg', '/api/media/b.jpg']);
});

// ============================================ export → import round trip (10)

test('10 — export → import leaves the guide, and the resolved prices, unchanged', async () => {
  const { app } = setup();
  const id = (await apply(app, TXT)).body.product_id as string;

  // The store's own export, re-imported over the same product. It is served
  // as a downloadable .txt attachment, not JSON.
  const res = await get(app, `/api/admin/template/export/${id}`);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.ok(text.length > 0, 'the export produced a file');
  // Space-joined from here on, and the comma-bearing URL survives whole.
  assert.match(text, new RegExp(`usage_steps\\.1\\.images=.*${STEP_IMAGE_B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const before = await formDoc(app, id);
  const back = await apply(app, text, { mode: 'update', id });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const after = await formDoc(app, id);

  assert.deepEqual(
    after.usage_guide.steps.map((s) => ({ id: s.id, images: s.images, video: s.video_url, link: s.link_url })),
    before.usage_guide.steps.map((s) => ({ id: s.id, images: s.images, video: s.video_url, link: s.link_url })),
    'a round trip through the store’s own export must change nothing'
  );
  assert.equal(after.price_iqd, before.price_iqd, 'and no customer price moved');
  assert.equal(after.prime_price_iqd, before.prime_price_iqd);
  assert.equal(after.pro_price_iqd, before.pro_price_iqd);
});

// ================================================ the form says what it drops

test('the form warns before a media-only step is silently discarded', () => {
  // `upgradeUsageGuide` keeps a step only when it has a title or a body. That
  // rule is right — a blank card on the product page is worse — but the form
  // never said so, so three photos and a video could vanish behind a 200.
  const model = readFileSync(new URL('../worker/lib/productModel.ts', import.meta.url), 'utf8');
  assert.match(model, /\.filter\(\(st\) => st\.title \|\| st\.body\)/, 'the rule still stands');

  const src = readFileSync(
    new URL('../src/components/adminProducts/form/UsageGuideSection.tsx', import.meta.url),
    'utf8'
  );
  assert.match(src, /data-usage-step-warning/, 'and the form now warns instead of losing the media quietly');
  assert.match(src, /st\.images\.length > 0 \|\| st\.video_url \|\| st\.link_url/, 'only when there IS media to lose');
});
