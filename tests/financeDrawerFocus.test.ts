/**
 * «المال والأرباح» — THE FIGURE DRAWER AND THE ORDER OVER IT, DRIVEN IN A REAL ENGINE (redesign step 4, its third review;
 * DECISIONS row 316).
 *
 * Plan 4.6, «two dialogs at once»: the drawer can lie under an order sheet opened from it, and the focus must come back to the
 * right place as each one closes — the drawer's row, then the overview card it was opened from — or a keyboard owner loses his
 * place. It holds today because cardClick hands the focus to the card's button before the drawer opens and each Sheet keeps what
 * was focused when it opened (ui.tsx); a test feeding cardClick a fake object could not see a change that broke the order. This
 * one drives tests/browser/finance-workspace.html — the local fixture, every API answered inside the page, no live data — in a
 * Chromium-family engine over the DevTools protocol, with trusted mouse and keyboard input:
 *   · a click on a card's figure opens the drawer; a click on a row opens its order over it; Escape closes the order and the
 *     focus is on that row; Escape again closes the drawer and the focus is on the card's button;
 *   · the same from the keyboard alone: Tab to a card's button, Enter, Tab to a row, Enter, Escape, Escape;
 *   · a double click on a card's figure selects it and opens nothing — no flash of the drawer, no order under the second click,
 *     and «الطلبات المستلمة» stays on the overview (the third review's should-fix; cardClick waits out a double click);
 *   · a click on a card's figure, then — within that wait — the dollar toggle or the Reports tab: nothing opens, neither over the
 *     page the owner went to nor by itself when the next read lands (the fourth review; cardClick, FinanceWorkspace openOn).
 * It runs where an engine is found — CHROMIUM_PATH, the sandbox's Chromium (scripts/bambu-import/browser.ts chromiumPath), or
 * Microsoft Edge on Windows — and says it skipped elsewhere (a visible skip is the house answer). The page is served by Vite
 * with the repo's own config, its dependency cache outside node_modules; the engine resolves no host but 127.0.0.1. Each run has
 * an engine profile of its own, removed when it ends, so two runs at once on one worktree never share one (the fourth review).
 *
 * Run: node --import tsx --test tests/financeDrawerFocus.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { ROOT } from './fixtures/d1';

/** The engine: the one named, the sandbox's (as scripts/bambu-import/browser.ts finds it), or Edge where Windows installs it. */
function engine(): string | undefined {
  const named = process.env.CHROMIUM_PATH;
  if (named) return named;
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium',
    ...(process.platform === 'win32' ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'] : [])];
  const found = candidates.find((path) => existsSync(path));
  return found && realpathSync(found);
}
const ENGINE = engine();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > end) throw new Error(`waited ${ms} ms for ${what}; last: ${JSON.stringify(value)}`);
    await sleep(50);
  }
}

/** The DevTools protocol over the engine's own WebSocket: one session on one page. */
class Devtools {
  private next = 0;
  private readonly waiting = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
      const call = message.id === undefined ? undefined : this.waiting.get(message.id);
      if (!call) return;
      this.waiting.delete(message.id!);
      if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result ?? {});
    });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = ++this.next;
    return new Promise<Record<string, unknown>>((resolve, reject) => { this.waiting.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params, sessionId })); });
  }
}

/** A card's open waits this long for a second click (ui.tsx DOUBLE_CLICK_MS; tests/financeOverviewScreen.test.ts holds its bounds). */
const CARD_WAIT_MS = 300;

