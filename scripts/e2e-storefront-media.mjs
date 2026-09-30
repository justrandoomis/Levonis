#!/usr/bin/env node
/**
 * MEDIA EVERYWHERE ON THE STORE PAGE, DRIVEN IN A REAL BROWSER (P5,
 * docs/MERCHANT_PLATFORM_V2.md storefront L3/L4/L6/L7/L8, §5).
 *
 * The real renderer (tests/browser/storefront-media.html) with a fixed store:
 * a hero with a video and its poster, a page background (picture or video),
 * the notice line, footer links and two scheduled sections. `/files/*` is
 * answered here: pictures as SVG, videos with a small WebM recorded on start.
 *
 *   - the hero's and the background's video NEVER mount under reduced motion,
 *     under Save-Data, or on a phone by default — the stills are there;
 *   - on a wide screen the background's video mounts once the page is idle;
 *     tapping the hero's play control mounts the hero's and unmounts the
 *     background's: EXACTLY ONE <video> at a time; «إيقاف حركة الخلفية» stops it;
 *   - «phones» / `video_on_phone` let a phone play them;
 *   - the builder's preview never mounts a video and marks scheduled sections;
 *   - the notice line shows (under the bar for `bar`), links, and hides for the visit;
 *   - footer links: two links and a plain label;
 *   - a section scheduled in the past is not on the live page;
 *   - no horizontal overflow at 360; ar / en / ckb; reduced motion on and off;
 *     the app's light theme leaves the store a dark island.
 *
 * Screenshots: OUT_DIR (default /tmp/claude-0/shots/p5-media), <name>-<width>-<lang>[-rm].png.
 *
 * Run: with the repo served by vite (`npx vite --port 4191`),
 *      PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright STORE_MEDIA_URL=http://127.0.0.1:4191 node scripts/e2e-storefront-media.mjs
 */
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.STORE_MEDIA_URL || 'http://127.0.0.1:4191';
const OUT = process.env.OUT_DIR || '/tmp/claude-0/shots/p5-media';
await mkdir(OUT, { recursive: true });

let failures = 0;
let passes = 0;
const check = (cond, msg) => {
  if (cond) {
    passes += 1;
    console.log('ok', msg);
  } else {
    failures += 1;
    console.log('FAIL', msg);
  }
};

const b = await chromium.launch();

/** A small real WebM (the browser's own recording of a moving picture), made once per OUT_DIR. */
async function clip() {
  const path = `${OUT}/clip.webm`;
  try {
    if ((await stat(path)).size > 10_000) return readFile(path);
  } catch {
    /* record it */
  }
  const ctx = await b.newContext({ viewport: { width: 640, height: 360 }, recordVideo: { dir: `${OUT}/rec`, size: { width: 640, height: 360 } } });
  const p = await ctx.newPage();
  await p.setContent(
    '<body style="margin:0;overflow:hidden"><div id="d" style="width:640px;height:360px;background:linear-gradient(120deg,#0e7490,#1f3b4d 40%,#d2c392)"></div><div id="c" style="position:absolute;top:120px;left:0;width:120px;height:120px;border-radius:60px;background:#f2c14e"></div><script>let t=0;setInterval(()=>{t+=1;c.style.left=((t*9)%560)+"px";d.style.filter="hue-rotate("+t*4+"deg)"},40)</script></body>'
  );
  await p.waitForTimeout(2600);
  const video = p.video();
  await ctx.close();
  const { copyFile } = await import('node:fs/promises');
  await copyFile(await video.path(), path);
  return readFile(path);
}
const WEBM = await clip();

