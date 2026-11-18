/**
 * «خصص طابعتك» phase 4 (0242; DECISIONS row 355) — the sheet's offers: the
 * colour of each filament the customer picks in a kit, the owner's discounted
 * add-ons (nozzles, build plates…) and the store bundles linked to the printer.
 *
 * Imported ONLY by CustomizeSheet, so it rides the sheet's lazy chunk. Every
 * figure is the server's (GET /api/products/:slug/kits → {kits, addons,
 * store_bundles}): before, after, the saving and its percent are read, never
 * computed here. The customer's picks travel as `extras.kitColors` /
 * `extras.addonIds` (ids only — the server re-prices at every door). A colour
 * swatch is an inline style (no stylesheet of its own: the public CSS budget),
 * and no icon is imported here (an icon shared by two lazy chunks moves into
 * the product page's opening).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import VariantImg from '../ui/VariantImg';
import { moveRadioFocus, tabStop, type KitsFor, type PricedKit, type SelectionExtras } from './printerServicesModel';
import { OFFER_STRINGS, type OfferLang, type OfferStrings } from './printerOfferStrings';

type Text3 = { ar: string; en: string; ckb: string };

/** The phase-4 extras beside phase 2's: colours per kit or add-on product, the chosen add-ons. */
export interface OfferExtras extends SelectionExtras {
  /** productId → colourId | 'random' (absent = random). Only the customer-colour products. */
  kitColors?: Record<string, string> | null;
  /** The chosen add-ons (null / absent = none). */
  addonIds?: string[] | null;
  /** addonId → colourId | 'random' for a customer-colour add-on (absent = random). */
  addonColors?: Record<string, string> | null;
}

export const RANDOM = 'random';

/** One in-stock colour the customer may pick (the server's candidates). */
export interface OfferColour { id: string; name: string; hex: string; unit_iqd: number | null; available: boolean }

/** What an item lets the customer pick: its colours, and whether «لون عشوائي» can be served. */
/**
 * `key` is what the pick is stored and sent under: the PRODUCT id for a kit item
 * (`extras.kitColors`), the ADD-ON id for an add-on (`extras.addonColors`).
 */
export interface ColourChoice { key: string; product_id: string; name: string; color_mode: 'fixed' | 'customer'; colors: OfferColour[]; random_available: boolean }

/** Before / after / saving, as the server sent them (per printer and for the quantity). */
export interface OfferMoney { before_per: number | null; after_per: number | null; before_total: number | null; after_total: number | null; saving_total: number; saving_percent: number }

export interface OfferKit extends PricedKit { money: OfferMoney; colours: ColourChoice[] }

export interface OfferAddon {
  id: string;
  title: string;
  image: string;
  variant: string;
  qty_per_printer: number;
  available: boolean;
  money: OfferMoney;
  colour: ColourChoice | null;
}

export interface StoreBundleOffer {
  id: string;
  slug: string;
  name: string;
  image: string;
  before_iqd: number | null;
  after_iqd: number | null;
  saving_percent: number;
  needs_choices: boolean;
  available: boolean;
}

export interface PrinterOffers { kits: OfferKit[]; addons: OfferAddon[]; store_bundles: StoreBundleOffer[] }

// ------------------------------------------------------------------ reading the server's answer

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const first = (...vs: unknown[]): number | null => {
  for (const v of vs) {
    const n = num(v);
    if (n !== null) return n;
  }
  return null;
};

/** A name in the reader's language: a Text3, else name / name_ar / name_ku (a colour or a store bundle carries all three). */
function nameIn(r: Record<string, unknown>, lang: OfferLang): string {
  for (const key of ['title', 'name3', 'name']) {
    const t = r[key];
    if (t && typeof t === 'object') {
      const x = t as Partial<Text3>;
      const v = x[lang] || x.ar || x.en || '';
      if (v) return v;
    }
  }
  const ar = str(r.name_ar);
  const en = str(r.name);
  const ku = str(r.name_ku);
  return lang === 'en' ? en || ar : lang === 'ckb' ? ku || ar || en : ar || en;
}

/**
 * The money of a kit or an add-on. Before falls back to after (no discount =
 * no crossed price); the saving is the server's `discount_iqd` for the
 * quantity, else before − after of its own totals.
 */
