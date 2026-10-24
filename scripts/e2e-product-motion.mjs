/**
 * Real-component regressions for the product photo journey and gallery.
 * Runs against a local fixture only: no live accounts, products or analytics.
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node scripts/e2e-product-motion.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const entry = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { LanguageProvider } from './src/LanguageContext';
import SafeImage from './src/components/ui/SafeImage';
import DissolveImage from './src/components/motion/DissolveImage';
import GallerySurface from './src/components/motion/GallerySurface';
import { ProductTransitionLink, useProductEntrance } from './src/components/motion/ProductTransition';
const cfg = window.motionConfig || {};
function Catalog() {
  return <><div style={{height:120}} /><ProductTransitionLink id="open" to="/product/test" data-product-id="test">
    <div data-motion-photo className="card"><SafeImage src={cfg.responsive ? '/files/products/motion-a.png' : '/small-a.svg'} sizes="160px" alt="Product" eager fit="cover" className="full" imgClassName="top" /></div>
    <span>Open product</span></ProductTransitionLink><div style={{height:900}} /></>;
}
function Product() {
  const [ready, setReady] = useState(false), [index, setIndex] = useState(0);
  const [motion, setMotion] = useState(true), [zoom, setZoom] = useState(false), [preview, setPreview] = useState('');
  const hero = useRef(null), navigate = useNavigate();
  useProductEntrance(hero, ready);
  useEffect(() => { const timer = setTimeout(() => setReady(true), cfg.dataDelay ?? 600); return () => clearTimeout(timer); }, []);
  const images = [cfg.responsive ? '/files/products/motion-a.png' : '/large-a.svg','/large-b.svg','/large-c.svg', '/broken.svg'];
  const move = (step, animate = true) => { setMotion(animate); setIndex((i) => (i + step + images.length) % images.length); };
  return <><header><button id="back" onClick={() => navigate(-1)}>Back</button><Link id="other" to="/other">Other page</Link></header>
    {ready ? <><GallerySurface ref={hero} data-gallery-hero className="hero" count={images.length} direction={cfg.rtl ? 'rtl' : 'ltr'} onStep={move} tabIndex={0}>
      <DissolveImage animate={motion} src={images[index]} fit="contain" eager sizes="520px" naturalWidth={600} className="full" imgClassName="p-3" />
      <button id="zoom" className="zoom" onClick={() => { document.body.dataset.zoomed = 'true'; if (cfg.zoom) { setPreview(hero.current.querySelector('img[data-main-image]').currentSrc); setZoom(true); } }}>Zoom</button>
    </GallerySurface><output id="index">{index}</output><div>{images.map((image,i) => <button key={image} id={'image-' + i} onClick={() => { setMotion(true); setIndex(i); }}>Image {i + 1}</button>)}</div></>
    : <div data-product-gallery-placeholder className="hero"><div className="skeleton full" /></div>}
    {zoom && <GallerySurface data-lightbox count={images.length} direction={cfg.rtl ? 'rtl' : 'ltr'} onStep={move} tabIndex={0} style={{position:'fixed',inset:'40px 16px',zIndex:200}}>
      <DissolveImage animate={motion} src={images[index].replace('/large-', '/zoom-')} placeholderSrc={index === 0 ? preview : undefined} fit="contain" eager className="full" imgClassName="p-3" />
      <button id="close-zoom" onClick={() => setZoom(false)}>Close</button>
    </GallerySurface>}
    <div style={{height:1000}}>Product content</div></>;
}
function App() {
  const location = useLocation();
  useEffect(() => { document.querySelector('main').scrollTop = 0; }, [location.key]);
  return <main id="main-scroll-container"><Routes><Route path="/" element={<Catalog />} /><Route path="/product/test" element={<Product />} /><Route path="/other" element={<p>Other page</p>} /></Routes></main>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><LanguageProvider><BrowserRouter><App /></BrowserRouter></LanguageProvider></React.StrictMode>);
`;
const result = await build({
  stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'product-motion-harness.tsx', loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', logLevel: 'silent',
  loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'production', BASE_URL: '/', SSR: false }) },
});
const css = `:root{--color-surface:#eee;--color-surface-selected:#ddd;--duration-ui:250ms;--ease-move:cubic-bezier(.77,0,.175,1)}*{box-sizing:border-box}body{margin:0}main{height:100vh;overflow-y:auto}header{height:64px}button{min-width:44px;min-height:44px}a{display:block}.card{width:160px;height:130px;position:relative;overflow:hidden;background:#eee;margin-left:24px;border-radius:16px}.hero{width:calc(100% - 32px);height:340px;max-width:760px;position:relative;overflow:hidden;margin:0 16px;background:#eee;border-radius:16px}.full,.w-full{width:100%}.full,.h-full{height:100%}.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}.overflow-hidden{overflow:hidden}.object-cover{object-fit:cover}.object-contain{object-fit:contain}.top{object-position:50% 4%}.p-3{padding:12px}.opacity-100{opacity:1}.bg-surface{background:#eee}.skeleton{background:#ccc}.zoom{position:absolute;right:8px;bottom:8px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden}@media(min-width:800px){.hero{height:520px}}` + readFileSync(join(ROOT, 'src/components/motion/media.css'), 'utf8');
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css + '</style></head><body><div id="root"></div><script src="/harness.js" type="module"></script></body></html>';
const svg = (name) => '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="' + (name.includes('-b') ? '#d26b35' : name.includes('-c') ? '#458463' : '#3570a0') + '"/><rect x="120" y="80" width="360" height="440" rx="28" fill="#ddd"/><circle cx="300" cy="300" r="100" fill="#222"/></svg>';
const server = createServer((request, response) => {
  if (request.url === '/harness.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(result.outputFiles[0].text); return; }
  if (request.url === '/broken.svg') { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('Not found'); return; }
  if (request.url?.startsWith('/files/products/motion-a.png')) { response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(svg('-a')); return; }
  if (request.url?.endsWith('.svg')) { response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public,max-age=3600' }); response.end(svg(request.url)); return; }
  response.writeHead(200, { 'content-type': 'text/html' }); response.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let checks = 0;
const check = (label, condition) => { assert.ok(condition, label); checks++; console.log('ok ' + label); };
const screenshotDir = process.env.MOTION_SCREENSHOT_DIR;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

async function open(config = {}, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 800 }, hasTouch: mobile, isMobile: mobile });
  await context.addInitScript((value) => { window.motionConfig = value; }, config);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (config.imageDelay) await context.route('**/large-a.svg', async (route) => { await new Promise((r) => setTimeout(r, config.imageDelay)); await route.continue(); });
  if (config.responsive) await context.route('**/files/products/motion-a.png*', async (route) => {
    const width = Number(new URL(route.request().url()).searchParams.get('w'));
    if (!width || width > 240) await new Promise((r) => setTimeout(r, config.imageDelay || 600));
    await route.continue();
  });
  if (config.zoom) await context.route('**/zoom-*.svg', async (route) => { await new Promise((r) => setTimeout(r, 600)); await route.continue(); });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('.card [data-image-state="loaded"]'));
  return { page, context, errors };
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('[data-gallery-hero] [data-image-state="loaded"]'));
  await page.waitForFunction(() => !document.querySelector('[data-product-transition]'));
}
async function drag(page, dx, dy = 0, selector = '[data-gallery-hero]') {
  const r = await page.locator(selector).boundingBox();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 6 }); await page.mouse.up();
}
async function touch(context, page, dx, dy = 0) {
  const r = await page.locator('[data-gallery-hero]').boundingBox(), session = await context.newCDPSession(page);
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  await page.evaluate(() => {
    window.gestureTrace = [];
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      document.querySelector('[data-gallery-hero]').addEventListener(name, (event) => window.gestureTrace.push({ type: event.type, x: event.clientX, y: event.clientY, id: event.pointerId, primary: event.isPrimary, button: event.button, target: event.target.tagName }));
    }
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 6, y: y + dy * i / 6 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  // CDP acknowledges dispatch before React's touch update has committed.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => ({ events: window.gestureTrace, action: getComputedStyle(document.querySelector('[data-gallery-hero]')).touchAction }));
}
const index = (page) => page.locator('#index').textContent();
try {
  {
    const { page, context, errors } = await open({ dataDelay: 700, imageDelay: 900, responsive: true });
    const source = await page.locator('.card img[data-main-image]').evaluate((img) => img.currentSrc);
    check('the source is a responsive thumbnail candidate', source.includes('?w='));
    await page.click('#open');
    await page.waitForFunction(() => document.querySelector('[data-product-transition]')?.getAnimations().length > 0);
    check('the actual photo is in flight while product data is pending', await page.locator('[data-product-gallery-placeholder]').count() === 1);
    check('the flight has one pinned image and no skeleton/srcset/reveal clones', await page.locator('[data-product-transition]').evaluate((el) => el.querySelectorAll('img').length === 1 && !el.querySelector('[srcset],.skeleton,.u258,.u349')));
    check('the decoded source candidate is reused', await page.locator('[data-transition-picture]').getAttribute('src') === source);
    if (screenshotDir) {
      await page.locator('[data-product-transition]').evaluate((el) => el.getAnimations({ subtree: true }).forEach((animation) => { animation.pause(); animation.currentTime = 125; }));
      await page.screenshot({ path: join(screenshotDir, 'photo-flight.png') });
      await page.locator('[data-product-transition]').evaluate((el) => el.getAnimations({ subtree: true }).forEach((animation) => animation.play()));
    }
    await page.waitForFunction(() => document.querySelector('[data-product-gallery-placeholder] > [data-product-transition]'));
    check('the photo covers the loading hero after the flight finishes', await page.locator('[data-transition-picture]').evaluate((img) => img.complete && img.naturalWidth > 0));
    await page.waitForSelector('[data-gallery-hero]');
    check('the same preview survives until the larger image loads', await page.locator('[data-gallery-hero] > [data-product-transition]').count() === 1);
    await ready(page);
    check('decoded destination replaces the preview without leftover layers', await page.locator('[data-product-transition]').count() === 0);
    await page.click('#back');
    await page.waitForFunction(() => document.querySelector('[data-product-transition="back"]')?.getAnimations().length > 0);
    check('Back animates a decoded photo, never a skeleton', await page.locator('[data-transition-picture]').evaluate((img) => img.complete && img.naturalWidth > 0));
    check('the cached card photo waits for the returning photo to arrive', await page.locator('.card img[data-main-image]').evaluate((img) => getComputedStyle(img).visibility === 'hidden'));
    await page.waitForFunction(() => !document.querySelector('[data-product-transition]'));
    check('Back restores focus to the original product link', await page.locator('#open').evaluate((el) => el === document.activeElement));
    check('StrictMode and loading transitions raise no runtime errors', errors.length === 0);
    await context.close();
  }
  {
    const { page, context } = await open({ dataDelay: 1500 });
    await page.click('#open');
    await page.waitForSelector('[data-product-gallery-placeholder]');
    await page.waitForTimeout(80);
    await page.click('#back');
    await page.waitForFunction(() => !document.querySelector('[data-product-transition]'));
    check('Back during data loading leaves no stranded preview', await page.locator('#open').count() === 1);
    await page.click('#open'); await page.waitForSelector('#other'); await page.click('#other');
    await page.waitForFunction(() => !document.querySelector('[data-product-transition]'));
    check('navigating somewhere else cancels the image journey', await page.locator('[data-transition-picture]').count() === 0);
    await context.close();
  }
  {
    const { page, context, errors } = await open({ dataDelay: 0 });
    await page.click('#open');
    await page.waitForFunction(() => document.querySelector('[data-gallery-hero] [data-image-state="loaded"]') && document.querySelector('[data-product-transition]')?.getAnimations().length);
    check('a fast destination image stays hidden during the flight', await page.locator('[data-gallery-hero] img[data-main-image]').evaluate((img) => getComputedStyle(img).visibility === 'hidden'));
    await ready(page);
    check('the destination is visible again after the handoff', await page.locator('[data-gallery-hero] img[data-main-image]').evaluate((img) => getComputedStyle(img).visibility === 'visible'));
    await page.click('#image-1');
    await page.waitForSelector('.u349-cells');
    const effects = await page.locator('[data-gallery-hero]').evaluate((hero) => ({
      cells: hero.querySelectorAll('.u349-cells i').length,
      names: [...new Set(Array.from(hero.querySelectorAll('.u349-cells i'), (el) => getComputedStyle(el).animationName))],
      image: { filter: getComputedStyle(hero.querySelector('img[data-main-image]')).filter, transform: getComputedStyle(hero.querySelector('img[data-main-image]')).transform },
      delays: Array.from(hero.querySelectorAll('.u349-cells i')).slice(0,12).map((el) => parseFloat(getComputedStyle(el).animationDelay)),
      origins: Array.from(hero.querySelectorAll('.u349-cells i'), (el) => {
        const rect = el.getBoundingClientRect(), position = getComputedStyle(el).backgroundPosition.split(' ').map(parseFloat);
        return { x: rect.x + position[0], y: rect.y + position[1] };
      }),
    }));
    check('only the 108-cell pixel dissolve animates', effects.cells === 108 && effects.names.join(',') === 'u349-pixel');
    check('the image has no competing blur or zoom effect', effects.image.filter === 'none' && effects.image.transform === 'none');
    check('pixel timing is scattered rather than a vertical-column wipe', effects.delays.some((n, i) => i > 0 && n < effects.delays[i - 1]));
    check('pixel tiles reconstruct one aligned photo in an RTL document', effects.origins.every((origin) => Math.abs(origin.x - effects.origins[0].x) < 1 && Math.abs(origin.y - effects.origins[0].y) < 1));
    if (screenshotDir) {
      await page.locator('.u349-cells').evaluate((el) => el.getAnimations({ subtree: true }).forEach((animation) => { animation.pause(); animation.currentTime = 150; }));
      await page.screenshot({ path: join(screenshotDir, 'pixel-dissolve.png') });
    }
    await page.click('#image-2'); await page.click('#image-0');
    await page.waitForFunction(() => !document.querySelector('.u349-cells,.u349-previous'));
    check('rapid selection settles on the latest image with no old layer', await page.locator('[data-gallery-hero] img[data-main-image]').getAttribute('src') === '/large-a.svg');
    await drag(page, -120); check('mouse drag left selects the next LTR image', await index(page) === '1');
    await drag(page, 120); check('mouse drag right selects the previous image', await index(page) === '0');
    await drag(page, 4, 3); check('a tap is not a swipe', await index(page) === '0');
    await page.click('#zoom'); check('gallery controls remain clickable after a gesture', await page.locator('body').getAttribute('data-zoomed') === 'true');
    await page.locator('[data-gallery-hero]').hover(); await page.mouse.wheel(150, 0);
    await page.waitForFunction(() => document.querySelector('#index').textContent === '1');
    check('horizontal trackpad scrolling selects a photo', await index(page) === '1');
    await page.locator('[data-gallery-hero]').press('ArrowRight'); check('keyboard navigation remains available', await index(page) === '2');
    await page.waitForFunction(() => document.querySelector('[data-gallery-hero] [data-image-state="loaded"]'));
    check('keyboard selection has no decorative pixel animation', await page.locator('.u349-cells').count() === 0);
    await page.click('#image-3');
    await page.waitForSelector('[data-gallery-hero] [data-image-state="error"]');
    check('a failed image exposes retry instead of trapping a previous photo', await page.locator('.u349-cells,.u349-previous').count() === 0);
    check('gallery interactions raise no runtime errors', errors.length === 0);
    await context.close();
  }
  {
    const { page, context } = await open({ dataDelay: 0, rtl: true }, true);
    await page.click('#open'); await ready(page);
    const trace = await touch(context, page, 120);
    if (await index(page) !== '1') console.error(JSON.stringify(trace));
    check('RTL touch swipe right selects the next photo', await index(page) === '1');
    await touch(context, page, -120); check('RTL touch swipe left selects the previous photo', await index(page) === '0');
    await touch(context, page, 4, -180);
    check('vertical touch scrolling does not change the selected photo', await index(page) === '0');
    check('vertical touch scrolling still moves the page', await page.locator('main').evaluate((el) => el.scrollTop > 0));
    await context.close();
  }
  {
    const { page, context } = await open({ dataDelay: 0, zoom: true });
    await page.click('#open'); await ready(page); await page.click('#zoom');
    await page.waitForSelector('[data-lightbox] [data-image-state="loading"]');
    check('opening the enlarged image reuses its decoded preview without a skeleton', await page.locator('[data-lightbox] img[data-image-placeholder]').evaluate((img) => img.complete && img.naturalWidth > 0) && await page.locator('[data-lightbox] .animate-pulse').count() === 0);
    await page.waitForSelector('[data-lightbox] [data-image-state="loaded"]');
    await drag(page, -120, 0, '[data-lightbox]');
    check('the enlarged gallery accepts horizontal swipes', await index(page) === '1');
    check('the enlarged gallery holds the old photo during a new image request', await page.locator('[data-lightbox] .u349-previous').count() === 1);
    await page.waitForSelector('[data-lightbox] [data-image-state="loaded"]');
    check('the enlarged gallery finishes on the selected image', await page.locator('[data-lightbox] img[data-main-image]').getAttribute('src') === '/zoom-b.svg');
    await context.close();
  }
  {
    const { page, context } = await open({ dataDelay: 0 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.click('#open'); await ready(page);
    check('reduced motion skips the spatial journey', await page.locator('[data-product-transition]').count() === 0);
    await page.click('#image-1'); await page.waitForFunction(() => document.querySelector('[data-gallery-hero] [data-image-state="loaded"]'));
    check('reduced motion skips pixel movement and shows the chosen image', await page.locator('.u349-cells').count() === 0 && await index(page) === '1');
    await context.close();
  }
  console.log('PASS ' + checks + ' product motion browser checks');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
