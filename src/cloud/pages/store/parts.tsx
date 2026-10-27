/**
 * THE STORE'S SHARED PIECES — the house primitives dressed for buying:
 *
 *   QuantityPicker  − [figure] + in the variant's own steps; a typed figure
 *                   (or a link's ?qty=) is moved to what the server accepts,
 *                   and the picker says why;
 *   Chip, ChipRow   the catalogue's filter chips (the class strings of
 *                   src/components/listing/QuickFilterChips.tsx, letter for
 *                   letter, so they add nothing to the stylesheet);
 *   SearchField     the house well with a magnifier and a clear button;
 *   Swatch          a material's own colour, from the owner's catalogue;
 *   CartLink        the cart door with its count (signed in only);
 *   useNameBook     the catalogue's names for the ids a quote or an order
 *                   line carries — a line is never named by a guess;
 *   useNow, useDebounced, useAddToCart.
 *
 * StoreRoutes imports this module through the catalogue, so it rides in the
 * section's own chunk and the lazy pages reuse it without a chunk of their own.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '../../../components/ui/Badge';
import { IconButton } from '../../../components/ui/Button';
import { Money } from '../../../components/ui/Money';
import { formatFigure, groupedNumber, parseLocaleNumber } from '../../../lib/localeNumber';
import { subscribeSecond } from '../../../lib/secondTicker';
import { toast } from '../../../lib/toastStore';
import { listPackages, listPrinters, listStoreProducts } from '../../api';
import { useSignIn } from '../../auth';
import { useCloud } from '../../CloudContext';
import { formatHours, formatQuantity, unitWord } from '../../format';
import { goods, lineKind, store } from '../../strings/store';
import { tx, useCloudText } from '../../text';
import type { CreditPackage, PrinterModel, StoreProduct, Tri } from '../../types';
import { Check, Minus, Plus, Search, ShoppingBag, X } from '../../ui';
import { useCloudQuery } from '../../useCloudQuery';
import { useCart } from './cart';
import { CART_MAX_LINES, firstQuantity, lastQuantity, moveReason, snapQuantity, stepQuantity, type NewCartLine, type QuantityRule } from './rules';

// ------------------------------------------------------------------ time

/** «Now», beating once a second with every other clock on the page (src/lib/secondTicker.ts). */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeSecond(setNow), []);
  return now;
}

/** `value`, once it has stopped changing for `ms` — so a price is asked once per settled quantity, not per keystroke. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * A sentence with a live piece in one of its `{slots}` — a ticking clock, an
 * amount — kept in the translator's word order (the slot may sit anywhere in
 * the Arabic, English or Sorani sentence) and the piece kept an LTR island.
 * `text` is the template as `t()` returns it without values.
 */
export function Sentence({ text, slots }: { text: string; slots: Record<string, React.ReactNode> }) {
  const parts = text.split(/\{(\w+)\}/g);
  return <>{parts.map((part, i) => (i % 2 === 1 ? <React.Fragment key={i}>{part in slots ? slots[part] : `{${part}}`}</React.Fragment> : part))}</>;
}

// ------------------------------------------------------------------ chips, search, swatch

/**
 * A row of chips. On the page it scrolls sideways and bleeds to the screen's
 * edge on a phone (the catalogue's facet row); `inset` — inside a card — it
 * wraps within the card instead of reaching past its padding.
 */
export function ChipRow({ label, inset = false, children }: { label: string; inset?: boolean; children: React.ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={inset ? 'flex flex-wrap gap-1.5' : '-mx-4 flex gap-1.5 overflow-x-auto overscroll-x-contain px-4 hide-scrollbar sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-wrap lg:px-0'}
    >
      {children}
    </div>
  );
}

/**
 * A filter or a choice drawn 32px and hit 44px: flush clay at rest, pressed
 * into a well with a check when on. A toggle (`aria-pressed`), each its own
 * Tab stop, so a row of them needs no arrow-key contract to be usable.
 */
export function Chip({ on, onClick, leading, children }: { on: boolean; onClick: () => void; leading?: React.ReactNode; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className="group inline-flex min-h-11 shrink-0 items-center focus-visible:outline-none">
      <span
        className={`inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full px-3.5 text-[12.5px] font-bold transition-colors group-focus-visible:ring-2 group-focus-visible:ring-focus ${
          on
            ? 'border border-transparent bg-[var(--clay-well-bg)] text-text-primary shadow-press'
            : 'border border-border-subtle bg-surface-raised text-text-secondary shadow-xs group-hover:text-text-primary'
        }`}
      >
        {on ? <Check aria-hidden="true" className="size-3.5" strokeWidth={2.6} /> : leading}
        {children}
      </span>
    </button>
  );
}