function moneyOf(r: Record<string, unknown>): OfferMoney {
  const after_per = first(r.price_per_printer_iqd, r.after_per_printer_iqd, r.unit_after_iqd);
  const after_total = first(r.total_iqd, r.after_total_iqd);
  const before_per = first(r.before_per_printer_iqd, r.price_before_per_printer_iqd) ?? after_per;
  const before_total = first(r.before_total_iqd, r.total_before_iqd) ?? after_total;
  const discount = first(r.discount_iqd, r.discount_total_iqd);
  const saving_total = Math.max(0, discount ?? (before_total !== null && after_total !== null ? before_total - after_total : 0));
  // The server's percent; an older answer without one is said from its own two figures.
  const pct = num(r.saving_percent);
  const saving_percent = pct !== null ? Math.max(0, Math.round(pct)) : before_per && after_per !== null && before_per > after_per ? Math.round(((before_per - after_per) / before_per) * 100) : 0;
  return { before_per, after_per, before_total, after_total, saving_total, saving_percent };
}

function colourChoiceOf(r: Record<string, unknown>, lang: OfferLang, key: string): ColourChoice | null {
  const mode = r.color_mode === 'customer' ? 'customer' : 'fixed';
  if (mode !== 'customer') return null;
  const colors: OfferColour[] = (Array.isArray(r.colors) ? r.colors : []).map((c) => {
    const x = rec(c);
    return { id: str(x.id), name: nameIn(x, lang), hex: str(x.hex), unit_iqd: first(x.unit_price_iqd, x.unit_iqd), available: x.available !== false };
  }).filter((c) => !!c.id);
  const random = rec(r.random);
  return { key, product_id: str(r.product_id), name: nameIn(r, lang), color_mode: mode, colors, random_available: r.random === undefined ? colors.some((c) => c.available) : random.available !== false };
}

export function readOffers(raw: unknown, lang: OfferLang): PrinterOffers {
  const r = rec(raw);
  const kits: OfferKit[] = (Array.isArray(r.kits) ? r.kits : []).map((k) => {
    const x = rec(k);
    const items = Array.isArray(x.items) ? (x.items as Array<Record<string, unknown>>) : [];
    return {
      ...(x as unknown as PricedKit),
      items: items as unknown as PricedKit['items'],
      money: moneyOf(x),
      colours: items.map((i) => colourChoiceOf(rec(i), lang, str(i.product_id))).filter((c): c is ColourChoice => !!c),
    };
  });
  const addons: OfferAddon[] = (Array.isArray(r.addons) ? r.addons : []).map((a) => {
    const x = rec(a);
    return {
      id: str(x.id),
      title: nameIn(x, lang),
      image: str(x.image),
      variant: str(x.variant),
      qty_per_printer: Math.max(1, num(x.qty_per_printer) ?? num(x.qty) ?? 1),
      available: x.available !== false,
      money: moneyOf(x),
      colour: colourChoiceOf(x, lang, str(x.id)),
    };
  }).filter((a) => !!a.id);
  const store_bundles: StoreBundleOffer[] = (Array.isArray(r.store_bundles) ? r.store_bundles : []).map((b) => {
    const x = rec(b);
    return {
      id: str(x.id) || str(x.product_id),
      slug: str(x.slug),
      name: nameIn(x, lang),
      image: str(x.image),
      before_iqd: first(x.before_iqd, x.component_total_iqd),
      after_iqd: first(x.after_iqd, x.bundle_price_iqd, x.price_iqd),
      saving_percent: Math.max(0, Math.round(num(x.saving_percent) ?? 0)),
      needs_choices: x.needs_choices === true,
      available: x.available !== false,
    };
  }).filter((b) => !!b.id);
  return { kits, addons, store_bundles };
}

/**
 * GET /api/products/:slug/kits — the kits, add-ons and store bundles for this
 * printer selection, priced by the server. The colours picked so far travel
 * too (`colors=<productId|addonId>:<colourId|random>,…` — kit items by product,
 * add-ons by their own id), so the figures are for exactly what is chosen.
 */
