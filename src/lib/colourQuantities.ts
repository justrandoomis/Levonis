/**
 * COLOUR QUANTITIES — THE RULES AND THE WORDS (docs/ux/COLOUR-QUANTITIES.md).
 *
 * A customer who meant «50 black, 5 white, 1 beige» tapped three single-select
 * colour chips, kept one quantity box at 56, and ordered «beige × 56». Nothing
 * on the page said the chips were single-select, the quantity followed the
 * colour change without a word, and the button read «أضف إلى السلة» whatever
 * it was about to add. This module holds what the page needs to make that
 * mistake impossible, in the product page's OPENING chunk (single mode needs
 * it): pure functions and three languages, no React, no request.
 *
 *   · `addLabel` / `addedLabel` / `noticeText` — the button and the
 *     confirmation NAME what is added: «أضف 50 × Black», «أضف 56 قطعة (3 ألوان)».
 *   · `qtyAfterColourChange` — a quantity typed for one colour is never sent
 *     with another without the customer seeing it happen (D4).
 *   · `rowCeilings`, `prefillRows`, `leaveMulti` — the several-colours mode.
 *
 * COLOUR NAMES ARE ENGLISH IN EVERY LANGUAGE (the product-form mandate §7), so
 * every name that leaves JSX is wrapped in FSI…PDI (`isolate`): «أضف 50 ×
 * Jade White (10100)» would otherwise move its closing parenthesis to the far
 * side of the name. Counts are Latin digits through `groupedNumber`, the same
 * digits the stepper the customer typed in shows.
 */
import { LINE_QTY_MAX } from '../../packages/pricing/src/quantity';
import { groupedNumber } from './localeNumber';

export type ColourLang = 'ar' | 'en' | 'ckb';

const FSI = '⁨';
const PDI = '⁩';

/** A colour name isolated for any plain-text context (an aria-label, a toast, a live region). */
export const isolate = (name: string): string => `${FSI}${name}${PDI}`;

/**
 * A name short enough for the button's one line: a trailing «(code)» goes
 * first («Jade White (10100)» → «Jade White»), then an ellipsis. Never empty
 * for a non-empty name. The accessible name always carries the full name.
 */