export function SearchField({ value, onChange, placeholder, label }: { value: string; onChange: (next: string) => void; placeholder: string; label: string }) {
  const { t } = useCloudText();
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <div role="search" className="relative">
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted start-3.5" />
      <input
        ref={input}
        type="search"
        enterKeyHint="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        maxLength={100}
        className="lv-input ps-11 pe-12 text-[15px] leading-[1.6] [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
          aria-label={t(store.clearSearch)}
          className="absolute top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus end-0.5"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** The material's own colour (catalogue data, `#RRGGBB`), not a theme colour; nothing for a colour the row does not state. */
export function Swatch({ hex, size = 'md' }: { hex: string | null | undefined; size?: 'sm' | 'md' | 'lg' }) {
  if (!hex || !HEX.test(hex)) return null;
  const box = size === 'sm' ? 'h-3.5 w-3.5' : size === 'lg' ? 'h-9 w-9' : 'h-5 w-5';
  return <span aria-hidden="true" className={`block shrink-0 rounded-full border border-border-subtle ${box}`} style={{ backgroundColor: hex }} />;
}

// ------------------------------------------------------------------ quantities

/** «From 50 g to 5 kg, in steps of 50 g» — the rule in the reader's words, or null when nothing can be bought. */
export function useRuleText() {
  const { t, lang } = useCloudText();
  return useCallback(
    (rule: QuantityRule, unit: string | null): string | null => {
      const first = firstQuantity(rule);
      const last = lastQuantity(rule);
      if (first === null || last === null) return null;
      const q = (n: number) => (unit ? formatQuantity(n, unit, lang) : formatFigure(n, lang));
      return rule.step > 1 ? t(goods.quantityRule, { min: q(first), max: q(last), step: q(rule.step) }) : t(goods.quantityRange, { min: q(first), max: q(last) });
    },
    [t, lang]
  );
}

export interface QuantityPickerProps {
  value: number;
  rule: QuantityRule;
  /** The base unit (`g`, `pc`…) the figure is counted in; null for a count of packages. */
  unit: string | null;
  onChange: (next: number) => void;
  /** The field's accessible name: «Quantity», «Quantity of PLA Basic». */
  label: string;
  disabled?: boolean;
  /** A figure asked for elsewhere (a link's ?qty=) that `value` was moved from: said once, like a typed one. */
  asked?: number | null;
}

/**
 * − [figure] + in the rule's own steps, between its first and last accepted
 * quantities. The figure is a real text field (a phone opens its digit pad;
 * ١٢٣ and a pasted «1,000» read as digits) that commits on blur or Enter —
 * never per keystroke — and a figure the server would refuse is moved to the
 * nearest one it accepts, with a sentence that says why.
 */
export function QuantityPicker({ value, rule, unit, onChange, label, disabled = false, asked = null }: QuantityPickerProps) {
  const { t, lang } = useCloudText();
  const ruleText = useRuleText();
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const skipCommit = useRef(false);
  const first = firstQuantity(rule);
  const last = lastQuantity(rule);
  const q = (n: number) => (unit ? formatQuantity(n, unit, lang) : formatFigure(n, lang));
  // Why a figure moved, in the reader's words.
  const why = (from: number, to: number) => {
    const reason = moveReason(from, rule);
    if (reason === 'least') return t(goods.raisedToLeast, { qty: q(to) });
    if (reason === 'most') return t(goods.loweredToMost, { qty: q(to) });
    return t(goods.snapped, { step: q(rule.step), qty: q(to) });
  };
  // The figure asked for and where it went — said for that figure only (a quantity changed any other
  // way since says nothing), in the language on screen when it is read.
  const [note, setNote] = useState<{ from: number; value: number } | null>(() => (asked !== null && asked !== value ? { from: asked, value } : null));

  const commit = (raw: string) => {
    setDraft(null);
    if (skipCommit.current) {
      skipCommit.current = false;
      return;
    }
    const parsed = parseLocaleNumber(raw, 0);
    if (!parsed.valid || parsed.value === null) return;
    const next = snapQuantity(parsed.value, rule);
    if (next === null) return;
    setNote(next !== parsed.value ? { from: parsed.value, value: next } : null);
    if (next !== value) onChange(next);
  };

  const step = (direction: 1 | -1) => {
    const next = stepQuantity(value, rule, direction);
    setNote(null);
    if (next !== null && next !== value) onChange(next);
  };

  const caption = ruleText(rule, unit);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <IconButton
          variant="secondary"
          label={t(goods.decrease)}
          icon={<Minus aria-hidden="true" className="h-4 w-4" />}
          onClick={() => step(-1)}
          disabled={disabled || first === null || value <= first}
        />
        <div className="w-28 shrink-0">
          <input
            type="text"
            inputMode="numeric"
            enterKeyHint="done"
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            aria-label={label}
            aria-describedby={caption ? `${id}-rule` : undefined}
            disabled={disabled}
            value={draft ?? groupedNumber(value)}
            onFocus={(e) => {
              const el = e.currentTarget;
              // The bare figure replaces the grouped one before anything is typed, then all of it is
              // selected — now, and once more after the frame (a phone may move the caret on focus).
              flushSync(() => setDraft(String(value)));
              el.select();
              requestAnimationFrame(() => {
                if (document.activeElement === el) el.select();
              });
            }}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={(e) => commit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                skipCommit.current = true;
                e.currentTarget.blur();
              }
            }}
            className="lv-input text-center font-bold tabular-nums"
          />
        </div>
        <IconButton
          variant="secondary"
          label={t(goods.increase)}
          icon={<Plus aria-hidden="true" className="h-4 w-4" />}
          onClick={() => step(1)}
          disabled={disabled || last === null || value >= last}
        />
        {unit ? <span className="text-[13px] font-semibold text-text-secondary">{unitWord(unit, lang)}</span> : null}
      </div>
      {caption ? (
        <p id={`${id}-rule`} className="text-[12px] text-text-muted">
          {caption}
        </p>
      ) : null}
      <p role="status" className="text-[12px] font-medium text-text-secondary">
        {note && note.value === value ? why(note.from, note.value) : ''}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ the cart door