export async function loadOffers(f: KitsFor, colours: Record<string, string> | null | undefined, lang: OfferLang, signal?: AbortSignal): Promise<PrinterOffers> {
  const q = new URLSearchParams();
  if (f.optionValueIds.length) q.set('optionValueIds', f.optionValueIds.join(','));
  if (f.fulfillmentType) q.set('fulfillmentType', f.fulfillmentType);
  if (f.transportMethod) q.set('transportMethod', f.transportMethod);
  q.set('qty', String(Math.max(1, f.qty)));
  const picked = Object.entries(colours ?? {}).filter(([, v]) => !!v).sort(([a], [b]) => a.localeCompare(b));
  if (picked.length) q.set('colors', picked.map(([p, c]) => `${p}:${c}`).join(','));
  const r = await api.get<unknown>(`/api/products/${encodeURIComponent(f.slug)}/kits?${q}`, { signal, timeoutMs: 12000 });
  return readOffers(r, lang);
}

/** A picked colour that cannot be served now (sold out, or no longer a candidate). */
export function colourProblem(choices: readonly ColourChoice[], picked: Record<string, string> | null | undefined): boolean {
  return choices.some((c) => {
    const v = picked?.[c.key] ?? RANDOM;
    if (v === RANDOM) return !c.random_available;
    const colour = c.colors.find((x) => x.id === v);
    return !colour || !colour.available;
  });
}

// ------------------------------------------------------------------ pieces

/** «~~45,000~~ 40,500»: before struck only when it is really higher. */
export function BeforeAfter({ before, after, money, s, suffix, plus = false }: { before: number | null; after: number | null; money: (n: number) => string; s: OfferStrings; suffix?: string; plus?: boolean }) {
  if (after === null) return <span>{s.unavailable}</span>;
  const struck = before !== null && before > after;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5 tabular-nums" dir="auto">
      {struck ? (
        <span className="text-[11px] font-normal line-through opacity-70" aria-label={`${s.priceBefore}: ${money(before as number)}`}>{money(before as number)}</span>
      ) : null}
      {/* «+» only on what is added; the struck price before it never carries one (like the add-on cards). */}
      <span>{plus ? '+' : ''}{money(after)}</span>
      {suffix ? <span className="text-[11px] font-normal opacity-70">{suffix}</span> : null}
    </span>
  );
}

/** The swatch dot of a colour: an inline style (no class of its own). */
function Swatch({ hex }: { hex: string }) {
  return <span aria-hidden="true" className="inline-block shrink-0 rounded-full border border-border-subtle" style={{ width: 14, height: 14, background: hex || 'transparent' }} />;
}

