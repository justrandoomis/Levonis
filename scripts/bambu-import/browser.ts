/**
 * THE BROWSER CHECK (Bambu import spec §I.1.7, §G.2, §G.3, §1 row 27).
 *
 * Playwright, Chromium headless, ONE browser per job, on the public site only:
 * every request to another host is aborted and counted, and a request to a
 * Bambu Lab host fails the check outright — the store is never opened in a
 * browser (§J.1: no headless browser on the store).
 *
 * `/product/<slug>` in Arabic (the default), read through the hooks the page
 * renders (src/pages/Product.tsx, src/components/product/*):
 *   - the main image — the picture in the hero frame (`[data-gallery-hero]`),
 *     never a thumbnail — decodes (`naturalWidth > 0`) and keeps its ratio
 *     (`object-fit: contain`);
 *   - the request door (`[data-price-request-cta]`) is there, «السعر غير متوفر
 *     حالياً» is visible; there is no add-to-cart, buy-now or Quick Buy control
 *     and no 0 before a dinar unit;
 *   - the opening selection is the page's §G.3 rule, read from what the option
 *     groups show pressed (`fieldset[data-option-group]`, each control's
 *     `data-option-value`);
 *   - for each colour, version or size value (≤ 12; all for the audit
 *     classes), in its group's fieldset: a value the selection does not offer
 *     is marked so (`data-offered="false"`, dimmed) with «غير متاح مع هذا
 *     الاختيار» (a chip's own line; a swatch's accessible name and its group's
 *     note), and a value it offers is not; NO value is disabled (a dead end,
 *     §1 row 27). Each value is then pressed — an unoffered one too: the page
 *     takes it and lets go of the other groups' clashing values, a group left
 *     with one fitting value taking it (`chooseValue`) — and the WHOLE
 *     selection the page then holds must be the one that rule gives; it decides
 *     the expected gallery: the hero is one of the images that lead it, and no
 *     image the selection contradicts is in the gallery (R6). The gallery is the
 *     rows the Worker WROTE (gallery.ts: byte-identical images collapsed, §C.4
 *     step 1);
 *   - the knowledge tabs (`[data-knowledge]`, near the viewport) are the tabs
 *     the page's own `knowledgeTabs` gives the expected answer for the
 *     selection on screen, and every US 110 V row sits under «إصدارات أخرى»
 *     (`details[data-knowledge-other]`, L-20) in every tab;
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
import { productVariantIdForSelection } from '@levonis/pricing/productSelectionMedia';
import { knowledgeTabs, type KnowledgeAnswer } from '../../src/lib/productKnowledge';
import type { MediaAnswerRow } from './opsClient';
import { expectedGallery, pageDefaultSelection, pressValue, valueOffered } from './selection';

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
  nth(index: number): PwLocator;
  locator(selector: string): PwLocator;
  getAttribute(name: string): Promise<string | null>;
  isDisabled(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  click(opts?: { timeout?: number }): Promise<void>;
  innerText(): Promise<string>;
  evaluate<T>(fn: (el: Element) => T): Promise<T>;
  evaluateAll<T>(fn: (els: Element[]) => T): Promise<T>;
  scrollIntoViewIfNeeded(opts?: { timeout?: number }): Promise<void>;
  filter(opts: { has?: PwLocator; hasText?: string | RegExp }): PwLocator;
  waitFor(opts?: { state?: string; timeout?: number }): Promise<void>;
}
interface PwPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  locator(selector: string): PwLocator;
  getByText(text: string, opts?: { exact?: boolean }): PwLocator;
  evaluate<T>(fn: () => T): Promise<T>;
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
  /**
   * The knowledge answer VERIFY expects (verify.ts `expectedKnowledge`, the route's own assembly): the tabs the page
   * must draw for it. Null when not known (a merge: the existing product's page).
   */
  knowledge: KnowledgeAnswer | null;
  screenshot: boolean;
}