export function shortColourName(name: string, max = 18): string {
  const full = String(name ?? '').trim();
  if (Array.from(full).length <= max) return full;
  const bare = full.replace(/\s*\([^()]*\)\s*$/, '').trim() || full;
  const chars = Array.from(bare);
  if (chars.length <= max) return bare;
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

const n = (v: number) => groupedNumber(v);

/** The Arabic counted noun as the object of «أضف» (§8.2). */
export function piecesAcc(count: number): string {
  if (count === 1) return 'قطعة واحدة';
  if (count === 2) return 'قطعتين';
  if (count >= 3 && count <= 10) return `${n(count)} قطع`;
  return `${n(count)} قطعة`;
}

/** The Arabic counted noun for colours, inside the parentheses (§8.2). */
export function coloursNom(count: number): string {
  if (count === 1) return 'لون واحد';
  if (count === 2) return 'لونان';
  if (count >= 3 && count <= 10) return `${n(count)} ألوان`;
  if (count >= 11 && count <= 99) return `${n(count)} لونًا`;
  return `${n(count)} لون`;
}

/** One colour line of an add. */
export interface ColourLine {
  name: string;
  qty: number;
}

/**
 * WHAT THE BUTTON ADDS. One line names the colour and the count; several
 * lines name the pieces and the colours. Never the bare «أضف إلى السلة» once
 * a colour is involved. `short` shortens the name for the visible label only.
 */
export function addLabel(lang: ColourLang, lines: readonly ColourLine[], opts: { short?: boolean } = {}): string {
  const live = lines.filter((l) => l.qty > 0);
  if (live.length === 0) return COLOUR_STRINGS[lang].addNone;
  if (live.length === 1) {
    const name = isolate(opts.short ? shortColourName(live[0].name) : live[0].name);
    const q = n(live[0].qty);
    return lang === 'en' ? `Add ${q} × ${name}` : lang === 'ckb' ? `زیادکردنی ${q} × ${name}` : `أضف ${q} × ${name}`;
  }
  const pieces = live.reduce((sum, l) => sum + l.qty, 0);
  const k = live.length;
  if (lang === 'en') return `Add ${n(pieces)} ${pieces === 1 ? 'piece' : 'pieces'} (${n(k)} colours)`;
  if (lang === 'ckb') return `زیادکردنی ${n(pieces)} پارچە (${n(k)} ڕەنگ)`;
  return `أضف ${piecesAcc(pieces)} (${coloursNom(k)})`;
}

/** The button for three seconds after an add, built from what WAS added. */
export function addedLabel(lang: ColourLang, line: ColourLine, opts: { short?: boolean } = {}): string {
  const name = isolate(opts.short ? shortColourName(line.name) : line.name);
  const q = n(line.qty);
  return lang === 'en' ? `Added ${q} × ${name}` : lang === 'ckb' ? `زیادکرا ${q} × ${name}` : `أُضيف ${q} × ${name}`;
}

/**
 * The confirmation banner after a single-colour add. `capped` is the merge the
 * door held to the most available (the cart now holds `after`, not before +
 * qty): the customer is told the number they now hold, never a silent cap.
 */
export function noticeText(lang: ColourLang, line: ColourLine, capped?: { after: number } | null): string {
  const name = isolate(line.name);
  if (capped) {
    const m = n(capped.after);
    return lang === 'en'
      ? `Your cart now holds ${m} × ${name} — the most available`
      : lang === 'ckb'
        ? `ئێستا ${m} × ${name} لە سەبەتەکەتدایە — زۆرترینی بەردەست`
        : `في سلتك الآن ${m} × ${name} — أقصى ما يتوفر`;
  }
  const q = n(line.qty);
  return lang === 'en'
    ? `Added to your cart: ${q} × ${name}`
    : lang === 'ckb'
      ? `زیادکرا بۆ سەبەتەکەت: ${q} × ${name}`
      : `أُضيف إلى السلة: ${q} × ${name}`;
}

/**
 * D4 — A QUANTITY BELONGS TO ONE COLOUR.
 *
 * Changing from one colour to ANOTHER while the quantity is above 1 returns it
 * to 1, and the hint remembers what it was for, so «حدّد كمية لكل لون» can
 * carry «Black: 50» into the per-colour list and «أبقِ 50 لـ White» can put it
 * back. From no colour to a colour the quantity was typed for that colour and
 * is kept; from a colour to none it is kept too (the button then asks for a
 * colour). At 1 nothing changes and nothing is said.
 */
export function qtyAfterColourChange(input: { from: string; to: string; qty: number }): {
  qty: number;
  hint: null | { kind: 'reset'; previous: { colour: string; qty: number }; to: string };
} {
  const { from, to, qty } = input;
  if (!from || !to || from === to || qty <= 1) return { qty, hint: null };
  return { qty: 1, hint: { kind: 'reset', previous: { colour: from, qty }, to } };
}

/** One row of the several-colours list, as the ceiling rule reads it. */
export interface RowCounter {
  id: string;
  qty: number;
  /** This colour's own ceiling (its shelf or the quote's `max_qty`); null = untracked. */
  max: number | null;
}

/**
 * EACH ROW'S CEILING (§3.5). A counter per colour: the row's own number. A
 * counter SHARED by the colours (`pool`, the shelf of the product or of the
 * option, or a tracked pre-order quota): what the pool leaves after the other
 * rows. Never above the per-line ceiling, never below 0.
 */
export function rowCeilings(rows: readonly RowCounter[], shared: { pool: number } | null = null): Map<string, number> {
  const out = new Map<string, number>();
  const cap = (v: number) => Math.max(0, Math.min(LINE_QTY_MAX, Math.trunc(v)));
  if (shared) {
    const total = rows.reduce((sum, r) => sum + Math.max(0, r.qty), 0);
    for (const r of rows) out.set(r.id, cap(shared.pool - (total - Math.max(0, r.qty))));
    return out;
  }
  for (const r of rows) out.set(r.id, r.max === null ? LINE_QTY_MAX : cap(r.max));
  return out;
}

/**
 * ENTERING THE SEVERAL-COLOURS MODE (§3.2). Rows remembered from an earlier
 * visit on this view come back; the single mode's colour brings the quantity
 * that was typed FOR IT, but only onto a row that is still at 0. Nothing else
 * is inherited.
 */
export function prefillRows(
  remembered: Readonly<Record<string, number>>,
  single: { colour: string; qty: number } | null
): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const [id, qty] of Object.entries(remembered)) if (qty > 0) rows[id] = qty;
  if (single && single.colour && single.qty > 0 && !(rows[single.colour] > 0)) rows[single.colour] = single.qty;
  return rows;
}

/**
 * LEAVING IT (§3.2). Exactly one row with a quantity: the single mode takes
 * that colour and that quantity. Otherwise the single mode keeps its own last
 * colour at 1 and the rows wait in memory — nothing is lost by switching, and
 * nothing moves to a colour the customer did not choose.
 */
export function leaveMulti(
  rows: Readonly<Record<string, number>>,
  singleColour: string
): { colour: string; qty: number; remembered: Record<string, number> } {
  const live = Object.entries(rows).filter(([, q]) => q > 0);
  if (live.length === 1) return { colour: live[0][0], qty: live[0][1], remembered: {} };
  return { colour: singleColour, qty: 1, remembered: Object.fromEntries(live) };
}

