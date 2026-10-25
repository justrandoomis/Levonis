/** Native browser snapshots with the real navigation router and pending store.
 * Local fixture only; same PLAYWRIGHT_MODULE / CHROMIUM_PATH as product-motion. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const bundle = await build({
  stdin: { resolveDir: root, sourcefile: 'stack-fixture.tsx', loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Link, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
    import NavigationRouter from './src/components/NavigationRouter';
    import { useBusySnapshot } from './src/lib/busy';
    import { ProductTransitionLink, useProductEntrance } from './src/components/motion/ProductTransition';
    const Slow = React.lazy(() => new Promise(resolve => setTimeout(() => resolve({default: () => <p id="slow-page">Slow page</p>}), 900)));
    function Product() { const ref = React.useRef(null); useProductEntrance(ref, true); return <div ref={ref} data-gallery-hero style={{width:350,height:300}}><img data-main-image src="/photo.svg" width="300" height="300" /></div>; }
    function App() {
      const location = useLocation(), navigate = useNavigate(), busy = useBusySnapshot();
      React.useEffect(() => { document.querySelector('main').scrollTop = 0; }, [location.key]);
      return <><nav><Link id="home" to="/">Home</Link><Link id="next" to="/next">Next</Link><Link id="slow" to="/slow">Slow</Link>
        <Link id="query" to={location.pathname+'?q=1'}>Query</Link><button id="back" onClick={() => navigate(-1)}>Back</button>
        <button id="replace" onClick={() => navigate('/next', {replace:true})}>Replace</button>
        <button id="rapid" onClick={() => { navigate('/slow'); navigate('/next'); }}>Rapid</button></nav>
        <output id="busy">{busy.reason || 'idle'}</output><main><React.Suspense fallback={<p>Loading</p>}><Routes>
          <Route path="/" element={<><h1>Home</h1><ProductTransitionLink id="product" to="/product/test" data-product-id="test"><div data-motion-photo style={{width:120,height:120}}><img data-main-image src="/photo.svg" width="120" height="120" /></div></ProductTransitionLink></>} />
          <Route path="/next" element={<h1>Next page</h1>} /><Route path="/slow" element={<Slow />} /><Route path="/product/test" element={<Product />} />
        </Routes></React.Suspense></main></>;
    }
    createRoot(document.getElementById('root')).render(<React.StrictMode><NavigationRouter><App /></NavigationRouter></React.StrictMode>);
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
});
const css = ':root{--duration-ui:.25s;--ease-drawer:cubic-bezier(.32,.72,0,1)}body{margin:0;background:#fff;color:#111}nav{display:flex;gap:15px;padding:20px}main{height:80vh;overflow:auto}h1{padding:60px}img{object-fit:contain}' + readFileSync(join(root, 'src/lib/stackNavigation.css'), 'utf8');
const server = createServer((request, response) => {
  if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].text); }
  else if (request.url === '/photo.svg') { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="blue"/></svg>'); }
  else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css + '</style><div id="root"></div><script type="module" src="/app.js"></script></html>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let checks = 0;
const check = (name, result) => { assert.ok(result, name); checks++; console.log('ok ' + name); };
async function open(rtl = false, reducedMotion = 'no-preference', unsupported = false) {
  const context = await browser.newContext({ viewport: { width: 600, height: 800 }, reducedMotion });
  await context.addInitScript(({ rtl, unsupported }) => {
    window.stackRuns = [];
    document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = rtl ? 'rtl' : 'ltr'; });
    if (unsupported) { document.startViewTransition = undefined; return; }
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (update) => {
      const record = { back: document.documentElement.hasAttribute('data-stack-back'), frames: [] }; window.stackRuns.push(record);
      const transition = start(update);
      transition.ready.then(() => {
        record.frames = document.getAnimations().filter(a => a.animationName?.startsWith('lv-stack-')).map(a => ({ name: a.animationName, duration: a.effect.getTiming().duration, frames: a.effect.getKeyframes() }));
      }).catch(error => { record.error = error.message; });
      return transition;
    };
  }, { rtl, unsupported });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForSelector('#next');
  await page.waitForTimeout(200); // afterCriticalPaint + idle import in the actual router
  return { page, context, errors };
}
const settled = page => page.waitForFunction(() => !document.documentElement.classList.contains('lv-stack-vt'));
try {
  for (const rtl of [false, true]) {
    const { page, context, errors } = await open(rtl);
    await page.click('#next');
    await page.waitForFunction(() => window.stackRuns.at(-1)?.frames.length === 2).catch(async error => { console.log(await page.evaluate(() => ({ runs: window.stackRuns, body: document.body.textContent })), errors); throw error; });
    const push = await page.evaluate(() => window.stackRuns.at(-1));
    check('push has two real browser snapshots at 250ms (' + (rtl ? 'RTL' : 'LTR') + ')', push.frames.every(f => f.duration === 250));
    check('incoming page enters from the correct side', push.frames.find(f => f.name === 'lv-stack-enter').frames[0].transform.includes(rtl ? '-120%' : '120%'));
    check('outgoing page retreats and dims', push.frames.find(f => f.name === 'lv-stack-retreat').frames.at(-1).opacity === '0.84');
    await settled(page); await page.click('#back');
    await page.waitForFunction(() => window.stackRuns.at(-1)?.back && window.stackRuns.at(-1)?.frames.length === 2);
    check('Back reverses the stack instead of pushing another page', (await page.evaluate(() => window.stackRuns.at(-1).frames.map(f => f.name))).includes('lv-stack-return'));
    await settled(page);
    const count = await page.evaluate(() => window.stackRuns.length);
    await page.click('#query'); await page.waitForTimeout(100);
    check('query-only changes preserve the page without a push', await page.evaluate(() => window.stackRuns.length) === count);
    await page.click('#replace'); await page.waitForTimeout(100);
    check('redirect/replacement does not create a fake stack entry', await page.evaluate(() => window.stackRuns.length) === count);
    await page.locator('#home').focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(100);
    check('keyboard navigation stays immediate', await page.evaluate(() => window.stackRuns.length) === count);
    check('route transitions leave no runtime errors', errors.length === 0);
    await context.close();
  }
  {
    const { page, context, errors } = await open();
    await page.click('#slow');
    await page.waitForFunction(() => document.querySelector('#busy').textContent === 'route');
    await page.waitForTimeout(300);
    check('a delayed chunk releases its snapshot while route loading stays visible', await page.evaluate(() => !document.documentElement.classList.contains('lv-stack-vt') && document.querySelector('#busy').textContent === 'route'));
    await page.waitForSelector('#slow-page'); await page.waitForFunction(() => document.querySelector('#busy').textContent === 'idle');
    check('the slow route eventually commits and releases its busy hold', true);
    await page.click('#home'); await settled(page); await page.click('#rapid');
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Next page'); await settled(page);
    check('rapid superseding navigation cannot commit the stale destination', new URL(page.url()).pathname === '/next');
    await page.click('#home'); await settled(page);
    const count = await page.evaluate(() => window.stackRuns.length);
    await page.click('#product'); await page.waitForSelector('[data-gallery-hero]');
    check('photo zoom owns product opening without a second stack animation', await page.evaluate(() => window.stackRuns.length) === count);
    await page.click('#back'); await page.waitForSelector('#product');
    check('the returning product photo is also excluded from the stack', await page.evaluate(() => window.stackRuns.length) === count);
    check('interruption and photo transitions raise no errors', errors.length === 0);
    await context.close();
  }
  for (const unsupported of [false, true]) {
    const { page, context } = await open(false, unsupported ? 'no-preference' : 'reduce', unsupported);
    await page.click('#next'); await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Next page');
    check(unsupported ? 'unsupported browsers still navigate normally' : 'reduced motion has no spatial page movement', await page.evaluate(() => window.stackRuns.length === 0 && document.querySelector('h1').textContent === 'Next page'));
    await context.close();
  }
  console.log('PASS ' + checks + ' stack navigation browser checks');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