export interface BrowserCounts {
  values_checked: number;
  values_failed: number;
  values_not_offered: number;
  /** The knowledge tabs (or phone sections) the page drew. */
  knowledge_tabs: number;
  /** US 110 V rows the knowledge tabs drew (each under «إصدارات أخرى» or a failure). */
  us_110v_notes: number;
  blocked_requests: number;
  store_requests: number;
  page_errors: number;
}

export interface BrowserResult {
  ok: boolean;
  checks: Record<string, boolean>;
  counts: BrowserCounts;
  /** Every selection the page held when it was checked: the opening one, then the whole selection after each press. */
  selections: string[][];
  screenshots: Buffer[];
}

// ------------------------------------------------------------------ the page, as the checks read it

/** One value's control in its group: a swatch or a chip. */
export interface ChipDriver {
  pressed(): Promise<boolean>;
  /** The page marks it not offered with the current choice (`data-offered="false"`: dimmed, still pressable). */
  notOffered(): Promise<boolean>;
  /** Disabled natively (`disabled`) or by `aria-disabled="true"`: a dead end the page never draws for a value. */
  disabled(): Promise<boolean>;
  /** «غير متاح مع هذا الاختيار» is said for it: a chip's own line; a swatch's accessible name and its group's note. */
  helper(): Promise<boolean>;
  click(): Promise<void>;
}

/** What the knowledge tabs drew, near the viewport. */
export interface KnowledgeView {
  /** `[data-knowledge]` came (it takes no room until it has something to show). */
  shown: boolean;
  /** The tabs (desktop) or sections (phone) by id, in the page's order. */
  tabs: string[];
  /** US 110 V rows across every tab, and those outside «إصدارات أخرى». */
  usNotes: number;
  usOutside: number;
}

/** What the checks read from the product page, and the one thing they do to it (press a value). */
export interface ProductPageDriver {
  /** The hero frame's own image (never a thumbnail): decoded width, object-fit, URL; w 0 when the frame shows none. */
  hero(): Promise<{ w: number; fit: string; src: string }>;
  text(): Promise<string>;
  requestCta(): Promise<boolean>;
  /** `value`'s control inside `group`'s fieldset; null when the page shows none. */
  chip(group: ImportPayload['groups'][number], value: ImportPayload['groups'][number]['values'][number]): Promise<ChipDriver | null>;
  /** The values the option groups show pressed (any order). */
  pressedValues(groups: ImportPayload['groups']): Promise<string[]>;
  /** The thumbnail strip's image URLs. */
  gallery(): Promise<string[]>;
  /** Brings the knowledge tabs near the viewport and reads every tab. */
  knowledge(): Promise<KnowledgeView>;
  /** Lets a press render. */
  settle(): Promise<void>;
}

export interface PageCheckInput {
  payload: ImportPayload;
  media: ReadonlyMap<string, MediaAnswerRow>;
  /** The gallery as written (gallery.ts: after the Worker's content-duplicate collapse), never the payload's list. */
  images: readonly ImportPayload['images'][number][];
  leafName: string;
  allValues: boolean;
  /** The expected knowledge answer; null skips the tabs check (unknown). */
  knowledge?: KnowledgeAnswer | null;
}

type PageCounts = Pick<BrowserCounts, 'values_checked' | 'values_failed' | 'values_not_offered' | 'knowledge_tabs' | 'us_110v_notes'>;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

/** Ids in the groups' order (a selection as the evidence records it). */
function inGroupOrder(ids: readonly string[], groups: ImportPayload['groups']): string[] {
  const at = new Map(groups.flatMap((g, gi) => g.values.map((v) => [v.id, gi] as const)));
  return [...new Set(ids)].filter((id) => at.has(id)).sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0));
}