/** The cart, with how many lines it holds — for a signed-in customer (nobody else has a cart). */
export function CartLink() {
  const { t } = useCloudText();
  const { signedIn } = useCloud();
  const cart = useCart();
  if (!signedIn) return null;
  return (
    <Link to="/store/cart" aria-label={t(store.cartCount, { n: cart.count })} className="lv-button lv-button-secondary lv-button-sm">
      <ShoppingBag aria-hidden="true" className="h-4 w-4" />
      {t(store.cart)}
      {cart.count > 0 ? <Badge tone="accent">{cart.count}</Badge> : null}
    </Link>
  );
}

/**
 * Add a line, and say what happened: added or merged (with the way to the
 * cart), a full cart, a refused quantity. A visitor is sent to sign in first —
 * a cart belongs to an account.
 */
export function useAddToCart(): (line: NewCartLine) => void {
  const { t } = useCloudText();
  const { signedIn } = useCloud();
  const signIn = useSignIn();
  const navigate = useNavigate();
  const cart = useCart();
  return useCallback(
    (line: NewCartLine) => {
      if (!signedIn) {
        signIn();
        return;
      }
      const outcome = cart.add(line);
      if (outcome === 'added' || outcome === 'merged') {
        toast.success(t(outcome === 'added' ? store.added : store.merged), { id: 'cloud-cart-add', action: { label: t(store.viewCart), onClick: () => navigate('/store/cart') } });
      } else if (outcome === 'full') toast.error(t(store.cartFull, { n: CART_MAX_LINES }), { id: 'cloud-cart-add' });
      else if (outcome === 'invalid') toast.error(t(store.quantityRefused), { id: 'cloud-cart-add' });
      else signIn();
    },
    [signedIn, signIn, cart, t, navigate]
  );
}

// ------------------------------------------------------------------ naming a line

/** The catalogue's names for the ids a quote or order line carries. Inactive items are not listed: their line says what kind it is instead. */
export interface NameBook {
  variant: (id: string | null) => StoreProduct | null;
  pkg: (id: string | null) => CreditPackage | null;
  tier: (id: string | null) => Tri | null;
}

interface Named {
  variant_id: string | null;
  package_id: string | null;
  tier_id: string | null;
  breakdown?: Record<string, unknown>;
}