const COLOURS = { herocov1: ['#1f3b4d', '#0e7490'], bgpost01: ['#3b2f4d', '#7c3a5c'], bgpic001: ['#27402a', '#9a7b2f'], prod0001: ['#4d3b1f', '#b0662d'], prod0002: ['#1f4d45', '#2d9ab0'], prod0003: ['#402742', '#b02d8a'] };
const svg = (name) => {
  const [a, c] = COLOURS[name] ?? ['#2a2d33', '#5a6270'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="880" cy="240" r="150" fill="#d2c392" opacity=".35"/><rect x="120" y="520" width="520" height="90" rx="45" fill="#ffffff" opacity=".18"/></svg>`;
};

/**
 * One visit. `flags`: reduced, saveData, light; `q`: the fixture's query.
 * Returns the page for the caller's checks.
 */
async function visit(lang, width, q = {}, flags = {}) {
  const ctx = await b.newContext({
    viewport: { width, height: width < 700 ? 780 : 900 },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    reducedMotion: flags.reduced ? 'reduce' : 'no-preference',
  });
  if (flags.saveData) {
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true, addEventListener() {}, removeEventListener() {} } });
    });
  }
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource|play\(\) request was interrupted/.test(m.text()) && errors.push('console: ' + m.text().slice(0, 200)));
  const videoRequests = [];
  await p.route(
    (u) => u.pathname.startsWith('/files/'),
    (r) => {
      const name = r.request().url().split('/').pop() ?? '';
      if (/\.(webm|mp4)$/.test(name)) {
        videoRequests.push(name);
        return r.fulfill({ status: 200, contentType: 'video/webm', body: WEBM });
      }
      return r.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(name.replace(/\.\w+$/, '')) });
    }
  );
  const qs = new URLSearchParams({ lang, ...q, ...(flags.light ? { theme: 'light' } : {}) });
  await p.goto(`${origin}/tests/browser/storefront-media.html?${qs}`);
  await p.waitForSelector('[data-store-theme]', { timeout: 30000 });
  const tag = `${lang} ${width}${flags.reduced ? ' reduced' : ''}${flags.saveData ? ' save-data' : ''} ${new URLSearchParams(q)}`;
  const shot = async (name) => {
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${OUT}/${name}-${width}-${lang}${flags.reduced ? '-rm' : ''}.png`, fullPage: false });
    console.log('shot', name);
  };
  const videos = () => p.locator('video').count();
  const done = async () => {
    check(errors.length === 0, `${tag}: no page errors (${errors.join(' | ').slice(0, 300)})`);
    await ctx.close();
  };
  return { p, tag, shot, videos, done, videoRequests };
}

const idle = (p) => p.waitForTimeout(2600);

// 1. Wide, motion allowed: the background moves after idle; the hero's tap takes the one video slot.
for (const lang of ['ar', 'en']) {
  const v = await visit(lang, 1280, { bg: 'video' });
  const { p, tag } = v;
  // The layer is its own lazy chunk (the storefront's 47 KB budget): it arrives behind the blocks, poster first.
  await p.waitForSelector('[data-sf-background="video"] img', { timeout: 10000 }).catch(() => null);
  check((await p.locator('[data-sf-background="video"] img').count()) === 1, `${tag}: the background's poster paints first`);
  await p.waitForSelector('[data-sf-background] video[data-store-video]', { timeout: 10000 }).catch(() => null);
  check((await v.videos()) === 1 && (await p.locator('[data-sf-background] video').count()) === 1, `${tag}: after idle, the background's video — and only it`);
  await p.waitForFunction(() => document.querySelector('[data-sf-background] video')?.classList.contains('opacity-100'), null, { timeout: 8000 }).then(
    () => check(true, `${tag}: it fades in once frames play`),
    () => check(false, `${tag}: it fades in once frames play`)
  );
  await v.shot('m1-background-video');
  const play = p.locator('[data-hero-video="still"] button');
  check((await play.count()) === 1, `${tag}: the hero offers its video with a play control`);
  // Review 2026-09-30: ONE mechanism — the label says what a press does, and no `aria-pressed` contradicts it.
  const playLabel = (await play.getAttribute('aria-label')) ?? '';
  check(/\S/.test(playLabel) && (await play.getAttribute('aria-pressed')) === null, `${tag}: the play control names its action («${playLabel}»), no aria-pressed`);
  await play.click();
  await p.waitForSelector('[data-hero-video="playing"]', { timeout: 5000 });
  const stopLabel = (await p.locator('[data-hero-video="playing"] button').getAttribute('aria-label')) ?? '';
  check(/\S/.test(stopLabel) && stopLabel !== playLabel, `${tag}: playing, the control now says «${stopLabel}»`);
  await p.waitForSelector('[data-block-id="hero"] video', { timeout: 8000 });
  check((await v.videos()) === 1 && (await p.locator('[data-block-id="hero"] video').count()) === 1, `${tag}: tapped — the hero's video, and the background's gone (exactly one)`);
  await p.waitForTimeout(900);
  await v.shot('m2-hero-playing');
  await p.locator('[data-hero-video="playing"] button').click();
  await p.waitForSelector('[data-sf-background] video', { timeout: 8000 }).catch(() => null);
  check((await p.locator('[data-block-id="hero"] video').count()) === 0 && (await v.videos()) === 1, `${tag}: stopped — the background's video comes back`);
  const toggle = p.locator('[data-store-bg-toggle]');
  check((await toggle.count()) === 1, `${tag}: the moving background can be stopped`);
  const stopWords = (await toggle.innerText()).trim();
  await toggle.click();
  await p.waitForTimeout(300);
  const playWords = (await toggle.innerText()).trim();
  check((await v.videos()) === 0 && playWords !== stopWords && (await toggle.getAttribute('aria-pressed')) === null, `${tag}: stopped — no video, the still stays, the control now offers «${playWords}»`);
  check((await p.locator('[data-sf-background="video"] img').count()) === 1, `${tag}: the poster is still there`);
  await toggle.scrollIntoViewIfNeeded();
  await v.shot('m3-footer-and-toggle');
  await v.done();
}