/** The §I.1.7 checks over a page (the real one through Playwright, or a model of it in tests). */
export async function inspectProductPage(page: ProductPageDriver, input: PageCheckInput): Promise<{ checks: Record<string, boolean>; counts: PageCounts; selections: string[][] }> {
  const { payload, media } = input;
  const merge = payload.write_mode === 'merge';
  const checks: Record<string, boolean> = {};
  const counts: PageCounts = { values_checked: 0, values_failed: 0, values_not_offered: 0, knowledge_tabs: 0, us_110v_notes: 0 };
  const selections: string[][] = [];

  const hero = await page.hero();
  checks.image_decodes = hero.w > 0;
  checks.image_contain = hero.fit === 'contain';
  // The request door first: its panel is a lazy chunk, and the text is read once it has drawn.
  const cta = merge ? false : await page.requestCta();
  const text = await page.text();
  if (!merge) {
    // A merged product keeps its own price and buying controls (§E.2): these hold for an imported product only.
    checks.unpriced_label = text.includes(UNPRICED_AR);
    checks.request_door = cta;
    checks.no_buying_control = !BUYING.test(text);
  }
  checks.no_zero_dinar = !ZERO_DINAR.test(text);
  checks.breadcrumb = !!input.leafName && text.includes(input.leafName);
  if (merge) return { checks, counts, selections };

  const { groups, variants } = payload;
  const opening = pageDefaultSelection(payload);
  let selection = inGroupOrder(await page.pressedValues(groups), groups);
  checks.default_selection = sameSet(selection, opening);
  if (selection.length) selections.push([...selection]);

  let imagesOk = true;
  let heldOk = true;
  let marksOk = true;
  let helpersOk = true;
  let noDeadEnd = true;
  let budget = input.allValues ? Infinity : 12;
  for (const g of groups) {
    if (!SELECTION_KINDS.has(g.kind) || g.values.length < 2) continue;
    for (const v of g.values) {
      if (budget-- <= 0) break;
      const chip = await page.chip(g, v);
      if (!chip) {
        imagesOk = false;
        counts.values_failed++;
        continue;
      }
      let failed = false;
      if (await chip.disabled()) {
        // A value the page will not take: the dead end §1 row 27 removed. Nothing to press.
        noDeadEnd = false;
        counts.values_failed++;
        continue;
      }
      const offered = valueOffered(v.id, g.id, selection, groups, variants);
      if ((await chip.notOffered()) === offered) {
        // The page marks it otherwise than its own rule says for the selection it holds.
        marksOk = false;
        failed = true;
      }
      if (!offered) {
        counts.values_not_offered++;
        if (!(await chip.helper())) {
          helpersOk = false;
          failed = true;
        }
      }
      // Pressing the chosen value would let it go: it is judged as it stands.
      const want = (await chip.pressed()) ? selection : pressValue(selection, groups, variants, g.id, v.id);
      if (want !== selection) {
        await chip.click();
        await page.settle();
      }
      const held = inGroupOrder(await page.pressedValues(groups), groups);
      if (!sameSet(held, want)) {
        heldOk = false;
        failed = true;
      }
      // From here on the page is judged by the selection it HOLDS (its gallery follows that one).
      selection = held;
      counts.values_checked++;
      const exp = expectedGallery({ groups, variants, images: input.images }, media, selection);
      const heroNow = mediaPath((await page.hero()).src);
      const gallery = (await page.gallery()).map((u) => mediaPath(u));
      const heroOk = exp.hero.size === 0 || exp.hero.has(heroNow);
      const clean = !gallery.some((u) => exp.forbidden.has(u)) && !exp.forbidden.has(heroNow);
      if (!heroOk || !clean) {
        imagesOk = false;
        failed = true;
      }
      if (failed) counts.values_failed++;
      selections.push([...selection]);
    }
  }
  checks.selection_images = imagesOk;
  checks.selection_held = heldOk;
  checks.not_offered_marks = marksOk;
  checks.not_offered_helper = helpersOk;
  checks.no_dead_end = noDeadEnd;

  // The knowledge tabs follow the selection on screen, else the opening one (Product.tsx knowledgeSelection).
  if (input.knowledge) {
    const ids = selection.length ? selection : opening;
    const expected = knowledgeTabs(input.knowledge, { optionValueIds: ids, variantId: productVariantIdForSelection(variants, { optionValueIds: ids }) }).order;
    const k = await page.knowledge();
    counts.knowledge_tabs = k.tabs.length;
    counts.us_110v_notes = k.usNotes;
    checks.knowledge_tabs = expected.length === 0 ? k.tabs.length === 0 : k.shown && k.tabs.join(',') === expected.join(',');
    checks.us_110v_other_versions = k.usOutside === 0;
  }
  // Each as the page held it: a group with no value stays absent, so the Worker answers SELECTION_REQUIRED for an
  // incomplete one and checks a complete one's eligibility (§I.1.10).
  return { checks, counts, selections };
}