/** The fields of a cart line the identity reads (structurally a `CartItem`). */
export interface CartLineIdentity {
  productId: string;
  option_id: string;
  option_value_ids?: string[];
  color_id: string;
  qty: number;
  kind?: string;
}

/**
 * How many of EXACTLY this selection the cart lines hold — the identity the
 * server upserts a line on (the product, the full selection sorted, the
 * colour), falling back to the legacy `option_id` for a line written before
 * the column. A gift line is never the customer's own add.
 */
export function lineQtyIn(lines: readonly CartLineIdentity[], productId: string, ids: readonly string[], legacy: string, colour: string): number {
  const key = (v: readonly string[] | undefined, old: string) => (v && v.length ? [...v].sort().join(',') : old) || '';
  const mine = key(ids, legacy);
  return lines.reduce((sum, line) => {
    if (line.productId !== productId || line.kind === 'gift') return sum;
    if (key(line.option_value_ids, line.option_id) !== mine) return sum;
    if ((line.color_id || '') !== (colour || '')) return sum;
    return sum + (Number(line.qty) || 0);
  }, 0);
}

/** The rows with a quantity, as [id, qty] in the given order. */
export const liveRows = (order: readonly string[], rows: Readonly<Record<string, number>>): Array<[string, number]> =>
  order.filter((id) => (rows[id] ?? 0) > 0).map((id) => [id, rows[id]]);

/**
 * WHAT A MERGE ENDS AT — the server's own arithmetic (worker/lib/cartAdd.ts
 * `ceiling`, the upsert's `MIN(ceiling, qty + excluded.qty)`): the line holds
 * `before + want`, held to `max(want, min(LINE_QTY_MAX, maxQty))`. A capped
 * merge ends at the shelf, never at «before + the shelf».
 */
export function expectedAfterMerge(before: number, want: number, maxQty: number | null): number {
  const shelf = maxQty === null || !Number.isFinite(maxQty) ? LINE_QTY_MAX : Math.min(LINE_QTY_MAX, Math.max(0, Math.trunc(maxQty)));
  return Math.min(Math.max(0, before) + want, Math.max(want, shelf));
}

/** One line of an add whose answer was lost, re-read from the cart. */
export interface LostAnswerLine {
  id: string;
  /** What the page believed the line held when it pressed. */
  before: number;
  want: number;
  /** What the cart holds now. */
  after: number;
  /** The selection's `max_qty` from its quote; null = untracked. */
  maxQty: number | null;
  /** The press was «empty the cart and add»: every line started from 0. */
  replaced?: boolean;
}

/**
 * DID THE PRESS WHOSE ANSWER WAS LOST LAND? (§3.7) A line landed when the
 * cart now holds exactly what that press would have left. The page opens the
 * confirmation for the lines that landed and never says «nothing was added»
 * about them; a line that does not match is named as missing, never claimed.
 */
export function lostAnswerVerdict(lines: readonly LostAnswerLine[]): { landed: string[]; missing: string[] } {
  const landed: string[] = [];
  const missing: string[] = [];
  for (const l of lines) {
    const from = l.replaced ? 0 : l.before;
    (l.after > 0 && l.after === expectedAfterMerge(from, l.want, l.maxQty) ? landed : missing).push(l.id);
  }
  return { landed, missing };
}

/**
 * AN OPTION LEFT FEWER THAN TWO COLOURS THAT CAN TAKE A QUANTITY (§3.2, §3.4):
 * «عدة ألوان» closes the way its switch does. Rows whose colour is no longer
 * offered are removed and named; exactly one row left becomes the single
 * selection with ITS quantity; otherwise the single mode takes `held` (the
 * colour the page keeps in hand, an offered one) — or the colour held before
 * the mode, when it is still offered — at 1. The quantity the single mode had
 * before «عدة ألوان» never comes back on its own.
 */
export function closeMultiForOption(
  rows: Readonly<Record<string, number>>,
  offered: ReadonlySet<string>,
  before: string,
  held: string
): { colour: string; qty: number; dropped: string[]; remembered: Record<string, number> } {
  const kept: Record<string, number> = {};
  const dropped: string[] = [];
  for (const [id, q] of Object.entries(rows)) {
    if (!(q > 0)) continue;
    if (offered.has(id)) kept[id] = q;
    else dropped.push(id);
  }
  const back = leaveMulti(kept, offered.has(before) ? before : held);
  return { colour: back.colour, qty: back.qty, dropped, remembered: back.remembered };
}

/**
 * WHAT THE CART ALREADY HOLDS ON A SHELF THE COLOURS SHARE: the shelf's
 * `max_qty` does not count the cart, so the rows' pool is the shelf less this.
 * A product or base shelf is drawn on by every line of the product; an option
 * shelf by the lines with the same options. A per-colour counter shares nothing.
 */