/** A bundle's material items, as an order or quote line's breakdown carries them. */
export function bundleOf(line: { breakdown?: Record<string, unknown>; bundle?: Array<{ variant_id: string; qty: number }> }): Array<{ variant_id: string; qty: number }> {
  const raw = line.bundle ?? (line.breakdown?.bundle as unknown);
  if (!Array.isArray(raw)) return [];
  return raw.filter((b): b is { variant_id: string; qty: number } => !!b && typeof b.variant_id === 'string' && typeof b.qty === 'number');
}

export function useNameBook(lines: readonly Named[]): NameBook {
  const needVariants = lines.some((l) => l.variant_id || bundleOf(l).length > 0);
  const needPackages = lines.some((l) => l.package_id);
  const needTiers = lines.some((l) => l.tier_id);
  const products = useCloudQuery<StoreProduct[] | null>((signal) => (needVariants ? listStoreProducts(undefined, { signal }) : Promise.resolve(null)), [needVariants]);
  const packages = useCloudQuery<CreditPackage[] | null>((signal) => (needPackages ? listPackages(undefined, { signal }) : Promise.resolve(null)), [needPackages]);
  const printers = useCloudQuery<PrinterModel[] | null>((signal) => (needTiers ? listPrinters({ signal }) : Promise.resolve(null)), [needTiers]);
  return {
    variant: (id) => (id ? (products.data?.find((v) => v.id === id) ?? null) : null),
    pkg: (id) => (id ? (packages.data?.find((p) => p.id === id) ?? null) : null),
    tier: (id) => (id ? (printers.data?.find((m) => m.tier_id === id)?.tier_name ?? null) : null),
  };
}

/** «PLA Basic · Cold White» — a variant under its product's name. */
export function variantName(v: StoreProduct, lang: 'ar' | 'en' | 'ckb'): string {
  const product = tx(v.product_name, lang);
  const own = tx(v.name, lang);
  return own && own !== product ? `${product} · ${own}` : product || own;
}

/** A quote or order line's name: the catalogue's, or what kind of line it is. */
export function lineTitle(line: Named & { kind: string }, book: NameBook, lang: 'ar' | 'en' | 'ckb', t: (s: Tri) => string): string {
  if (line.kind === 'credit_package') {
    const p = book.pkg(line.package_id);
    return (p && tx(p.name, lang)) || t(lineKind.credit_package);
  }
  if (line.kind === 'material') {
    const v = book.variant(line.variant_id);
    return v ? variantName(v, lang) : t(lineKind.material);
  }
  if (line.kind === 'shipping_fee') return t(lineKind.shipping_fee);
  return t(lineKind.credit_hours);
}

/** The second line: hours and their class, or the material's quantity. */
export function lineDetail(line: Named & { kind: string; quantity: number; seconds: number }, book: NameBook, lang: 'ar' | 'en' | 'ckb', t: (s: Tri, v?: Record<string, string | number>) => string): string {
  if (line.kind === 'credit_package' || line.kind === 'credit_hours') {
    const cls = book.tier(line.tier_id);
    const parts = [formatHours(line.seconds, lang), cls ? tx(cls, lang) : null, line.kind === 'credit_package' && line.quantity > 1 ? t(lineKind.count, { n: formatFigure(line.quantity, lang) }) : null];
    return parts.filter(Boolean).join(' · ');
  }
  if (line.kind === 'material') {
    const unit = book.variant(line.variant_id)?.unit_code ?? (typeof line.breakdown?.unit_code === 'string' ? line.breakdown.unit_code : null);
    return unit ? formatQuantity(line.quantity, unit, lang) : formatFigure(line.quantity, lang);
  }
  return '';
}

// ------------------------------------------------------------------ figures

/** A short column of labelled amounts: subtotal, discount (as a minus), total. */
export function AmountRows({ rows }: { rows: Array<{ label: string; iqd: number | null | undefined; strong?: boolean; minus?: boolean }> }) {
  return (
    <dl className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-3">
          <dt className={r.strong ? 'text-sm font-bold text-text-primary' : 'text-[13px] text-text-secondary'}>{r.label}</dt>
          <dd className={r.strong ? 'text-ui-lg font-bold text-text-primary' : 'text-sm font-semibold text-text-primary'}>
            <Money iqd={r.minus && r.iqd != null ? -r.iqd : r.iqd} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