/** One item's colours: «لون عشوائي» first (the default), then every in-stock colour; a sold-out one says «نفد». */
export function ColourChips({ choice, value, onPick, s, dir, money }: { choice: ColourChoice; value: string; onPick: (v: string) => void; s: OfferStrings; dir: 'rtl' | 'ltr'; money: (n: number) => string }) {
  const options = [
    { id: RANDOM, label: s.randomColour, hex: '', disabled: !choice.random_available, sub: '' },
    ...choice.colors.map((c) => ({ id: c.id, label: c.name, hex: c.hex, disabled: !c.available, sub: c.available ? '' : s.soldOut })),
  ];
  const stop = tabStop(options.map((o) => o.id), value, (id) => !options.find((o) => o.id === id)?.disabled);
  const priced = new Set(choice.colors.map((c) => c.unit_iqd).filter((n): n is number => n !== null));
  return (
    <div className="mt-1.5">
      <p className="text-[11px] text-text-secondary" dir="auto">{s.colourOf(choice.name)}</p>
      <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup" aria-label={s.colourOf(choice.name)} onKeyDown={(e) => moveRadioFocus(e, dir)} data-offer-colours={choice.key}>
        {options.map((o) => {
          const on = value === o.id;
          const colour = choice.colors.find((c) => c.id === o.id);
          // A colour with its own price says it (only when the colours are not all one price).
          const own = colour && colour.unit_iqd !== null && priced.size > 1 ? money(colour.unit_iqd) : '';
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={stop === o.id ? 0 : -1}
              disabled={o.disabled}
              onClick={() => onPick(o.id)}
              data-offer-colour={o.id}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold press-scale [touch-action:manipulation] disabled:opacity-50 ${on ? 'bg-white text-black border-transparent' : o.id === RANDOM ? 'border-dashed border-text-muted text-text-primary' : 'border-border-subtle text-text-primary'}`}
            >
              {o.id === RANDOM ? null : <Swatch hex={o.hex} />}
              <span dir="auto">{o.label}</span>
              {o.sub ? <span className="text-[11px] font-normal">· {o.sub}</span> : own ? <span className="text-[11px] font-normal tabular-nums opacity-70" dir="auto">{own}</span> : null}
            </button>
          );
        })}
      </div>
      {value === RANDOM ? <p className="mt-1 text-[11px] text-text-secondary">{s.randomHint}</p> : null}
    </div>
  );
}

/** The chosen kit's customer-colour items, each with its chips. */
export function KitColours({ kit, picked, onPick, lang, dir, money }: { kit: OfferKit; picked: Record<string, string> | null | undefined; onPick: (key: string, v: string) => void; lang: OfferLang; dir: 'rtl' | 'ltr'; money: (n: number) => string }) {
  const s = OFFER_STRINGS[lang];
  if (!kit.colours.length) return null;
  return (
    <div className="mt-2 rounded-xl border border-border-subtle p-2.5" data-sheet-kit-colours={kit.id}>
      {kit.colours.map((c) => (
        <ColourChips key={c.key} choice={c} value={picked?.[c.key] ?? RANDOM} onPick={(v) => onPick(c.key, v)} s={s} dir={dir} money={money} />
      ))}
      <p className="mt-2 text-[11px] leading-snug text-text-secondary">{s.colourChosenNote}</p>
    </div>
  );
}

/** «إضافات بسعر خاص»: check cards — picture, name, «×1 لكل طابعة», before/after, colour chips once checked. */
export function AddonsBody({ addons, chosen, onToggle, picked, onPick, lang, dir, money }: {
  addons: readonly OfferAddon[];
  chosen: readonly string[];
  onToggle: (id: string) => void;
  /** The add-on colours picked so far, by add-on id (`extras.addonColors`). */
  picked: Record<string, string> | null | undefined;
  onPick: (addonId: string, v: string) => void;
  lang: OfferLang;
  dir: 'rtl' | 'ltr';
  money: (n: number) => string;
}) {
  const s = OFFER_STRINGS[lang];
  return (
    <>
      <div className="space-y-2" data-sheet-addons>
        {addons.map((a) => {
          const on = chosen.includes(a.id);
          return (
            <div key={a.id} className={`rounded-xl border ${on ? 'border-text-muted' : 'border-border-subtle'}`} data-sheet-addon={a.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={!a.available && !on}
                onClick={() => onToggle(a.id)}
                className="flex min-h-14 w-full items-center gap-3 px-2.5 py-2 text-start press-scale [touch-action:manipulation] disabled:opacity-50"
              >
                <span
                  aria-hidden="true"
                  className={`grid shrink-0 place-items-center rounded border text-[12px] font-bold ${on ? 'bg-white text-black border-transparent' : 'border-border-subtle'}`}
                  style={{ width: 20, height: 20 }}
                >
                  {on ? '✓' : ''}
                </span>
                {a.image ? <VariantImg sizes="48px" src={a.image} alt="" className="h-10 w-12 shrink-0 rounded-lg bg-white object-contain" /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-semibold leading-tight text-text-primary line-clamp-2" dir="auto">{a.title}</span>
                  <span className="block text-[11px] text-text-secondary" dir="auto">
                    {a.variant ? `${a.variant} · ` : ''}{s.qtyPerPrinter(a.qty_per_printer)}
                  </span>
                </span>
                <span className="shrink-0 text-end text-[12px] font-semibold text-text-primary">
                  {a.available ? <BeforeAfter before={a.money.before_per} after={a.money.after_per} money={money} s={s} /> : s.unavailable}
                  {a.available && a.money.saving_percent > 0 ? (
                    <span className="block text-[11px] font-normal text-success">{s.save(a.money.saving_percent)}</span>
                  ) : null}
                </span>
              </button>
              {on && a.colour ? (
                <div className="px-2.5 pb-2.5">
                  <ColourChips choice={a.colour} value={picked?.[a.colour.key] ?? RANDOM} onPick={(v) => onPick(a.colour!.key, v)} s={s} dir={dir} money={money} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-text-secondary">{s.addonsNote}</p>
    </>
  );
}

/**
 * «عروض مجمّعة»: the store bundles linked to this printer, each its own cart
 * line at its own price. No choices → added here (POST /api/cart/items
 * {productId, qty:1}) and «✓ أُضيف»; choices → its page. A guest goes to the
 * sign-in page first, as every add does.
 */
export function BundlesBody({ bundles, lang, money, signedIn, signInPath }: { bundles: readonly StoreBundleOffer[]; lang: OfferLang; money: (n: number) => string; signedIn: boolean; signInPath: string }) {
  const s = OFFER_STRINGS[lang];
  const [state, setState] = useState<Record<string, 'adding' | 'added' | 'failed'>>({});
  const [said, setSaid] = useState<Record<string, string>>({});
  const add = async (b: StoreBundleOffer) => {
    if (state[b.id] === 'adding' || state[b.id] === 'added') return;
    setState((m) => ({ ...m, [b.id]: 'adding' }));
    try {
      await api.post('/api/cart/items', { productId: b.id, qty: 1 });
      setState((m) => ({ ...m, [b.id]: 'added' }));
    } catch (err) {
      setState((m) => ({ ...m, [b.id]: 'failed' }));
      const message = err instanceof ApiError && lang === 'en' && err.message ? err.message : '';
      setSaid((m) => ({ ...m, [b.id]: message || s.addFailed }));
    }
  };
  return (
    <>
      <div className="grid grid-cols-2 gap-2" data-sheet-store-bundles>
        {bundles.map((b) => {
          const st = state[b.id];
          const saving = b.saving_percent > 0 && b.before_iqd !== null && b.after_iqd !== null && b.before_iqd > b.after_iqd;
          return (
            <div key={b.id} className="flex min-w-0 flex-col rounded-xl border border-border-subtle p-2" data-sheet-store-bundle={b.id}>
              <div className="relative">
                {b.image ? <VariantImg sizes="160px" src={b.image} alt="" className="aspect-square w-full rounded-lg bg-white object-contain" /> : null}
                {saving ? <span className="absolute top-1 start-1 rounded-full bg-white px-2 text-[11px] font-bold text-black">{s.save(b.saving_percent)}</span> : null}
              </div>
              <p className="mt-1.5 text-[12px] font-semibold leading-tight text-text-primary line-clamp-2" dir="auto">{b.name}</p>
              <p className="mt-0.5 text-[12.5px] font-bold text-text-primary">
                <BeforeAfter before={saving ? b.before_iqd : null} after={b.after_iqd} money={money} s={s} />
              </p>
              {/* «أضف» and «اختر الخيارات» are the same pill at the card's foot, so neighbouring cards line up. */}
              <div className="mt-auto pt-1.5">
                {!b.available ? (
                  <p className="text-[11px] text-text-secondary">{s.unavailable}</p>
                ) : b.needs_choices ? (
                  <Link to={`/bundles/${encodeURIComponent(b.slug)}`} className="inline-flex min-h-11 w-full items-center justify-center rounded-full border border-border-subtle text-[12.5px] font-semibold text-text-primary press-scale" data-sheet-bundle-link>{s.chooseOptions}</Link>
                ) : !signedIn ? (
                  <Link to={signInPath} className="inline-flex min-h-11 w-full items-center justify-center rounded-full border border-border-subtle text-[12.5px] font-semibold text-text-primary press-scale">{s.signInToAdd}</Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => void add(b)}
                    disabled={st === 'adding' || st === 'added'}
                    aria-busy={st === 'adding' || undefined}
                    className={`min-h-11 w-full rounded-full border text-[12.5px] font-semibold press-scale [touch-action:manipulation] ${st === 'added' ? 'border-transparent text-success' : 'border-border-subtle text-text-primary'} disabled:opacity-70`}
                    data-sheet-bundle-add
                  >
                    {st === 'adding' ? s.adding : st === 'added' ? s.added : s.addBundle}
                  </button>
                )}
                {st === 'failed' ? <p role="alert" className="mt-1 text-[11px] text-text-primary">{said[b.id] || s.addFailed}</p> : null}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-text-secondary">{s.bundlesNote}</p>
    </>
  );
}

/** The shared loading / failed line (same look as the sheet's own). */
export function OffersLoading({ state, lang, again }: { state: 'loading' | 'failed'; lang: OfferLang; again: () => void }) {
  const s = OFFER_STRINGS[lang];
  return state === 'loading' ? (
    <p role="status" className="text-[11.5px] text-text-secondary">{s.loading}</p>
  ) : (
    <p role="alert" className="flex flex-wrap items-center gap-2 text-[11.5px] text-text-primary">
      {s.failed}
      <button type="button" onClick={again} className="inline-flex min-h-11 items-center font-semibold underline">{s.retry}</button>
    </p>
  );
}