// 2. Reduced motion, Save-Data, a phone by default: never a video, always the stills.
for (const [lang, width, flags, q] of [
  ['ar', 1280, { reduced: true }, { bg: 'video' }],
  ['en', 1280, { saveData: true }, { bg: 'video' }],
  ['ar', 360, {}, { bg: 'video' }],
  ['en', 360, { reduced: true }, { bg: 'video', phones: '1', onphone: '1' }],
]) {
  const v = await visit(lang, width, q, flags);
  const { p, tag } = v;
  await idle(p);
  check((await v.videos()) === 0, `${tag}: no <video> mounted`);
  check(v.videoRequests.length === 0, `${tag}: not a byte of video fetched (${v.videoRequests.join(',')})`);
  check((await p.locator('[data-sf-background="video"] img').count()) === 1, `${tag}: the background's still paints`);
  check((await p.locator('[data-block-id="hero"] img').first().getAttribute('src'))?.includes('herocov1'), `${tag}: the hero's cover (its poster) paints`);
  check((await p.locator('[data-hero-video]').count()) === 0, `${tag}: no play control for a video that may not play`);
  check((await p.locator('[data-store-bg-toggle]').count()) === 0, `${tag}: nothing to stop`);
  if (width < 700) {
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `${tag}: no horizontal overflow (${overflow})`);
  }
  await v.shot(flags.reduced ? 'm4-reduced' : flags.saveData ? 'm4-save-data' : 'm4-phone-still');
  await v.done();
}

// 3. A phone the merchant allowed: the background moves, the hero offers its video.
{
  const v = await visit('en', 360, { bg: 'video', phones: '1', onphone: '1' });
  const { p, tag } = v;
  await p.waitForSelector('[data-sf-background] video', { timeout: 10000 }).catch(() => null);
  check((await v.videos()) === 1, `${tag}: «phones» ticked — the background's video plays on a phone`);
  check((await p.locator('[data-hero-video="still"] button').count()) === 1, `${tag}: video_on_phone — the hero offers its video`);
  await v.shot('m5-phone-allowed');
  await v.done();
}

