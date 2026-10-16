/**
 * THE BROWSER CHECK (Bambu import spec §I.1.7).
 *
 * Playwright, Chromium headless, ONE browser per job, on the public site only:
 * every request to another host is aborted and counted, and a request to a
 * Bambu Lab host fails the check outright — the store is never opened in a
 * browser (§J.1: no headless browser on the store).
 *
 * `/product/<slug>` in Arabic (the default):
 *   - the main image — the hero frame's own picture, never a thumbnail —
 *     decodes (`naturalWidth > 0`) and keeps its ratio (`object-fit: contain`);
 *   - «السعر غير متوفر حالياً» is visible and «طلب السعر» present; there is no
 *     add-to-cart, buy-now or Quick Buy control and no 0 before a dinar unit;
 *   - the opening selection is the page's §G.3 rule (selection.ts): the
 *     defaults while they form a variant, else the first default alone, and
 *     every single-value group that fits;
 *   - for each colour, version or size value (≤ 12; all for the audit
 *     classes), in its group's fieldset (a swatch by its value id, a chip by
 *     its exact name): a value the selection does not offer must be disabled
 *     and show «غير متاح مع هذا الاختيار», and is never clicked; any other is
 *     chosen, and the WHOLE selection the page now holds (the other groups'
 *     choices kept, as the page keeps them) decides the expected gallery — the
 *     hero is one of the images that lead it, and no image the selection
 *     contradicts is in the gallery (R6). The gallery is the rows the Worker
 *     WROTE (gallery.ts: byte-identical images collapsed, §C.4 step 1);
 *   - the breadcrumb names the leaf section (a leaf the tree does not name
 *     fails it: nothing is not a match).
 * For a MERGE into an existing product the chooser, the price and the buying
 * controls are the existing product's own (§E.2): only the main image, the
 * dinar text, the breadcrumb and the store requests are checked.
 *
 * The checks read the page through `ProductPageDriver`, so they run in tests
 * against a model of the page; `BrowserChecker` drives the real one.
 * Screenshots (audit classes, 1 in 25, every failure) come back as buffers and
 * are sealed by the caller; nothing is written to disk in clear.
 */
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { mediaPath } from '@levonis/catalog/bambuImport/fingerprint';
import type { ImportPayload } from '@levonis/catalog/bambuImport/payload';
import type { MediaAnswerRow } from './opsClient';
import { expectedGallery, pageDefaultSelection, valueOffered, withValue } from './selection';

export const UNPRICED_AR = 'السعر غير متوفر حالياً';
export const REQUEST_AR = 'طلب السعر';
/** The page's «not offered with this choice» (src/lib/productChooser.ts NOT_OFFERED.ar). */
export const NOT_OFFERED_AR = 'غير متاح مع هذا الاختيار';
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
  locator(selector: string): PwLocator;
  getAttribute(name: string): Promise<string | null>;
  isDisabled(): Promise<boolean>;
  isVisible(): Promise<boolean>;
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
  /** The gallery as written (gallery.ts): what the page's images are expected from. */
  images: readonly ImportPayload['images'][number][];
  /** The Arabic name of the section the product is filed under ('' when the tree does not name it: a failure). */
  leafName: string;
  /** All values (audit classes) or at most 12. */
  allValues: boolean;
  screenshot: boolean;
}

export interface BrowserCounts {
  values_checked: number;
  values_failed: number;
  values_not_offered: number;
  blocked_requests: number;
  store_requests: number;
  page_errors: number;
}

export interface BrowserResult {
  ok: boolean;
  checks: Record<string, boolean>;
  counts: BrowserCounts;
  /** Every selection the page held when it was checked: the opening one, then the whole selection after each click. */
  selections: string[][];
  screenshots: Buffer[];
}

// ------------------------------------------------------------------ the page, as the checks read it

/** One value's control in its group: a swatch or a chip. */
export interface ChipDriver {
  pressed(): Promise<boolean>;
  /** Disabled natively (`disabled`) or by `aria-disabled="true"`. */
  disabled(): Promise<boolean>;
  /** The «غير متاح مع هذا الاختيار» helper is shown for it. */
  helper(): Promise<boolean>;
  click(): Promise<void>;
}

/** What the checks read from the product page, and the one thing they do to it (choose a value). */
export interface ProductPageDriver {
  /** The hero frame's own image (never a thumbnail): decoded width, object-fit, URL; w 0 when the frame shows none. */
  hero(): Promise<{ w: number; fit: string; src: string }>;
  text(): Promise<string>;
  requestCta(): Promise<boolean>;
  /** `value`'s control inside `group`'s fieldset; null when the page shows none. */
  chip(group: ImportPayload['groups'][number], value: ImportPayload['groups'][number]['values'][number]): Promise<ChipDriver | null>;
  /** The thumbnail strip's image URLs. */
  gallery(): Promise<string[]>;
  /** Lets a click render. */
  settle(): Promise<void>;
}