export function heldOnSharedCounter(lines: readonly CartLineIdentity[], productId: string, scope: string, sharedIds: readonly string[]): number {
  if (scope !== 'product' && scope !== 'base' && scope !== 'option') return 0;
  return lines.reduce((sum, line) => {
    if (line.productId !== productId || line.kind === 'gift') return sum;
    if (scope === 'option') {
      const ids = line.option_value_ids && line.option_value_ids.length ? line.option_value_ids : line.option_id ? [line.option_id] : [];
      if (!sharedIds.every((id) => ids.includes(id))) return sum;
    }
    return sum + (Number(line.qty) || 0);
  }, 0);
}

/** What the single buy button says, before it is put into words. */
export type BuyLabelKind = 'signIn' | 'adding' | 'added' | 'addedColour' | 'chooseColour' | 'unavailable' | 'addColour' | 'addToCart';

/**
 * THE SINGLE BUY BUTTON (D3). «اختر لونًا أولًا» is said only when THIS
 * selection has a colour to choose — a model that is intentionally colourless
 * keeps «أضف إلى السلة» — and it comes before «غير متوفر»: a colour-stock
 * filament with no colour chosen is «unavailable» only because no colour is.
 */
export function buyLabelKind(input: {
  signedIn: boolean;
  adding: boolean;
  /** The 3 s after an add, while the selection and the quantity are still what was added. */
  justAdded: boolean;
  lastAdded: ColourLine | null;
  unavailable: boolean;
  /** The CURRENT selection offers colours (not the product as a whole). */
  colourToChoose: boolean;
  chosen: ColourLine | null;
}): BuyLabelKind {
  if (!input.signedIn) return 'signIn';
  if (input.adding) return 'adding';
  if (input.justAdded) return input.lastAdded ? 'addedColour' : 'added';
  if (input.chosen) return input.unavailable ? 'unavailable' : 'addColour';
  if (input.colourToChoose) return 'chooseColour';
  return input.unavailable ? 'unavailable' : 'addToCart';
}

/**
 * The selection a press would send, as one comparable string. «أُضيف 50 ×
 * Black» stays on the button only while this is still what was added: a
 * colour tap or a new quantity is a different press, and the button names it.
 */
export function pressKey(sel: { colour: string; optionValueIds: readonly string[]; qty: number; orderType: string; route: string; warranty: string }): string {
  return JSON.stringify([sel.colour || '', [...sel.optionValueIds].sort(), sel.qty, sel.orderType || '', sel.route || '', sel.warranty || '']);
}

/**
 * QUANTITIES TYPED FOR COLOURS THE CUSTOMER MOVED AWAY FROM (D4), for this
 * view: «Black 50», then «Cold White 5». «حدّد كمية لكل لون» and the switch
 * carry all of them into the rows, so the first colour is not lost at the
 * third. Tapping back to a colour makes its number the stepper's again.
 */
export function rememberAfterTap(memory: Readonly<Record<string, number>>, tap: { from: string; to: string; qty: number }): Record<string, number> {
  const next = { ...memory };
  if (qtyAfterColourChange(tap).hint) next[tap.from] = tap.qty;
  if (tap.to) delete next[tap.to];
  return next;
}

/**
 * D6's window: the colours seen in the last 30 s, the colour the tap left
 * included — the colour the page opened on is a colour the customer saw
 * chosen, so two taps away from it are three colours.
 */
export function tapWindow(
  taps: ReadonlyArray<{ id: string; at: number }>,
  from: string,
  to: string,
  now: number,
  windowMs = 30_000
): { taps: Array<{ id: string; at: number }>; distinct: string[] } {
  const next = taps.filter((t) => now - t.at <= windowMs);
  if (from && !next.some((t) => t.id === from)) next.push({ id: from, at: now });
  if (to) next.push({ id: to, at: now });
  return { taps: next, distinct: [...new Set(next.map((t) => t.id))] };
}

/** «56 × Beige»: a count and an isolated name, the same in every language. */
export const countTimesName = (line: ColourLine, opts: { short?: boolean } = {}): string =>
  `${n(line.qty)} × ${isolate(opts.short ? shortColourName(line.name) : line.name)}`;

/** ⚡ NAMES WHAT IT BUYS (principle 2): «شراء سريع: 56 × Beige». */
export function quickBuyLabel(lang: ColourLang, line: ColourLine, opts: { short?: boolean } = {}): string {
  const what = countTimesName(line, opts);
  return lang === 'en' ? `Quick Buy: ${what}` : lang === 'ckb' ? `کڕینی خێرا: ${what}` : `شراء سريع: ${what}`;
}

