/**
 * THE BROWSER CHECK (Bambu import spec §I.1.7).
 *
 * Playwright, Chromium headless, ONE browser per job, on the public site only:
 * every request to another host is aborted and counted, and a request to a
 * Bambu Lab host fails the check outright — the store is never opened in a
 * browser (§J.1: no headless browser on the store).
 *
 * `/product/<slug>` in Arabic (the default):
 *   - the main image decodes (`naturalWidth > 0`) and keeps its ratio
 *     (`object-fit: contain`);
 *   - «السعر غير متوفر حالياً» is visible and «طلب السعر» present; there is no
 *     add-to-cart, buy-now or Quick Buy control and no 0 before a dinar unit;
 *   - the default selection is applied;
 *   - for each colour, version or size value (≤ 12; all for the audit
 *     classes): it is chosen, the hero is an image bound to it (or a general
 *     one when it has none of its own), and no image bound only to another
 *     value of the same group is in the gallery;
 *   - the breadcrumb names the leaf section.
 * Screenshots (audit classes, 1 in 25, every failure) come back as buffers and
 * are sealed by the caller; nothing is written to disk in clear.
 */
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { mediaPath } from '@levonis/catalog/bambuImport/fingerprint';
import type { ImportPayload } from '@levonis/catalog/bambuImport/payload';
import type { MediaAnswerRow } from './opsClient';

export const UNPRICED_AR = 'السعر غير متوفر حالياً';
export const REQUEST_AR = 'طلب السعر';
const BUYING = /أضف إلى السلة|اشترِ الآن|اشتر الآن|شراء سريع|سجّل الدخول للشراء/;
const ZERO_DINAR = /(^|[^0-9٠-٩.,])[0٠]\s*(?:د\.ع|دينار|IQD)/;
const STORE_HOSTS = /(^|\.)bambulab\.com$|(^|\.)bblcdn\.com$|(^|\.)shopify\.com$/i;
const SELECTION_KINDS = new Set(['color', 'version', 'size', 'nozzle', 'plate', 'spool', 'pack', 'printer']);

/** The sandbox's Chromium (a symlink to the real binary) when present; on the runner, Playwright's own. */
export function chromiumPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CHROMIUM_PATH) return env.CHROMIUM_PATH;
  for (const candidate of ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium']) {
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return undefined;
}

export function playwrightModule(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.js';
}

/* The minimal Playwright surface used here (the module is loaded at run time, untyped). */
interface PwRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
}
interface PwLocator {
  count(): Promise<number>;
  first(): PwLocator;
  nth(i: number): PwLocator;
  getAttribute(name: string): Promise<string | null>;
  click(opts?: { timeout?: number }): Promise<void>;
  innerText(): Promise<string>;
  evaluate<T>(fn: (el: Element) => T): Promise<T>;
  evaluateAll<T>(fn: (els: Element[]) => T): Promise<T>;
  scrollIntoViewIfNeeded(): Promise<void>;
  filter(opts: { has?: PwLocator; hasText?: string | RegExp }): PwLocator;
  waitFor(opts?: { state?: string; timeout?: number }): Promise<void>;
}
interface PwPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  locator(selector: string): PwLocator;
  getByText(text: string, opts?: { exact?: boolean }): PwLocator;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>;
  on(event: string, fn: (arg: unknown) => void): void;
}
interface PwContext {
  route(pattern: string, fn: (route: PwRoute) => unknown): Promise<void>;
  addInitScript(fn: (lang: string) => void, arg: string): Promise<void>;
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}

export interface BrowserInput {
  slug: string;
  payload: ImportPayload;
  media: ReadonlyMap<string, MediaAnswerRow>;
  leafName: string;
  /** All values (audit classes) or at most 12. */
  allValues: boolean;
  screenshot: boolean;
}

export interface BrowserResult {
  ok: boolean;
  checks: Record<string, boolean>;
  counts: { values_checked: number; values_failed: number; blocked_requests: number; store_requests: number; page_errors: number };
  selections: string[][];
  screenshots: Buffer[];
}

/** The expected hero set and the forbidden gallery URLs when `valueId` is chosen (§C.4, §G.3, R6). */
export function selectionExpectations(payload: ImportPayload, media: ReadonlyMap<string, MediaAnswerRow>, groupId: string, valueId: string) {
  const urlOf = (id: string) => {
    const m = media.get(id);
    return m && m.status === 'stored' && m.r2_key ? `/files/${m.r2_key}` : '';
  };
  const group = payload.groups.find((g) => g.id === groupId);
  const siblings = new Set((group?.values ?? []).map((v) => v.id).filter((id) => id !== valueId));
  const variantsWith = new Set(payload.variants.filter((v) => v.value_ids.includes(valueId)).map((v) => v.id));
  const variantsWithout = new Set(payload.variants.filter((v) => v.value_ids.some((x) => siblings.has(x))).map((v) => v.id));
  const own = new Set<string>();
  const general = new Set<string>();
  const others = new Set<string>();
  for (const i of payload.images) {
    const url = urlOf(i.source_media_id);
    if (!url) continue;
    if (i.option_value_id === valueId || (i.variant_id && variantsWith.has(i.variant_id))) own.add(url);
    else if (!i.option_value_id && !i.variant_id) general.add(url);
    else if ((i.option_value_id && siblings.has(i.option_value_id)) || (i.variant_id && variantsWithout.has(i.variant_id))) others.add(url);
  }
  const forbidden = [...others].filter((u) => !own.has(u) && !general.has(u));
  return { hero: own.size ? own : general, forbidden: new Set(forbidden) };
}