export interface PageCheckInput {
  payload: ImportPayload;
  media: ReadonlyMap<string, MediaAnswerRow>;
  /** The gallery as written (gallery.ts: after the Worker's content-duplicate collapse), never the payload's list. */
  images: readonly ImportPayload['images'][number][];
  leafName: string;
  allValues: boolean;
}

/** The §I.1.7 checks over a page (the real one through Playwright, or a model of it in tests). */
export async function inspectProductPage(
  page: ProductPageDriver,
  input: PageCheckInput
): Promise<{ checks: Record<string, boolean>; counts: Pick<BrowserCounts, 'values_checked' | 'values_failed' | 'values_not_offered'>; selections: string[][] }> {
  const { payload, media } = input;
  const merge = payload.write_mode === 'merge';
  const checks: Record<string, boolean> = {};
  const counts = { values_checked: 0, values_failed: 0, values_not_offered: 0 };
  const selections: string[][] = [];

  const hero = await page.hero();
  checks.image_decodes = hero.w > 0;
  checks.image_contain = hero.fit === 'contain';
  const text = await page.text();
  if (!merge) {
    // A merged product keeps its own price and buying controls (§E.2): these hold for an imported product only.
    checks.unpriced_label = text.includes(UNPRICED_AR);
    checks.request_door = text.includes(REQUEST_AR) || (await page.requestCta());
    checks.no_buying_control = !BUYING.test(text);
  }
  checks.no_zero_dinar = !ZERO_DINAR.test(text);
  checks.breadcrumb = !!input.leafName && text.includes(input.leafName);
  if (merge) return { checks, counts, selections };

  const { groups, variants } = payload;
  let selection = pageDefaultSelection(payload);
  let defaultsOk = true;
  for (const g of groups) {
    const want = g.values.find((v) => selection.includes(v.id));
    if (!want) continue;
    const chip = await page.chip(g, want);
    if (!chip || !(await chip.pressed())) defaultsOk = false;
  }
  checks.default_selection = defaultsOk;
  if (selection.length) selections.push([...selection]);

  let valuesOk = true;
  let helpersOk = true;
  let budget = input.allValues ? Infinity : 12;
  for (const g of groups) {
    if (!SELECTION_KINDS.has(g.kind) || g.values.length < 2) continue;
    for (const v of g.values) {
      if (budget-- <= 0) break;
      const chip = await page.chip(g, v);
      if (!chip) {
        valuesOk = false;
        counts.values_failed++;
        continue;
      }
      const offered = valueOffered(v.id, g.id, selection, groups, variants);
      if (await chip.disabled()) {
        // An impossible value with the current selection: disabled with its helper, never clicked (§G.3).
        counts.values_not_offered++;
        if (offered) {
          valuesOk = false;
          counts.values_failed++;
        } else if (!(await chip.helper())) helpersOk = false;
        continue;
      }
      if (!offered) {
        // The page offers a combination no variant has.
        valuesOk = false;
        counts.values_failed++;
        continue;
      }
      if (!(await chip.pressed())) {
        await chip.click();
        await page.settle();
      }
      selection = withValue(selection, groups, g.id, v.id);
      counts.values_checked++;
      const exp = expectedGallery({ groups, variants, images: input.images }, media, selection);
      const heroNow = mediaPath((await page.hero()).src);
      const gallery = (await page.gallery()).map((u) => mediaPath(u));
      const heroOk = exp.hero.size === 0 || exp.hero.has(heroNow);
      const clean = !gallery.some((u) => exp.forbidden.has(u)) && !exp.forbidden.has(heroNow);
      if (!heroOk || !clean) {
        valuesOk = false;
        counts.values_failed++;
      }
      selections.push([...selection]);
    }
  }
  checks.selection_images = valuesOk;
  checks.not_offered_helper = helpersOk;
  // Each as the page held it: a group with no value stays absent, so the Worker answers SELECTION_REQUIRED for an
  // incomplete one and checks a complete one's eligibility (§I.1.10).
  return { checks, counts, selections };
}

// ------------------------------------------------------------------ the real page

/** The live page through Playwright, with the storefront's markup (src/pages/Product.tsx). */
class PlaywrightProductPage implements ProductPageDriver {
  private heroReads = 0;

  constructor(private readonly page: PwPage) {}

  /** The gallery section's first box is the hero frame; the thumbnails are buttons in a strip after it. */
  private frame(): PwLocator {
    return this.page.locator('section[aria-label]').first().locator(':scope > div').first();
  }