// ------------------------------------------------------------------ the real page

/** The live page through Playwright, with the storefront's markup (src/pages/Product.tsx). */
class PlaywrightProductPage implements ProductPageDriver {
  private heroReads = 0;

  constructor(private readonly page: PwPage) {}

  /**
   * The VISIBLE copy of a hooked element. The page draws its buy column twice — a phone copy (`lg:hidden`) first
   * in the document, then the desktop one (Product.tsx `selectionBlocks`) — so `.first()` alone can be the hidden
   * copy, which no click reaches. The visible copy first, then any.
   */
  private async visible(selector: string): Promise<PwLocator | null> {
    for (const s of [`${selector}:visible`, selector]) {
      const hit = this.page.locator(s);
      if ((await hit.count()) > 0) return hit.first();
    }
    return null;
  }

  /** The hero frame (`[data-gallery-hero]`); a page without the hook: the gallery section's first box. */
  private async frame(): Promise<PwLocator> {
    const hooked = await this.visible('[data-gallery-hero]');
    if (hooked) return hooked;
    return this.page.locator('section[aria-label]').first().locator(':scope > div').first();
  }

  async hero(): Promise<{ w: number; fit: string; src: string }> {
    // The first read waits for the page to draw its frame and picture; after a press the frame re-renders at once.
    const first = this.heroReads++ === 0;
    if (first) await this.page.locator('[data-gallery-hero], section[aria-label]').first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
    const img = (await this.frame()).locator('img').first();
    await img.waitFor({ state: 'attached', timeout: first ? 15_000 : 3_000 }).catch(() => {});
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
    // PriceRequestPanel is a lazy chunk: give it the moment it takes to arrive.
    const cta = this.page.locator('[data-price-request-cta]');
    await cta.first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
    return (await cta.count()) > 0;
  }

  /** The group's fieldset (`fieldset[data-option-group]`, its visible copy), or the body on a page that does not name it. */
  private async groupRoot(groupId: string): Promise<PwLocator> {
    return (await this.visible(`fieldset[data-option-group="${cssValue(groupId)}"]`)) ?? this.page.locator('body');
  }

  async chip(group: ImportPayload['groups'][number], value: ImportPayload['groups'][number]['values'][number]): Promise<ChipDriver | null> {
    // Scoped to the group's fieldset: a value name repeated in another group never matches.
    const root = await this.groupRoot(group.id);
    // Every chooser control carries its value id (`data-option-value`); a colour SWATCH also `data-swatch`.
    for (const selector of [`button[data-option-value="${cssValue(value.id)}"]`, `button[data-swatch="${cssValue(value.id)}"]`]) {
      const hit = root.locator(selector).first();
      if ((await hit.count()) > 0) return this.driver(hit, root);
    }
    // A page without the hooks: a chip by its exact name.
    for (const label of [value.name_ar, value.name_en]) {
      if (!label) continue;
      const chip = root.locator('button.lv-choice').filter({ has: this.page.getByText(label, { exact: true }) }).first();
      if ((await chip.count()) > 0) return this.driver(chip, root);
    }
    return null;
  }