/**
 * THE SEVERAL-COLOURS BUTTON. A guest reads the page's own «سجّل الدخول
 * للشراء», as in single mode: the press goes to sign-in, and a label that
 * promised an add would hide that. With no row filled it is `aria-disabled`,
 * not `disabled`, so the focus can come back to it when the confirmation
 * closes (§3.8); the press then does nothing.
 */
export function multiAddButton(input: {
  lang: ColourLang;
  signedIn: boolean;
  signInLabel: string;
  busy: boolean;
  gateOpen: boolean;
  lines: readonly ColourLine[];
}): { label: string; ariaLabel?: string; disabled: boolean; ariaDisabled: boolean } {
  const live = input.lines.filter((l) => l.qty > 0);
  if (!input.signedIn) {
    return {
      label: input.signInLabel,
      ariaLabel: live.length > 0 ? `${input.signInLabel} — ${addLabel(input.lang, live)}` : input.signInLabel,
      disabled: input.busy,
      ariaDisabled: false,
    };
  }
  const label = addLabel(input.lang, live, { short: true });
  if (live.length === 0) return { label, disabled: input.busy, ariaDisabled: !input.busy };
  return { label, ariaLabel: addLabel(input.lang, live), disabled: input.busy || !input.gateOpen, ariaDisabled: false };
}

/**
 * A CART OR CHECKOUT GROUP'S HEADER COUNTS COLOURS, NOT LINES: Black on a
 * spool and Black as a refill are one colour in two lines. A group with no
 * colour at all (option lines of a colourless product) names its pieces only.
 */
export function groupSummaryText(lang: ColourLang, lines: ReadonlyArray<{ colourId: string; qty: number }>): string {
  const words = COLOUR_STRINGS[lang];
  const pieces = lines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
  const colours = new Set(lines.map((l) => l.colourId).filter(Boolean)).size;
  return colours === 0 ? words.groupPieces(pieces) : words.groupSummary(colours, pieces);
}

// --------------------------------------------------------------------- words

type Fn1 = (a: string) => string;

export interface ColourStrings {
  colourModeLabel: string;
  colourModeOne: string;
  colourModeMany: string;
  perColourLegend: string;
  perColourIntro: string;
  rowQty: Fn1;
  rowIncrease: Fn1;
  rowDecrease: Fn1;
  rowSoldOutZero: string;
  showAllColours: Fn1;
  clearQuantities: string;
  quantitiesCleared: string;
  undo: string;
  totalLine: (pieces: number, colours: number) => string;
  totalCaption: string;
  sharedStock: Fn1;
  sharedQuota: Fn1;
  optionChangedKept: Fn1;
  rowsDropped: Fn1;
  quickBuyOneColour: string;
  addNone: string;
  chooseColourFirst: string;
  resetHint: string;
  keepQty: (qty: string, name: string) => string;
  perColourAction: string;
  discoveryHint: string;
  bigQtyTip: string;
  dismissOk: string;
  galleryChosenColour: Fn1;
  galleryNoColourPhoto: string;
  priceWithColour: string;
  batchRefusedTop: string;
  reloadPage: string;
  addedSheetTitle: string;
  addedLineCapped: Fn1;
  addedTotal: Fn1;
  keepShopping: string;
  viewCart: string;
  colourA11y: Fn1;
  groupSummary: (colours: number, pieces: number) => string;
  groupPieces: (pieces: number) => string;
  groupSelect: Fn1;
  announceTotal: (pieces: number, colours: number, money: string) => string;
  announceModeOn: string;
  announceModeOff: string;
  inCart: Fn1;
  genericFailure: string;
  /** «عدة ألوان» closed because the option left fewer than two colours; `names` = the removed ones ('' for none). */
  multiClosed: Fn1;
  /** A lost answer: some colours landed, some did not. */
  partlyAdded: string;
  /** A grouped cart line's delete and checkbox name the colour. */
  lineDelete: Fn1;
  lineSelect: (product: string, colour: string) => string;
  /** The confirmation sheet's line name: «Black، 50» / "Black, 50". */
  sheetLine: (name: string, count: string) => string;
  /** The Quick Buy toast names what was bought. */
  quickBuyAdded: Fn1;
}

/**
 * Every string of docs/ux/COLOUR-QUANTITIES.md §8, in Arabic, English and
 * Sorani. The Sorani is its own (DECISIONS row 183), reusing the app's words:
 * «ڕەنگ», «بڕ», «پارچە», «سەبەتە», «زیادکرا بۆ سەبەتەکەت», «پشکی پێشداواکاری»,
 * «بهێڵەرەوە», «پاککردنەوە», «پاشگەزبوونەوە».
 */