  async hero(): Promise<{ w: number; fit: string; src: string }> {
    const img = this.frame().locator('img').first();
    // The first read waits for the page to draw its picture; after a click the frame re-renders at once.
    await img.waitFor({ state: 'attached', timeout: this.heroReads++ === 0 ? 15_000 : 3_000 }).catch(() => {});
    // No picture in the frame (it failed: the page shows its fallback) is a hero that does not decode.
    if ((await img.count()) === 0) return { w: 0, fit: '', src: '' };
    return img
      .evaluate(
        // Runs in the page: no named function inside (a bundler's name helper does not exist there).
        (el) =>
          new Promise<{ w: number; fit: string; src: string }>((resolve) => {
            // A picture still loading is given a moment; one that failed shows no <img> (the fallback) or w 0.
            const i = el as HTMLImageElement;
            if (i.complete) {
              resolve({ w: i.naturalWidth, fit: getComputedStyle(i).objectFit, src: i.currentSrc || i.src });
              return;
            }
            setTimeout(() => resolve({ w: i.naturalWidth, fit: getComputedStyle(i).objectFit, src: i.currentSrc || i.src }), 5000);
            i.addEventListener('load', () => resolve({ w: i.naturalWidth, fit: getComputedStyle(i).objectFit, src: i.currentSrc || i.src }), { once: true });
            i.addEventListener('error', () => resolve({ w: 0, fit: getComputedStyle(i).objectFit, src: i.currentSrc || i.src }), { once: true });
          })
      )
      .catch(() => ({ w: 0, fit: '', src: '' }));
  }

  text(): Promise<string> {
    return this.page.locator('body').innerText().catch(() => '');
  }

  async requestCta(): Promise<boolean> {
    return (await this.page.locator('[data-price-request-cta]').count()) > 0;
  }

  async chip(group: ImportPayload['groups'][number], value: ImportPayload['groups'][number]['values'][number]): Promise<ChipDriver | null> {
    // Scoped to the group's fieldset when the page names it: a value name repeated in another group never matches.
    const fieldset = this.page.locator(`fieldset[data-option-group="${cssValue(group.id)}"]`);
    const scoped = (await fieldset.count()) > 0;
    const root = scoped ? fieldset.first() : this.page.locator('body');
    // A colour SWATCH carries its value id and no text (its accessible name is the value's name).
    const swatch = root.locator(`button[data-swatch="${cssValue(value.id)}"]`).first();
    if ((await swatch.count()) > 0) return this.driver(swatch, root, true);
    for (const label of [value.name_ar, value.name_en]) {
      if (!label) continue;
      const chip = root.locator('button.lv-choice').filter({ has: this.page.getByText(label, { exact: true }) }).first();
      if ((await chip.count()) > 0) return this.driver(chip, root, false);
    }
    return null;
  }

  private driver(el: PwLocator, root: PwLocator, swatch: boolean): ChipDriver {
    return {
      pressed: async () => (await el.getAttribute('aria-pressed')) === 'true',
      disabled: async () => (await el.isDisabled().catch(() => false)) || (await el.getAttribute('aria-disabled')) === 'true',
      helper: async () => {
        if ((await el.locator('[data-not-offered]').count()) > 0) return true;
        if (!swatch) return (await el.innerText().catch(() => '')).includes(NOT_OFFERED_AR);
        const name = `${(await el.getAttribute('aria-label')) ?? ''} ${(await el.getAttribute('title')) ?? ''}`;
        return name.includes(NOT_OFFERED_AR) || (await root.locator('[data-not-offered-note]').count()) > 0;
      },
      click: async () => {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 5000 }).catch(() => {});
      },
    };
  }

  gallery(): Promise<string[]> {
    return this.page
      .locator('section[aria-label]')
      .first()
      .locator('button[aria-pressed] img')
      .evaluateAll((els) => els.map((e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src))
      .catch(() => [] as string[]);
  }

  settle(): Promise<void> {
    return this.page.waitForTimeout(400);
  }
}

/** A value inside a CSS attribute selector's double quotes. */
const cssValue = (v: string) => v.replace(/["\\]/g, (c) => `\\${c}`);

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
    const counts: BrowserCounts = { values_checked: 0, values_failed: 0, values_not_offered: 0, blocked_requests: 0, store_requests: 0, page_errors: 0 };
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
      const r = await inspectProductPage(new PlaywrightProductPage(page), input);
      Object.assign(counts, r.counts);
      const checks = { ...r.checks, never_the_store: counts.store_requests === 0 };
      const ok = Object.values(checks).every(Boolean);
      if (input.screenshot || !ok) screenshots.push(await page.screenshot({ fullPage: false }).catch(() => Buffer.alloc(0)));
      return { ok, checks, counts, selections: r.selections, screenshots: screenshots.filter((b) => b.length > 0) };
    } finally {
      await ctx.close().catch(() => {});
    }
  }
}