test('the drawer and an order over it: each Escape gives the focus back to what opened it — a row, then the card — by mouse and by keyboard; a double click on a figure selects it and opens nothing; a card\'s open the owner moved on from opens nothing (third and fourth reviews, screens)', {
  skip: ENGINE ? false : 'no Chromium-family engine here (CHROMIUM_PATH, the sandbox\'s Chromium, or Edge on Windows)', timeout: 240_000,
}, async () => {
  // One dependency cache per worktree, outside node_modules (its packages are links into a shared install). The engine's profile is
  // this run's own (the fourth review): one per worktree made a second run at the same time fail — its engine could not take the
  // profile and each run deleted the other's DevTools port file — and an engine a killed run left behind would block every later one.
  const tag = createHash('sha256').update(ROOT).digest('hex').slice(0, 12), cacheDir = join(tmpdir(), `levonis-vite-${tag}`);
  const profile = mkdtempSync(join(tmpdir(), 'levonis-focus-'));
  const portFile = join(profile, 'DevToolsActivePort');
  const { createServer } = await import('vite');
  const modules = dirname(realpathSync(join(ROOT, 'node_modules', 'react')));
  // The page answers its own API calls; one made before its stub (the session, the storefront) is answered here, never by the dev proxy.
  const noApi: Plugin = { name: 'levonis:fixture-api-only', configureServer(dev) {
    dev.middlewares.use('/api', (_req, res) => { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end('{"success":false,"error":"fixture"}'); });
  } };
  const server = await createServer({ configFile: join(ROOT, 'vite.config.ts'), root: ROOT, cacheDir, logLevel: 'error', clearScreen: false, plugins: [noApi],
    optimizeDeps: { entries: ['tests/browser/finance-workspace.html'] },
    server: { host: '127.0.0.1', port: 41_000 + Math.floor(Math.random() * 8_000), strictPort: false, hmr: false, watch: null, fs: { allow: [ROOT, modules] } } });
  const browser = spawn(ENGINE!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
  let socket: WebSocket | undefined;
  try {
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    const [devPort, devPath] = (await until(async () => { try { return readFileSync(portFile, 'utf8'); } catch { return ''; } }, (text) => text.includes('\n'), 'the engine\'s DevTools port')).split('\n');
    socket = new WebSocket(`ws://127.0.0.1:${devPort.trim()}${devPath.trim()}`);
    await new Promise((resolve, reject) => { socket!.addEventListener('open', resolve, { once: true }); socket!.addEventListener('error', reject, { once: true }); });
    const devtools = new Devtools(socket);
    const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    const page = (method: string, params: Record<string, unknown> = {}) => devtools.send(method, params, sessionId);
    const evaluate = async <T>(expression: string): Promise<T> => {
      const r = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as { result?: { value?: T }; exceptionDetails?: { text: string } };
      if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.text}`);
      return r.result?.value as T;
    };
    await page('Runtime.enable');
    await page('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const open = async () => {
      await page('Page.navigate', { url: `http://127.0.0.1:${port}/tests/browser/finance-workspace.html?lang=en&finance=overview&from=2026-10-01&to=2026-10-31` });
      await until(() => evaluate<boolean>('!!document.querySelector(\'[data-finance-kpi="netShare"] .fw-open\') && !document.querySelector(\'.fw-loading\')'), Boolean, 'the overview', 90_000);
      await sleep(300);
    };
    // What a person does: the pointer pressed and released on an element's text, a third of the way in — inside its first word,
    // even a lone digit's, whose right half would put the caret after it (a double click: twice, the second counted as such), a key.
    const centre = (selector: string) => evaluate<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' });
      const range = document.createRange(); range.selectNodeContents(e); const t = range.getBoundingClientRect(), r = t.width ? t : e.getBoundingClientRect();
      return { x: r.left + r.width / 3, y: r.top + r.height / 2 }; })()`);
    const press = async (selector: string, clicks = 1) => {
      const at = await centre(selector);
      assert.ok(at, `${selector} is on the page`);
      await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      for (let n = 1; n <= clicks; n += 1) {
        await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: n });
        await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: n });
        if (n < clicks) await sleep(60);
      }
    };
    const KEYS = { Escape: { code: 'Escape', windowsVirtualKeyCode: 27 }, Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Tab: { code: 'Tab', windowsVirtualKeyCode: 9 } } as const;
    const key = async (name: keyof typeof KEYS) => {
      await page('Input.dispatchKeyEvent', { type: 'keyDown', key: name, ...KEYS[name] });
      await page('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: KEYS[name].code, windowsVirtualKeyCode: KEYS[name].windowsVirtualKeyCode });
    };
    const dialogs = () => evaluate<number>('document.querySelectorAll(\'dialog[open]\').length');
    // Where the focus is, in the page's own words: a card's button, a row of the drawer, or what else it is.
    const focus = () => evaluate<string>(`(() => { const e = document.activeElement; if (!e || e === document.body) return 'body';
      if (e.dataset && e.dataset.financeOpen) return 'card:' + e.dataset.financeOpen; const row = e.closest('[data-finance-drill-row]');
      return row ? 'row:' + row.dataset.financeDrillRow : (e.tagName + '.' + e.className).slice(0, 60); })()`);
    const tabTo = async (selector: string, what: string) => {
      for (let n = 0; n < 60; n += 1) {
        if (await evaluate<boolean>(`!!document.activeElement && document.activeElement.matches(${JSON.stringify(selector)})`)) return;
        await key('Tab');
      }
      assert.fail(`Tab never reached ${what}`);
    };
    // Each window gives the focus back as it unmounts (a passive effect, a moment after it leaves the page): waited for, then held.
    const closeBoth = async (row: string, card: string, how: string) => {
      await key('Escape');
      await until(dialogs, (n) => n === 1, `${how}: the order closes, the drawer stays`);
      assert.equal(await until(focus, (f) => f === `row:${row}`, `${how}: the focus on the drawer's row`, 3_000).catch(() => focus()), `row:${row}`, `${how}: the order closed — the focus is on the row it was opened from`);
      await sleep(200);
      assert.equal(await focus(), `row:${row}`, `${how}: and stays there`);
      await key('Escape');
      await until(dialogs, (n) => n === 0, `${how}: the drawer closes`);
      assert.equal(await until(focus, (f) => f === `card:${card}`, `${how}: the focus on the card's button`, 3_000).catch(() => focus()), `card:${card}`, `${how}: the drawer closed — the focus is on the card's button`);
      await sleep(200);
      assert.equal(await focus(), `card:${card}`, `${how}: and stays there`);
    };
    const firstRow = () => evaluate<string>('document.querySelector(\'dialog[open] [data-finance-drill-row] button\')?.closest(\'[data-finance-drill-row]\')?.dataset.financeDrillRow ?? \'\'');
    await open();

    // By mouse: the figure of «صافي حصتك», then a row of the drawer.
    await press('[data-finance-kpi="netShare"] .fw-money');
    await until(dialogs, (n) => n === 1, 'the drawer, from a click on the figure');
    const row = await until(firstRow, Boolean, 'a row in the drawer');
    await press(`dialog[open] [data-finance-drill-row="${row}"] button`);
    await until(dialogs, (n) => n === 2, 'the order over the drawer');
    await closeBoth(row, 'netShare', 'by mouse');

    // By keyboard alone: Tab to the card's button, Enter; Tab to a row, Enter; Escape, Escape.
    await open();
    await tabTo('[data-finance-open="grossProfit"]', 'the «ربح البضاعة» card\'s button');
    await key('Enter');
    await until(dialogs, (n) => n === 1, 'the drawer, from Enter on the card\'s button');
    const keyRow = await until(firstRow, Boolean, 'a row in the drawer');
    await tabTo(`dialog[open] [data-finance-drill-row="${keyRow}"] button`, 'the drawer\'s first row');
    await key('Enter');
    await until(dialogs, (n) => n === 2, 'the order over the drawer, from Enter on its row');
    await closeBoth(keyRow, 'grossProfit', 'by keyboard');

    // A double click on a figure selects it: no drawer flashes open and shut, none stays open under the pointer, nothing opens under the second click.
    for (const card of ['netSales', 'netShare', 'deliveredOrders']) {
      await open();
      const figure = `[data-finance-kpi="${card}"] ${card === 'deliveredOrders' ? 'strong' : '.fw-money'}`;
      await press(figure, 2);
      await sleep(900);
      const after = await evaluate<{ shown: number; selection: string; page: string; figure: string; where: string }>(`(() => { const s = getSelection();
        return { shown: document.querySelectorAll('dialog[open]').length, selection: s.toString(), figure: document.querySelector(${JSON.stringify(figure)})?.textContent ?? '',
          where: (s.anchorNode?.parentElement?.tagName ?? '-') + ':' + s.anchorOffset + '..' + (s.focusNode?.parentElement?.tagName ?? '-') + ':' + s.focusOffset,
          page: [...document.querySelectorAll('[data-finance-page]')].find((e) => e.style.display !== 'none')?.dataset.financePage ?? '' }; })()`);
      assert.equal(after.shown, 0, `${card}: a double click opens no window`);
      assert.ok(after.selection.trim().length > 0 && after.figure.includes(after.selection.trim()), `${card}: it selects the figure «${after.figure}» (selected «${after.selection}», ${after.where})`);
      assert.equal(after.page, 'overview', `${card}: and stays on the overview`);
    }
    // A single click after it still opens the card.
    await press('[data-finance-kpi="netSales"] .fw-money');
    await until(dialogs, (n) => n === 1, 'one click on the figure still opens the drawer');

    // The fourth review: the owner who moves on within the card's wait — the dollar toggle, the Reports tab — gets no drawer: none over
    // the page he went to, and none by itself once the next read lands (the drawer used to open on the dollars, or over Reports).
    for (const [what, next] of [['the dollar toggle', '[data-finance-display-currency] button:last-child'], ['the Reports tab', '[data-finance-section="reports"]']] as const) {
      await open();
      const started = Date.now();
      await press('[data-finance-kpi="netSales"] .fw-money');
      await press(next);
      const took = Date.now() - started;
      assert.ok(took < CARD_WAIT_MS, `${what}: pressed ${took} ms after the card's click, inside its wait`);
      await sleep(900);
      assert.equal(await dialogs(), 0, `${what}, pressed inside the card's wait: no drawer opens, then or when the next read lands`);
    }
  } finally {
    socket?.close();
    if (browser.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
      else browser.kill('SIGKILL');
    }
    await server.close();
    // This run's own profile (made above, under the system's temp folder), once its engine is gone; a file still held is left to that folder's sweep.
    if (profile.startsWith(join(tmpdir(), 'levonis-focus-'))) try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left to the temp sweep */ }
  }
});