export const COLOUR_STRINGS: Record<ColourLang, ColourStrings> = {
  ar: {
    colourModeLabel: 'طريقة اختيار الألوان',
    colourModeOne: 'لون واحد',
    colourModeMany: 'عدة ألوان',
    perColourLegend: 'الكمية لكل لون',
    perColourIntro: 'اضغط + على كل لون تريده، ثم أضفها كلها بضغطة واحدة.',
    rowQty: (name) => `كمية ${name}`,
    rowIncrease: (name) => `زيادة ${name}`,
    rowDecrease: (name) => `إنقاص ${name}`,
    rowSoldOutZero: 'نفد — لن يُضاف',
    showAllColours: (k) => `عرض كل الألوان (${k})`,
    clearQuantities: 'تصفير الكميات',
    quantitiesCleared: 'صُفّرت الكميات',
    undo: 'تراجع',
    totalLine: (p, k) => `مجموع القطع: ${n(p)} — الألوان: ${n(k)}`,
    totalCaption: 'الإجمالي',
    sharedStock: (m) => `المخزون مشترك بين الألوان: ${m} متوفر لها كلها معًا`,
    sharedQuota: (m) => `حصة الطلب المسبق مشتركة بين الألوان: بقي ${m}`,
    optionChangedKept: (name) => `تغيّر الخيار إلى ${name} — الكميات كما هي، راجعها قبل الإضافة.`,
    rowsDropped: (k) => `أُزيلت ألوان لا تتوفر مع هذا الخيار: ${k}`,
    quickBuyOneColour: 'الشراء السريع يأخذ لونًا واحدًا — عدة ألوان تُضاف إلى السلة.',
    addNone: 'حدّد كمية لون واحد على الأقل',
    chooseColourFirst: 'اختر لونًا أولًا',
    resetHint: 'غيّرت اللون، فرجعت الكمية إلى 1 — كل كمية تخص لونًا واحدًا.',
    keepQty: (q, name) => `أبقِ ${q} لـ ${name}`,
    perColourAction: 'حدّد كمية لكل لون',
    discoveryHint: 'يُختار لون واحد في كل مرة. تريد عدة ألوان؟',
    bigQtyTip: 'لعدة ألوان: حدّد كمية لكل لون',
    dismissOk: 'حسنًا',
    galleryChosenColour: (name) => `اللون المختار: ${name}`,
    galleryNoColourPhoto: 'الصورة لا تُظهر هذا اللون',
    priceWithColour: 'السعر ·',
    batchRefusedTop: 'لم يُضَف شيء. صحّح اللون المعلَّم ثم اضغط مرة أخرى.',
    reloadPage: 'حدّث الصفحة',
    addedSheetTitle: 'أُضيف إلى سلتك',
    addedLineCapped: (m) => `صار في السلة ${m} — أقصى ما يتوفر لهذا اللون`,
    addedTotal: (p) => `مجموع القطع المضافة: ${p}`,
    keepShopping: 'متابعة التسوق',
    viewCart: 'عرض السلة',
    colourA11y: (name) => `اللون: ${name}`,
    groupSummary: (k, p) => `الألوان: ${n(k)} · القطع: ${n(p)}`,
    groupPieces: (p) => `القطع: ${n(p)}`,
    groupSelect: (product) => `تحديد كل ألوان ${product}`,
    announceTotal: (p, k, money) => `مجموع القطع ${n(p)}، الألوان ${n(k)}، الإجمالي ${money}`,
    announceModeOn: 'عدة ألوان: حدّد الكمية لكل لون',
    announceModeOff: 'لون واحد',
    inCart: (m) => `في السلة: ${m}`,
    genericFailure: 'تعذّرت الإضافة الآن. لم يُضَف شيء.',
    multiClosed: (names) =>
      `لا تتوفر عدة ألوان مع هذا الخيار، فعادت الصفحة إلى لون واحد.${names ? ` أُزيلت: ${names}` : ''}`,
    partlyAdded: 'أُضيف بعض الألوان فقط. راجع سلتك قبل أن تضغط مرة أخرى.',
    lineDelete: (name) => `حذف ${name}`,
    lineSelect: (product, colour) => `${product} — اللون: ${colour}`,
    sheetLine: (name, count) => `${name}، ${count}`,
    quickBuyAdded: (what) => `أُضيف إلى طلب الشراء السريع: ${what}\u00a0⚡`,
  },
  en: {
    colourModeLabel: 'How to pick colours',
    colourModeOne: 'One colour',
    colourModeMany: 'Several colours',
    perColourLegend: 'Quantity per colour',
    perColourIntro: 'Tap + on each colour you want, then add them all with one tap.',
    rowQty: (name) => `Quantity of ${name}`,
    rowIncrease: (name) => `Increase ${name}`,
    rowDecrease: (name) => `Decrease ${name}`,
    rowSoldOutZero: 'Sold out — will not be added',
    showAllColours: (k) => `Show all colours (${k})`,
    clearQuantities: 'Clear quantities',
    quantitiesCleared: 'Quantities cleared',
    undo: 'Undo',
    totalLine: (p, k) => `${n(p)} ${p === 1 ? 'piece' : 'pieces'} in ${n(k)} ${k === 1 ? 'colour' : 'colours'}`,
    totalCaption: 'Total',
    sharedStock: (m) => `Stock is shared by the colours: ${m} available for all of them together`,
    sharedQuota: (m) => `The pre-order quota is shared by the colours: ${m} left`,
    optionChangedKept: (name) => `The option is now ${name} — the quantities stayed; check them before adding.`,
    rowsDropped: (k) => `Colours not offered with this option were removed: ${k}`,
    quickBuyOneColour: 'Quick Buy takes one colour — several colours go to the cart.',
    addNone: 'Set a quantity for at least one colour',
    chooseColourFirst: 'Choose a colour first',
    resetHint: 'You changed the colour, so the quantity went back to 1 — each quantity belongs to one colour.',
    keepQty: (q, name) => `Keep ${q} for ${name}`,
    perColourAction: 'Set a quantity per colour',
    discoveryHint: 'One colour is chosen at a time. Want several colours?',
    bigQtyTip: 'For several colours: set a quantity per colour',
    dismissOk: 'OK',
    galleryChosenColour: (name) => `Chosen colour: ${name}`,
    galleryNoColourPhoto: 'The photo does not show this colour',
    priceWithColour: 'Price ·',
    batchRefusedTop: 'Nothing was added. Fix the marked colour, then tap again.',
    reloadPage: 'Reload the page',
    addedSheetTitle: 'Added to your cart',
    addedLineCapped: (m) => `Your cart now holds ${m} — the most available for this colour`,
    addedTotal: (p) => `Pieces added: ${p}`,
    keepShopping: 'Keep shopping',
    viewCart: 'View cart',
    colourA11y: (name) => `Colour: ${name}`,
    groupSummary: (k, p) => `${n(k)} ${k === 1 ? 'colour' : 'colours'} · ${n(p)} ${p === 1 ? 'piece' : 'pieces'}`,
    groupPieces: (p) => `${n(p)} ${p === 1 ? 'piece' : 'pieces'}`,
    groupSelect: (product) => `Select every colour of ${product}`,
    announceTotal: (p, k, money) => `${n(p)} ${p === 1 ? 'piece' : 'pieces'} in ${n(k)} ${k === 1 ? 'colour' : 'colours'}, total ${money}`,
    announceModeOn: 'Several colours: set a quantity for each',
    announceModeOff: 'One colour',
    inCart: (m) => `In your cart: ${m}`,
    genericFailure: 'The add could not be completed right now. Nothing was added.',
    multiClosed: (names) =>
      `Several colours are not offered with this option, so the page is back to one colour.${names ? ` Removed: ${names}` : ''}`,
    partlyAdded: 'Only some colours were added. Check your cart before you tap again.',
    lineDelete: (name) => `Delete ${name}`,
    lineSelect: (product, colour) => `${product} — Colour: ${colour}`,
    sheetLine: (name, count) => `${name}, ${count}`,
    quickBuyAdded: (what) => `Added to your Quick Buy order: ${what}\u00a0⚡`,
  },
  ckb: {
    colourModeLabel: 'شێوازی هەڵبژاردنی ڕەنگەکان',
    colourModeOne: 'یەک ڕەنگ',
    colourModeMany: 'چەند ڕەنگێک',
    perColourLegend: 'بڕی هەر ڕەنگێک',
    perColourIntro: 'کرتە لە + ی هەر ڕەنگێک بکە کە دەتەوێت، پاشان هەموویان بە یەک کرتە زیاد بکە.',
    rowQty: (name) => `بڕی ${name}`,
    rowIncrease: (name) => `زیادکردنی بڕی ${name}`,
    rowDecrease: (name) => `کەمکردنەوەی بڕی ${name}`,
    rowSoldOutZero: 'نەماوە — زیاد ناکرێت',
    showAllColours: (k) => `هەموو ڕەنگەکان پیشان بدە (${k})`,
    clearQuantities: 'پاککردنەوەی بڕەکان',
    quantitiesCleared: 'بڕەکان پاک کرانەوە',
    undo: 'پاشگەزبوونەوە',
    totalLine: (p, k) => `کۆی پارچەکان: ${n(p)} — ڕەنگەکان: ${n(k)}`,
    totalCaption: 'کۆی گشتی',
    sharedStock: (m) => `کۆگا لە نێوان ڕەنگەکاندا هاوبەشە: ${m} بەردەستە بۆ هەموویان پێکەوە`,
    sharedQuota: (m) => `پشکی پێشداواکاری لە نێوان ڕەنگەکاندا هاوبەشە: ${m} ماوە`,
    optionChangedKept: (name) => `هەڵبژاردەکە بوو بە ${name} — بڕەکان وەک خۆیان ماونەتەوە؛ پێش زیادکردن بیانپشکنە.`,
    rowsDropped: (k) => `ئەو ڕەنگانەی لەگەڵ ئەم هەڵبژاردەیە نین لابران: ${k}`,
    quickBuyOneColour: 'کڕینی خێرا تەنها یەک ڕەنگ وەردەگرێت — چەند ڕەنگێک بۆ سەبەتە زیاد دەکرێن.',
    addNone: 'بڕی لانیکەم یەک ڕەنگ دیاری بکە',
    chooseColourFirst: 'سەرەتا ڕەنگێک هەڵبژێرە',
    resetHint: 'ڕەنگەکەت گۆڕی، بۆیە بڕەکە گەڕایەوە بۆ 1 — هەر بڕێک تەنها بۆ یەک ڕەنگە.',
    keepQty: (q, name) => `${q} بۆ ${name} بهێڵەرەوە`,
    perColourAction: 'بڕی هەر ڕەنگێک دیاری بکە',
    discoveryHint: 'لە هەر جارێکدا یەک ڕەنگ هەڵدەبژێردرێت. چەند ڕەنگێکت دەوێت؟',
    bigQtyTip: 'بۆ چەند ڕەنگێک: بڕی هەر ڕەنگێک دیاری بکە',
    dismissOk: 'باشە',
    galleryChosenColour: (name) => `ڕەنگی هەڵبژێردراو: ${name}`,
    galleryNoColourPhoto: 'وێنەکە ئەم ڕەنگە پیشان نادات',
    priceWithColour: 'نرخ ·',
    batchRefusedTop: 'هیچ شتێک زیاد نەکرا. ڕەنگە نیشانکراوەکە ڕاست بکەرەوە، پاشان دووبارە کرتە بکە.',
    reloadPage: 'پەڕەکە نوێ بکەرەوە',
    addedSheetTitle: 'زیادکرا بۆ سەبەتەکەت',
    addedLineCapped: (m) => `ئێستا ${m} لە سەبەتەکەتدایە — زۆرترینی بەردەست بۆ ئەم ڕەنگە`,
    addedTotal: (p) => `کۆی پارچە زیادکراوەکان: ${p}`,
    keepShopping: 'بەردەوامبە لە بازاڕکردن',
    viewCart: 'بینینی سەبەتە',
    colourA11y: (name) => `ڕەنگ: ${name}`,
    groupSummary: (k, p) => `${n(k)} ڕەنگ · ${n(p)} پارچە`,
    groupPieces: (p) => `${n(p)} پارچە`,
    groupSelect: (product) => `هەموو ڕەنگەکانی ${product} دیاری بکە`,
    announceTotal: (p, k, money) => `کۆی پارچەکان ${n(p)}، ڕەنگەکان ${n(k)}، کۆی گشتی ${money}`,
    announceModeOn: 'چەند ڕەنگێک: بڕی هەر ڕەنگێک دیاری بکە',
    announceModeOff: 'یەک ڕەنگ',
    inCart: (m) => `لە سەبەتەکەتدا: ${m}`,
    genericFailure: 'زیادکردن ئێستا تەواو نەبوو. هیچ شتێک زیاد نەکرا.',
    multiClosed: (names) =>
      `چەند ڕەنگێک لەگەڵ ئەم هەڵبژاردەیە پێشکەش ناکرێت، بۆیە پەڕەکە گەڕایەوە بۆ یەک ڕەنگ.${names ? ` لابران: ${names}` : ''}`,
    partlyAdded: 'تەنها هەندێک لە ڕەنگەکان زیادکران. پێش ئەوەی دووبارە کرتە بکەیت سەبەتەکەت بپشکنە.',
    lineDelete: (name) => `سڕینەوەی ${name}`,
    lineSelect: (product, colour) => `${product} — ڕەنگ: ${colour}`,
    sheetLine: (name, count) => `${name}، ${count} پارچە`,
    quickBuyAdded: (what) => `زیادکرا بۆ داواکاری کڕینی خێرا: ${what}\u00a0⚡`,
  },
};

/** The strings for a page language (Arabic unless English or Sorani). */
export const colourStrings = (lang: string): ColourStrings => COLOUR_STRINGS[lang === 'en' || lang === 'ckb' ? lang : 'ar'];
export const colourLang = (lang: string): ColourLang => (lang === 'en' || lang === 'ckb' ? lang : 'ar');