export class BrowserChecker {
  private constructor(
    private readonly browser: PwBrowser,
    private readonly siteOrigin: string
  ) {}

  static async launch(siteOrigin: string, env: NodeJS.ProcessEnv = process.env): Promise<BrowserChecker> {
    const req = createRequire(import.meta.url);
    const pw = req(playwrightModule(env)) as { chromium: { launch(opts: Record<string, unknown>): Promise<PwBrowser> } };
    const executablePath = chromiumPath(env);
    const browser = await pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
    return new BrowserChecker(browser, siteOrigin.replace(/\/+$/, ''));
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => {});
  }

  async check(input: BrowserInput): Promise<BrowserResult> {
    const siteHost = new URL(this.siteOrigin).host;
    const counts = { values_checked: 0, values_failed: 0, blocked_requests: 0, store_requests: 0, page_errors: 0 };
    const checks: Record<string, boolean> = {};
    const selections: string[][] = [];
    const screenshots: Buffer[] = [];
    const ctx = await this.browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ar-IQ', serviceWorkers: 'block' });
    try {
      await ctx.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
        let host = '';
        try {
          host = new URL(url).host;
        } catch {
          host = '';
        }
        if (host === siteHost) return route.continue();
        counts.blocked_requests++;
        if (STORE_HOSTS.test(host.replace(/:\d+$/, ''))) counts.store_requests++;
        return route.abort('blockedbyclient');
      });
      await ctx.addInitScript((lang: string) => {
        try {
          localStorage.setItem('levo_lang', lang);
        } catch {
          /* storage blocked */
        }
      }, 'ar');
      const page = await ctx.newPage();
      page.on('pageerror', () => {
        counts.page_errors++;
      });
      await page.goto(`${this.siteOrigin}/product/${encodeURIComponent(input.slug)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(1500);

      const hero = page.locator('section[aria-label] img').first();
      await hero.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
      const heroFacts = await hero
        .evaluate((el) => {
          const img = el as HTMLImageElement;
          return { w: img.naturalWidth, fit: getComputedStyle(img).objectFit, src: img.currentSrc || img.src };
        })
        .catch(() => ({ w: 0, fit: '', src: '' }));
      checks.image_decodes = heroFacts.w > 0;
      checks.image_contain = heroFacts.fit === 'contain';

      const text = await page.locator('body').innerText().catch(() => '');
      checks.unpriced_label = text.includes(UNPRICED_AR);
      checks.request_door = text.includes(REQUEST_AR) || (await page.locator('[data-price-request-cta]').count()) > 0;
      checks.no_buying_control = !BUYING.test(text);
      checks.no_zero_dinar = !ZERO_DINAR.test(text);
      checks.breadcrumb = input.leafName ? text.includes(input.leafName) : true;

      const chipOf = (name: string) => page.locator('button.lv-choice').filter({ has: page.getByText(name, { exact: true }) }).first();
      const findChip = async (v: { name_ar: string; name_en: string }) => {
        for (const label of [v.name_ar, v.name_en]) {
          if (!label) continue;
          const chip = chipOf(label);
          if ((await chip.count()) > 0) return chip;
        }
        return null;
      };
      let defaultsOk = true;
      const defaults: string[] = [];
      for (const g of input.payload.groups) {
        const v = g.values.find((x) => x.id === g.default_value_id);
        if (!v) continue;
        defaults.push(v.id);
        const chip = await findChip(v);
        if (!chip || (await chip.getAttribute('aria-pressed')) !== 'true') defaultsOk = false;
      }
      checks.default_selection = defaultsOk;
      if (defaults.length) selections.push(defaults);

      const galleryUrls = async () =>
        page
          .locator('section[aria-label] button[aria-pressed] img')
          .evaluateAll((els) => els.map((e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src))
          .catch(() => [] as string[]);
      let valuesOk = true;
      let budget = input.allValues ? Infinity : 12;
      for (const g of input.payload.groups) {
        if (!SELECTION_KINDS.has(g.kind) || g.values.length < 2) continue;
        for (const v of g.values) {
          if (budget-- <= 0) break;
          const chip = await findChip(v);
          if (!chip) {
            valuesOk = false;
            counts.values_failed++;
            continue;
          }
          await chip.scrollIntoViewIfNeeded().catch(() => {});
          if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(400);
          counts.values_checked++;
          if ((await chip.getAttribute('aria-disabled')) === 'true') continue; // an impossible value: the page shows its helper
          const exp = selectionExpectations(input.payload, input.media, g.id, v.id);
          const heroNow = await page
            .locator('section[aria-label] img')
            .first()
            .evaluate((el) => (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src)
            .catch(() => '');
          const gallery = (await galleryUrls()).map((u) => mediaPath(u));
          const heroOk = exp.hero.size === 0 || exp.hero.has(mediaPath(heroNow));
          const clean = !gallery.some((u) => exp.forbidden.has(u)) && !exp.forbidden.has(mediaPath(heroNow));
          if (!heroOk || !clean) {
            valuesOk = false;
            counts.values_failed++;
          }
          selections.push([v.id]);
        }
      }
      checks.selection_images = valuesOk;
      checks.never_the_store = counts.store_requests === 0;
      const ok = Object.values(checks).every(Boolean);
      if (input.screenshot || !ok) screenshots.push(await page.screenshot({ fullPage: false }).catch(() => Buffer.alloc(0)));
      return { ok, checks, counts, selections, screenshots: screenshots.filter((b) => b.length > 0) };
    } finally {
      await ctx.close().catch(() => {});
    }
  }
}