  private driver(el: PwLocator, root: PwLocator): ChipDriver {
    return {
      pressed: async () => (await el.getAttribute('aria-pressed')) === 'true',
      notOffered: async () => (await el.getAttribute('data-offered')) === 'false',
      disabled: async () => (await el.isDisabled().catch(() => false)) || (await el.getAttribute('aria-disabled')) === 'true',
      helper: async () => {
        if ((await el.getAttribute('data-swatch')) === null) {
          // A chip says it on its own line.
          const line = el.locator('[data-not-offered]');
          return (await line.count()) > 0 && (await line.first().innerText().catch(() => '')).includes(NOT_OFFERED_AR);
        }
        // A swatch has no text: its accessible name says it, and so does its group's note under the swatches.
        const name = `${(await el.getAttribute('aria-label')) ?? ''}`;
        const note = root.locator('[data-not-offered-note]');
        return name.includes(NOT_OFFERED_AR) && (await note.count()) > 0 && (await note.first().innerText().catch(() => '')).includes(NOT_OFFERED_AR);
      },
      click: async () => {
        await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await el.click({ timeout: 5000 }).catch(() => {});
      },
    };
  }

  async pressedValues(groups: ImportPayload['groups']): Promise<string[]> {
    const ids = await this.page
      .evaluate(() =>
        Array.from(document.querySelectorAll('fieldset[data-option-group] button[aria-pressed="true"]'))
          // The visible copy only (the hidden phone copy holds the same selection, but it is not what a reader sees).
          .filter((b) => b.getClientRects().length > 0)
          .map((b) => b.getAttribute('data-option-value') || b.getAttribute('data-swatch') || '')
      )
      .catch(() => [] as string[]);
    if (!ids.includes('')) return ids;
    // A pressed control without its id (a page without the hook): ask each value's own control.
    const out: string[] = [];
    for (const g of groups) {
      for (const v of g.values) {
        const c = await this.chip(g, v);
        if (c && (await c.pressed())) out.push(v.id);
      }
    }
    return out;
  }

  async gallery(): Promise<string[]> {
    const strip = await this.visible('[data-gallery-strip]');
    const thumbs = strip ? strip.locator('img') : this.page.locator('section[aria-label]').first().locator('button[aria-pressed] img');
    return thumbs.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src)).catch(() => [] as string[]);
  }

  async knowledge(): Promise<KnowledgeView> {
    // The tabs load when their slot nears the viewport (IntersectionObserver, 400 px): bring it there.
    await this.page.evaluate(() => document.querySelector('[data-product-knowledge]')?.scrollIntoView({ block: 'center' })).catch(() => {});
    await this.page.locator('[data-knowledge]').first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
    if ((await this.page.locator('[data-knowledge]').count()) === 0) return { shown: false, tabs: [], usNotes: 0, usOutside: 0 };
    const read = () =>
      this.page
        .evaluate(() => {
          const us = Array.from(document.querySelectorAll('[data-knowledge] [data-knowledge-note="us_110v"]'));
          return { us: us.length, outside: us.filter((n) => !n.closest('details[data-knowledge-other]')).length };
        })
        .catch(() => ({ us: 0, outside: 0 }));
    const tabs = this.page.locator('[data-knowledge="tabs"] [role="tab"]');
    const n = await tabs.count();
    if (n === 0) {
      // The phone's sections: one accordion per tab, read as drawn.
      const ids = await this.page
        .locator('[data-knowledge="sections"] [data-section]')
        .evaluateAll((els) => els.map((e) => (e.getAttribute('data-section') ?? '').replace(/^knowledge-/, '')))
        .catch(() => [] as string[]);
      const r = await read();
      return { shown: true, tabs: ids, usNotes: r.us, usOutside: r.outside };
    }
    // Only the open tab's panel is mounted: open each one and read it.
    const ids: string[] = [];
    let usNotes = 0;
    let usOutside = 0;
    for (let i = 0; i < n; i++) {
      const tab = tabs.nth(i);
      ids.push((await tab.getAttribute('data-tab')) ?? '');
      await tab.click({ timeout: 5000 }).catch(() => {});
      await this.page.waitForTimeout(250);
      const r = await read();
      usNotes += r.us;
      usOutside += r.outside;
    }
    return { shown: true, tabs: ids, usNotes, usOutside };
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
    const counts: BrowserCounts = { values_checked: 0, values_failed: 0, values_not_offered: 0, knowledge_tabs: 0, us_110v_notes: 0, blocked_requests: 0, store_requests: 0, page_errors: 0 };
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