// 4. The notice, the footer links and the schedule — ar, en, ckb, both headers, both widths.
for (const [lang, width, q, flags] of [
  ['ar', 360, { bg: 'image', dim: 'medium' }, {}],
  ['en', 1280, { bg: 'image', dim: 'heavy', header: 'bar', hero: 'split' }, {}],
  ['ckb', 360, { bg: 'none', header: 'bar' }, {}],
  ['ckb', 1280, { bg: 'video', hero: 'cover' }, { reduced: true }],
  ['ar', 1280, { bg: 'image', hero: 'cover' }, { light: true }],
]) {
  const v = await visit(lang, width, q, flags);
  const { p, tag } = v;
  const words = { ar: 'توصيل مجاني لكل بغداد هذا الأسبوع', en: 'Free delivery across Baghdad this week', ckb: 'گەیاندنی بێ بەرامبەر بۆ هەموو بەغدا ئەم هەفتەیە' }[lang];
  const notice = p.locator('[data-store-notice]');
  check((await notice.count()) === 1 && (await notice.innerText()).includes(words), `${tag}: the notice line, in the visitor's language`);
  check(/#products$/.test((await notice.locator('a').getAttribute('href')) ?? ''), `${tag}: the notice links where the merchant pointed it`);
  const noticeY = (await notice.boundingBox())?.y ?? 0;
  const heroY = (await p.locator('[data-block-id="hero"]').boundingBox())?.y ?? 0;
  if (q.header === 'bar') check(noticeY < heroY, `${tag}: under the bar, above the hero`);
  else check(noticeY > heroY, `${tag}: after the first block`);
  check((await p.locator('[data-block-id="past-sale"]').count()) === 0, `${tag}: a section whose window has ended is not on the live page`);
  check((await p.locator('[data-block-id="live-sale"]').count()) === 1, `${tag}: a section inside its window is`);
  const links = p.locator('[data-store-footer-links]');
  check((await links.locator('a').count()) === 2 && (await links.locator('span').count()) >= 1, `${tag}: two footer links and a plain label`);
  check((await links.locator('a[target="_blank"]').getAttribute('rel')) === 'noopener noreferrer nofollow', `${tag}: the outside link cuts the opener`);
  if (q.bg !== 'none') {
    const carded = await p.locator('[data-block-id="text"] > div').first().getAttribute('class');
    check(/sf-bg sf-r-lg/.test(carded ?? ''), `${tag}: over a background, a section sits on the theme's own ground`);
    check((await p.locator('.sf-glow').count()) === 0, `${tag}: no glow over a picture`);
  }
  await v.shot(`m6-notice-${q.header ?? 'overlay'}-${q.bg}`);
  await links.scrollIntoViewIfNeeded();
  await v.shot(`m7-footer-${q.bg}`);
  if (width < 700) {
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `${tag}: no horizontal overflow (${overflow})`);
  }
  // Hidden for this visit — and still hidden after a reload in the same tab.
  await notice.locator('button').focus();
  await p.keyboard.press('Enter');
  check((await p.locator('[data-store-notice]').count()) === 0, `${tag}: «إخفاء الإعلان» hides it`);
  // Review 2026-09-30: focus goes on to the next control after the line, never to <body> with the removed button.
  const after = await p.evaluate(() => ({ tag: document.activeElement?.tagName ?? '', inPage: !!document.activeElement?.closest('[data-store-theme]') }));
  check(after.tag !== 'BODY' && after.inPage, `${tag}: focus moves on after the hide (${after.tag})`);
  await p.reload();
  await p.waitForSelector('[data-store-theme]');
  await p.waitForTimeout(300);
  check((await p.locator('[data-store-notice]').count()) === 0, `${tag}: …for the rest of the visit`);
  await v.done();
}

// 5. The builder's preview: every section, scheduled ones marked; never a video.
for (const [lang, width] of [['ar', 1280], ['en', 360]]) {
  const v = await visit(lang, width, { mode: 'preview', bg: 'video', phones: '1', onphone: '1' });
  const { p, tag } = v;
  await idle(p);
  check((await v.videos()) === 0, `${tag}: the preview never mounts a video`);
  check((await p.locator('[data-hero-video="preview"]').count()) === 1, `${tag}: the hero's play control is drawn, inert`);
  check((await p.locator('[data-scheduled-mark]').count()) === 2, `${tag}: both scheduled sections shown and marked`);
  check((await p.locator('[data-block-id="past-sale"]').count()) === 1, `${tag}: an ended window still shows in the preview`);
  await p.locator('[data-block-id="past-sale"]').scrollIntoViewIfNeeded();
  await v.shot('m8-preview-scheduled');
  await v.done();
}

await b.close();
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
