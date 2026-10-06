/**
 * ONE CARD PER GIFT, ONE BODY PER `ui_state` (docs/REVIEWS_GIFTS.md §2, §8 C3).
 *
 * The state is the SERVER's (`deriveGiftUiState`, worker/lib/gifts/
 * entitlements.ts): this file never combines flags to decide what a gift is,
 * it only draws the state it was handed, and each state offers exactly its own
 * action — the code boxes only while a code is awaited, «أضف الهدية إلى
 * السلة» only while the gift is ready, «عرض الطلب» once it is ordered. After
 * an action the page re-reads the server's answer rather than guessing the
 * next state here.
 *
 * Nothing in a card is a price, an id relation or a permission: the choices
 * offered are the snapshot's own allowed lists (and the server re-checks every
 * one), the code is sent as typed (ASCII digits) and the verdict is the
 * server's. Words: ./giftStrings.ts (ar / en / ckb).
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, CheckCircle2, Clock, Gift, Lock, Package, ShoppingCart, XCircle } from 'lucide-react';
import OtpBoxes, { normalizeOtp } from '../../auth/OtpBoxes';
import SafeImage from '../../ui/SafeImage';
import { Button } from '../../ui/Button';
import { StatusChip, type Tone } from '../../ui/Badge';
import { formatDate, statusLabel } from '../../orders/format';
import { shippingTypeLabel } from '../../../lib/shippingType';
import { useLanguage } from '../../../LanguageContext';
import { giftLang, giftText, type GiftLang, type GiftStringKey } from './giftStrings';

// ------------------------------------------------------------------ the view

/** Mirrors `GiftUiState` in worker/lib/gifts/entitlements.ts. */
export type GiftUiState =
  | 'pending'
  | 'awaiting_code'
  | 'locked'
  | 'choose_item'
  | 'ready'
  | 'in_cart'
  | 'ordered'
  | 'delivered'
  | 'cancelled'
  | 'legacy';

/** A label as the server may send it: one name, or one per language. */
export interface GiftLabel {
  name?: string;
  name_ar?: string;
  name_en?: string;
  name_ckb?: string;
}

/** Mirrors `GiftChoiceOption`: one option value the gift names — a pin, or a value the customer may pick. */
export interface GiftChoiceOption extends GiftLabel {
  id: string;
  group_id: string;
  /** The option group's own (store) name; '' for a product without relational groups. */
  group_name: string;
  pinned: boolean;
}

/** Mirrors `GiftChoiceColor`, with its option links (OR inside a group, AND across groups). */
export interface GiftChoiceColor extends GiftLabel {
  id: string;
  hex: string;
  pinned?: boolean;
  links?: Array<{ group_id: string; option_value_id: string }>;
}

/** One option group the customer picks in: only the values the snapshot allows. */
export interface GiftChoiceGroup {
  id: string;
  name: string;
  values: GiftChoiceOption[];
}

export interface GiftItemDisplay {
  name_ar: string;
  name_en: string;
  name_ckb: string;
  image: string;
  variant_ar: string;
  variant_en: string;
  variant_ckb: string;
  color_name: string;
  color_hex: string;
  regular_iqd: number;
  color_name_ar?: string;
  color_name_ckb?: string;
}

/** Mirrors `GiftSnapshotItem` (worker/lib/gifts/entitlements.ts). */
export interface GiftItemView {
  ref: string;
  pool_item_id: string | null;
  product_id: string;
  sale_type: 'direct_sale' | 'pre_order';
  /** Admin pins. */
  option_value_ids: string[];
  color_id: string;
  transport_method: string;
  /** What the customer may still pick (empty = nothing to pick). */
  allowed_option_value_ids: string[];
  allowed_color_ids: string[];
  display: GiftItemDisplay;
  /**
   * The words of every pin and every value the customer may pick, frozen at
   * issue (an optional addition of the gifts server). Without them the card
   * cannot name a choice, so it says so instead of offering bare ids.
   */
  choices?: { options: GiftChoiceOption[]; colors: GiftChoiceColor[] };
}

export interface GiftChosen {
  ref: string;
  product_id: string;
  sale_type: 'direct_sale' | 'pre_order';
  option_value_ids: string[];
  color_id: string;
  transport_method: string;
  /** OPTIONAL — the frozen words of the final selection (pins + picks). */
  display?: Partial<GiftItemDisplay>;
}

/** Mirrors `GiftView` (worker/lib/gifts/entitlements.ts) — never a code or a verifier. */
export interface GiftView {
  id: string;
  ui_state: GiftUiState;
  level: number;
  grant_mode: 'legacy' | 'level' | 'manual';
  printer: { product_id: string; name: string; name_ar: string; image: string };
  review_id: string;
  items: GiftItemView[];
  chosen: GiftChosen | null;
  in_cart: { cart_item_id: string } | null;
  order: { id: string; status: string; stage: string | null } | null;
  orderable: { ok: boolean; code: string | null } | null;
  created_at: string;
  redeemed_at: string | null;
  ordered_at: string | null;
  fulfilled_at: string | null;
  legacy: { max_level: number; chosen_level: number | null; contents: unknown[] } | null;
}

/** Mirrors `PendingGiftView`: a reward still awaiting the admin. */
export interface PendingGiftView {
  reward_id: string;
  ui_state: 'pending';
  review_id: string;
  printer: { product_id: string; name: string; name_ar: string; image: string };
  submitted_at: string;
  /** 'submitted', or 'revision_needed' when the admin asked for a change to the review. */
  reward_state?: string;
}

/** What «تأكيد الاختيار» sends: the item, and ONLY the customer's own picks (pins are the server's). */
export interface GiftPick {
  ref: string;
  optionValueIds: string[];
  colorId: string;
}

// ------------------------------------------------------------- pure helpers

const STATE_LABEL: Record<GiftUiState, GiftStringKey> = {
  pending: 'statePending',
  awaiting_code: 'stateAwaitingCode',
  locked: 'stateLocked',
  choose_item: 'stateChooseItem',
  ready: 'stateReady',
  in_cart: 'stateInCart',
  ordered: 'stateOrdered',
  delivered: 'stateDelivered',
  cancelled: 'stateCancelled',
  legacy: 'stateLegacy',
};

const STATE_TONE: Record<GiftUiState, Tone> = {
  pending: 'neutral',
  awaiting_code: 'accent',
  locked: 'warning',
  choose_item: 'accent',
  ready: 'success',
  in_cart: 'info',
  ordered: 'info',
  delivered: 'success',
  cancelled: 'neutral',
  legacy: 'neutral',
};

export function giftStateLabel(lang: GiftLang, state: GiftUiState): string {
  return giftText(lang, STATE_LABEL[state] ?? 'stateLegacy');
}

/** The states that ask the customer to do something now — what GiftsEntry counts. */
export const ACTIONABLE_GIFT_STATES: ReadonlySet<GiftUiState> = new Set(['awaiting_code', 'choose_item', 'ready']);

/** Reading order on the page: what needs the customer first, history last. */
const STATE_ORDER: Record<GiftUiState, number> = {
  awaiting_code: 0,
  choose_item: 1,
  ready: 2,
  locked: 3,
  in_cart: 4,
  ordered: 5,
  pending: 6,
  delivered: 7,
  legacy: 8,
  cancelled: 9,
};

/** A stable sort by `STATE_ORDER`; the server's order is kept inside one state. */
export function sortGifts<T extends { ui_state: GiftUiState }>(gifts: readonly T[]): T[] {
  return gifts
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (STATE_ORDER[a.g.ui_state] ?? 99) - (STATE_ORDER[b.g.ui_state] ?? 99) || a.i - b.i)
    .map((x) => x.g);
}

/** A label in the reader's language: its own column, then any other, then ''. */
export function labelOf(lang: GiftLang, l: GiftLabel | null | undefined): string {
  if (!l) return '';
  const own = lang === 'en' ? l.name_en : lang === 'ckb' ? l.name_ckb : l.name_ar;
  return (own || l.name || l.name_en || l.name_ar || l.name_ckb || '').trim();
}

/**
 * The product's name. A store product is named the way the cart and the
 * checkout name it (§3/§12: the product's own name, the same in every
 * language), with the other columns only as a fallback.
 */
export function giftProductName(display: Partial<GiftItemDisplay> | null | undefined): string {
  if (!display) return '';
  return (display.name_en || display.name_ar || display.name_ckb || '').trim();
}

export function printerName(printer: { name: string; name_ar: string } | null | undefined): string {
  return (printer?.name || printer?.name_ar || '').trim();
}

/** The item the gift is fixed to: the customer's choice, or the only alternative. */
export function chosenItemOf(gift: Pick<GiftView, 'items' | 'chosen'>): GiftItemView | null {
  const items = Array.isArray(gift.items) ? gift.items : [];
  if (gift.chosen) {
    const hit = items.find((i) => i.ref === gift.chosen?.ref);
    if (hit) return hit;
  }
  return items.length === 1 ? items[0] : null;
}

/** True when the customer still has something to pick inside this item. */
export function itemHasPicks(item: GiftItemView): boolean {
  return (item.allowed_option_value_ids ?? []).length > 0 || (item.allowed_color_ids ?? []).length > 0;
}

export interface ItemNeeds {
  /** One entry per option group the customer picks in, in the snapshot's order. */
  groups: GiftChoiceGroup[];
  colors: GiftChoiceColor[];
  /** The admin's pins, by option group — what a colour's links are tested against beside the picks. */
  pinnedByGroup: Record<string, string>;
  /** An allowed id the view gave no words for: the card cannot offer it honestly. */
  unnamed: boolean;
}

/**
 * What the customer must pick in an item: only values the snapshot ALLOWS
 * (a value or colour the server named but did not allow — a pin — is never
 * offered), each with its words, grouped by option group.
 */
export function itemNeeds(item: GiftItemView): ItemNeeds {
  const allowedValues = new Set(item.allowed_option_value_ids ?? []);
  const allowedColors = new Set(item.allowed_color_ids ?? []);
  const options = item.choices?.options ?? [];
  const groups: GiftChoiceGroup[] = [];
  const pinnedByGroup: Record<string, string> = {};
  for (const o of options) {
    if (o.pinned || (item.option_value_ids ?? []).includes(o.id)) {
      if (o.group_id) pinnedByGroup[o.group_id] = o.id;
      continue;
    }
    if (!allowedValues.has(o.id)) continue;
    let g = groups.find((x) => x.id === o.group_id);
    if (!g) {
      g = { id: o.group_id, name: o.group_name ?? '', values: [] };
      groups.push(g);
    }
    if (!g.values.some((v) => v.id === o.id)) g.values.push(o);
  }
  // A pinned colour wins over any list (the server refuses another one).
  const colors = item.color_id ? [] : (item.choices?.colors ?? []).filter((c) => !c.pinned && allowedColors.has(c.id));
  const namedValues = new Set(groups.flatMap((g) => g.values.map((v) => v.id)));
  const namedColors = new Set(colors.map((c) => c.id));
  const unnamed =
    [...allowedValues].some((id) => !namedValues.has(id)) ||
    (!item.color_id && [...allowedColors].some((id) => !namedColors.has(id)));
  return { groups, colors, pinnedByGroup, unnamed };
}

/**
 * A colour with option links is offered only beside a selection it belongs
 * to: for every group it links, the selected value of that group (a pin or a
 * pick) must be one of its linked values. A colour without links fits any.
 */
export function colorFits(color: GiftChoiceColor, selectedByGroup: Readonly<Record<string, string>>): boolean {
  const byGroup = new Map<string, Set<string>>();
  for (const l of color.links ?? []) {
    const set = byGroup.get(l.group_id) ?? new Set<string>();
    set.add(l.option_value_id);
    byGroup.set(l.group_id, set);
  }
  for (const [group, values] of byGroup) {
    const selected = selectedByGroup[group];
    if (!selected || !values.has(selected)) return false;
  }
  return true;
}

/** True when the customer may still change the item or a pick (never for a gift the admin fixed). */
export function giftIsChangeable(gift: GiftView): boolean {
  if (gift.grant_mode !== 'level') return false;
  const items = Array.isArray(gift.items) ? gift.items : [];
  if (items.length > 1) return true;
  return items.length === 1 && itemHasPicks(items[0]);
}

function saleLabel(lang: GiftLang, sale: string, transport: string): string {
  if (sale === 'pre_order') {
    const route = transport === 'air' || transport === 'sea' || transport === 'land' ? shippingTypeLabel(`preorder_${transport}`, lang) : '';
    return route || giftText(lang, 'salePreorder');
  }
  return giftText(lang, 'saleDirect');
}

/** The order's status as a chip tone: the word carries it, the tint repeats it. */
function orderTone(status: string): Tone {
  if (status === 'delivered') return 'success';
  if (status === 'cancelled') return 'danger';
  if (status === 'pending') return 'warning';
  return 'info';
}

// ------------------------------------------------------------ small pieces

function Thumb({ src, alt, size }: { src: string; alt: string; size: 'sm' | 'md' | 'lg' }) {
  const box = size === 'lg' ? 'w-20 h-20 rounded-xl' : size === 'md' ? 'w-12 h-12 rounded-xl' : 'w-10 h-10 rounded-lg';
  return (
    <div className={`${box} shrink-0 overflow-hidden bg-surface-raised`}>
      <SafeImage src={src} alt={alt} aspect="auto" className="w-full h-full" bgClassName="bg-surface-raised" fallbackClassName="text-text-muted" />
    </div>
  );
}

function CardHeader({
  lang,
  printer,
  state,
  level,
  stateText,
}: {
  lang: GiftLang;
  printer: GiftView['printer'];
  state: GiftUiState;
  level: number;
  /** A finer word for the state chip than the state's own (the pending card's «بانتظار تعديلك»). */
  stateText?: string;
}) {
  const name = printerName(printer);
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
      <Thumb src={printer?.image ?? ''} alt={name} size="md" />
      <div className="min-w-0">
        <p className="text-[15px] font-semibold leading-snug text-text-primary line-clamp-2">{name}</p>
        <p className="text-[12px] leading-relaxed text-text-muted">{giftText(lang, 'printerGiftFor')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <StatusChip tone={stateText ? 'warning' : STATE_TONE[state] ?? 'neutral'}>{stateText || giftStateLabel(lang, state)}</StatusChip>
          {level > 0 && (
            <StatusChip tone="neutral" dot={false} icon={<Gift aria-hidden="true" className="w-3.5 h-3.5 text-gold" />}>
              {giftText(lang, 'levelChip', { level })}
            </StatusChip>
          )}
        </div>
      </div>
    </div>
  );
}

/** The sentence that names where the gift is, with the icon that repeats it. */
function StateTitle({ id, icon, text, tone }: { id: string; icon: React.ReactNode; text: string; tone: 'gold' | 'success' | 'info' | 'muted' | 'warning' }) {
  const color =
    tone === 'gold' ? 'text-gold' : tone === 'success' ? 'text-success' : tone === 'info' ? 'text-info' : tone === 'warning' ? 'text-warning' : 'text-text-muted';
  return (
    <h3 id={id} className="flex items-start gap-2 text-[16px] font-bold leading-snug text-text-primary">
      <span aria-hidden="true" className={`mt-0.5 shrink-0 ${color}`}>
        {icon}
      </span>
      <span className="min-w-0">{text}</span>
    </h3>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5">
      <dt className="text-text-muted">{label}:</dt>
      <dd className="min-w-0 text-text-secondary">{children}</dd>
    </div>
  );
}

function Swatch({ hex }: { hex: string }) {
  if (!hex) return null;
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 shrink-0 rounded-full border border-border-subtle align-middle"
      style={{ backgroundColor: hex }}
    />
  );
}

/**
 * THE GIFT ITSELF: picture, product, level, sale type, option, colour and
 * every other pick — the facts the brief lists for «جاهزة للطلب» and for the
 * ordered card. The words are the snapshot's (frozen at issue), so a later
 * edit of the product never rewrites what was granted.
 */
export function GiftItemDetails({ gift, item }: { gift: GiftView; item: GiftItemView }) {
  const { lang: rawLang } = useLanguage();
  const lang = giftLang(rawLang);
  const chosen = gift.chosen && gift.chosen.ref === item.ref ? gift.chosen : null;
  const shown: Partial<GiftItemDisplay> = { ...item.display, ...(chosen?.display ?? {}) };
  const name = giftProductName(shown) || giftProductName(item.display);
  const variant = labelOf(lang, { name_ar: shown.variant_ar, name_en: shown.variant_en, name_ckb: shown.variant_ckb });

  // The customer's own picks, named from the snapshot's choice words — only
  // when the frozen display does not already describe the final selection.
  const pins = new Set(item.option_value_ids ?? []);
  const pickRows: Array<{ group: string; value: string }> = [];
  let pickedColor: GiftChoiceColor | null = null;
  if (chosen && !chosen.display) {
    for (const id of chosen.option_value_ids ?? []) {
      if (pins.has(id)) continue;
      const o = (item.choices?.options ?? []).find((x) => x.id === id);
      if (o) pickRows.push({ group: (o.group_name ?? '').trim() || giftText(lang, 'optionLabel'), value: labelOf(lang, o) });
    }
    if (chosen.color_id && chosen.color_id !== item.color_id) {
      pickedColor = (item.choices?.colors ?? []).find((c) => c.id === chosen.color_id) ?? null;
    }
  }
  const colorName = pickedColor
    ? labelOf(lang, pickedColor)
    : labelOf(lang, { name_ar: shown.color_name_ar, name_en: shown.color_name, name_ckb: shown.color_name_ckb });
  const colorHex = pickedColor ? pickedColor.hex ?? '' : (shown.color_hex ?? '').trim();
  const sale = chosen?.sale_type ?? item.sale_type;
  const transport = chosen?.transport_method ?? item.transport_method;

  return (
    <div data-gift-item={item.ref} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-xl bg-surface-raised p-3">
      <Thumb src={shown.image || item.display?.image || ''} alt={name} size="lg" />
      <div className="min-w-0">
        <p className="text-[14px] font-semibold leading-snug text-text-primary">{name}</p>
        <dl className="mt-1.5 space-y-1 text-[12.5px] leading-relaxed">
          {gift.level > 0 && <Row label={giftText(lang, 'level')}>{gift.level}</Row>}
          <Row label={giftText(lang, 'saleType')}>{saleLabel(lang, sale, transport)}</Row>
          {variant && <Row label={giftText(lang, 'optionLabel')}>{variant}</Row>}
          {pickRows.map((r) => (
            <Row key={`${r.group}:${r.value}`} label={r.group}>
              {r.value}
            </Row>
          ))}
          {colorName && (
            <Row label={giftText(lang, 'colorLabel')}>
              <span className="inline-flex items-center gap-1.5">
                <Swatch hex={colorHex} />
                {colorName}
              </span>
            </Row>
          )}
        </dl>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- the chooser

function initialPicks(item: GiftItemView | null, chosen: GiftChosen | null): { values: Record<string, string>; color: string } {
  const values: Record<string, string> = {};
  let color = '';
  if (!item || !chosen || chosen.ref !== item.ref) return { values, color };
  const { groups, colors } = itemNeeds(item);
  for (const g of groups) {
    const hit = g.values.find((v) => (chosen.option_value_ids ?? []).includes(v.id));
    if (hit) values[g.id] = hit.id;
  }
  if (colors.some((c) => c.id === chosen.color_id)) color = chosen.color_id;
  return { values, color };
}

/**
 * «اختر هديتك»: one of the level's alternatives, then — inside it — only the
 * values and colours the snapshot allows. A group or a colour list with a
 * single allowed entry is already answered.
 */
export function GiftChooser({
  gift,
  busy,
  onConfirm,
  onCancel,
}: {
  gift: GiftView;
  busy?: boolean;
  onConfirm: (pick: GiftPick) => unknown;
  onCancel?: () => void;
}) {
  const { lang: rawLang } = useLanguage();
  const lang = giftLang(rawLang);
  const items = Array.isArray(gift.items) ? gift.items : [];
  const start = chosenItemOf(gift);
  const [ref, setRef] = useState<string>(start?.ref ?? (items.length === 1 ? items[0].ref : ''));
  const item = items.find((i) => i.ref === ref) ?? null;
  const [picks, setPicks] = useState(() => initialPicks(start, gift.chosen));

  const needs = item ? itemNeeds(item) : null;
  const valueOf = (g: GiftChoiceGroup) => picks.values[g.id] || (g.values.length === 1 ? g.values[0].id : '');
  const pickedValues = needs ? needs.groups.map(valueOf).filter(Boolean) : [];
  const selectedByGroup: Record<string, string> = { ...(needs?.pinnedByGroup ?? {}) };
  for (const g of needs?.groups ?? []) {
    const v = valueOf(g);
    if (v) selectedByGroup[g.id] = v;
  }
  const visibleColors = needs ? needs.colors.filter((c) => colorFits(c, selectedByGroup)) : [];
  const colorPick =
    picks.color && visibleColors.some((c) => c.id === picks.color)
      ? picks.color
      : visibleColors.length === 1
        ? visibleColors[0].id
        : '';
  const complete =
    !!item &&
    !!needs &&
    !needs.unnamed &&
    needs.groups.every((g) => !!valueOf(g)) &&
    (needs.colors.length === 0 || !!colorPick);

  const chooseItem = (next: string) => {
    if (next === ref) return;
    setRef(next);
    setPicks({ values: {}, color: '' });
  };

  const confirm = () => {
    if (!item || !complete || busy) return;
    return onConfirm({ ref: item.ref, optionValueIds: pickedValues, colorId: needs && needs.colors.length > 0 ? colorPick : '' });
  };

  return (
    <div className="space-y-4" data-gift-chooser={gift.id}>
      {items.length > 1 && (
        <div role="group" aria-label={giftText(lang, 'chooseHint')} className="grid gap-2 sm:grid-cols-2">
          {items.map((it) => {
            const name = giftProductName(it.display);
            const variant = labelOf(lang, { name_ar: it.display?.variant_ar, name_en: it.display?.variant_en, name_ckb: it.display?.variant_ckb });
            const colorWord = labelOf(lang, { name_ar: it.display?.color_name_ar, name_en: it.display?.color_name, name_ckb: it.display?.color_name_ckb });
            const selected = it.ref === ref;
            return (
              <button
                key={it.ref}
                type="button"
                aria-pressed={selected}
                data-gift-option={it.ref}
                onClick={() => chooseItem(it.ref)}
                className="lv-choice grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 p-2.5 text-start"
              >
                <Thumb src={it.display?.image ?? ''} alt={name} size="sm" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold leading-snug text-text-primary line-clamp-2">{name}</span>
                  <span className="block text-[12px] leading-snug text-text-muted">
                    {saleLabel(lang, it.sale_type, it.transport_method)}
                    {variant ? ` · ${variant}` : ''}
                    {colorWord ? ` · ${colorWord}` : ''}
                  </span>
                </span>
                <span className="lv-choice-mark" aria-hidden="true">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                </span>
              </button>
            );
          })}
        </div>
      )}

      {item && items.length === 1 && <GiftItemDetails gift={gift} item={item} />}

      {item && needs?.unnamed && (
        <p role="status" className="rounded-xl border border-border-subtle bg-surface-raised p-3 text-[13px] leading-relaxed text-warning">
          {giftText(lang, 'choicesUnavailable')}
        </p>
      )}

      {item &&
        needs &&
        !needs.unnamed &&
        needs.groups.map((g) => {
          const name = g.name.trim() || giftText(lang, 'optionLabel');
          const current = valueOf(g);
          return (
            <div key={g.id} role="group" aria-label={giftText(lang, 'chooseGroup', { name })}>
              <p className="text-[13px] font-semibold text-text-primary">{giftText(lang, 'chooseGroup', { name })}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {g.values.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    aria-pressed={current === v.id}
                    data-gift-value={v.id}
                    onClick={() => setPicks((p) => ({ ...p, values: { ...p.values, [g.id]: v.id } }))}
                    className="lv-choice inline-flex items-center gap-2 px-3 text-[13px]"
                  >
                    {labelOf(lang, v)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

      {item && needs && !needs.unnamed && visibleColors.length > 0 && (
        <div role="group" aria-label={giftText(lang, 'colorLabel')}>
          <p className="text-[13px] font-semibold text-text-primary">{giftText(lang, 'colorLabel')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {visibleColors.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={colorPick === c.id}
                data-gift-color={c.id}
                onClick={() => setPicks((p) => ({ ...p, color: c.id }))}
                className="lv-choice inline-flex items-center gap-2 px-3 text-[13px]"
              >
                <Swatch hex={c.hex ?? ''} />
                {labelOf(lang, c)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="primary"
          block
          disabled={!complete}
          loading={busy}
          loadingLabel={giftText(lang, 'confirming')}
          onClick={confirm}
          data-gift-confirm-choice={gift.id}
        >
          {giftText(lang, 'confirmChoice')}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {giftText(lang, 'cancel')}
          </Button>
        )}
      </div>
      {item && !complete && !needs?.unnamed && (
        <p className="text-[12px] leading-relaxed text-text-muted">{giftText(lang, 'pickFirst')}</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the card

export interface GiftCardProps {
  gift: GiftView;
  /** An action of this card is in flight. */
  busy?: boolean;
  /** The last refusal for this card, already a sentence. */
  error?: string;
  /** The last success line for this card. */
  notice?: string;
  /** Resolves true when the server accepted the code. */
  onRedeem?: (gift: GiftView, code: string) => Promise<boolean>;
  /** Resolves true when the server accepted the choice. */
  onChoose?: (gift: GiftView, pick: GiftPick) => Promise<boolean>;
  onAddToCart?: (gift: GiftView) => Promise<unknown>;
  /** The customer edited an input: the last refusal no longer describes it. */
  onEdit?: (giftId: string) => void;
  /** The sentence for a live orderability code (`orderable.code`), when known. */
  orderableText?: (code: string) => string;
}

export default function GiftCard({ gift, busy = false, error, notice, onRedeem, onChoose, onAddToCart, onEdit, orderableText }: GiftCardProps) {
  const { lang: rawLang } = useLanguage();
  const lang = giftLang(rawLang);
  const t = (key: GiftStringKey, vars?: Record<string, string | number>) => giftText(lang, key, vars);
  const [code, setCode] = useState('');
  const [changing, setChanging] = useState(false);
  const titleId = `gift-${gift.id}-title`;
  const item = chosenItemOf(gift);
  const state = gift.ui_state;

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = normalizeOtp(code);
    if (busy || clean.length !== 6 || !onRedeem) return;
    void onRedeem(gift, clean).then((ok) => {
      if (!ok) setCode('');
    });
  };

  const choose = async (pick: GiftPick) => {
    if (!onChoose) return;
    const ok = await onChoose(gift, pick);
    if (ok) setChanging(false);
  };

  const errorLine = error ? (
    <p role="alert" className="text-[13px] leading-relaxed text-danger">
      {error}
    </p>
  ) : null;
  const noticeLine = notice ? (
    <p role="status" className="flex items-center gap-1.5 text-[13px] leading-relaxed text-success">
      <CheckCircle2 aria-hidden="true" className="w-4 h-4 shrink-0" />
      {notice}
    </p>
  ) : null;

  let body: React.ReactNode = null;

  if (state === 'awaiting_code') {
    body = (
      <>
        <div className="space-y-1">
          <StateTitle id={titleId} icon={<Gift className="w-5 h-5" />} text={t('approvedTitle')} tone="gold" />
          <p className="text-[13px] leading-relaxed text-text-secondary">{t('codePrompt')}</p>
          <p className="text-[12px] leading-relaxed text-text-muted">{t('codeHint')}</p>
        </div>
        <form onSubmit={submitCode} noValidate className="space-y-3" data-gift-redeem={gift.id}>
          <OtpBoxes
            appearance="plain"
            value={code}
            onChange={(v) => {
              setCode(v);
              if (error) onEdit?.(gift.id);
            }}
            label={t('codeGroupLabel')}
            error={error || undefined}
            idPrefix={`gift-code-${gift.id}`}
            disabled={busy}
          />
          <Button
            type="submit"
            variant="primary"
            block
            disabled={normalizeOtp(code).length !== 6}
            loading={busy}
            loadingLabel={t('redeeming')}
            icon={<Gift aria-hidden="true" className="w-4 h-4" />}
          >
            {t('redeem')}
          </Button>
        </form>
      </>
    );
  } else if (state === 'locked') {
    body = (
      <>
        <div className="rounded-xl border border-border-subtle bg-surface-raised p-3">
          <StateTitle id={titleId} icon={<Lock className="w-5 h-5" />} text={t('lockedTitle')} tone="warning" />
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">{t('lockedBody')}</p>
        </div>
        <Link to="/support" className="lv-button lv-button-secondary w-full" data-gift-support={gift.id}>
          {t('contactSupport')}
        </Link>
      </>
    );
  } else if (state === 'choose_item' || (state === 'ready' && changing)) {
    body = (
      <>
        <div className="space-y-1">
          <StateTitle id={titleId} icon={<CheckCircle2 className="w-5 h-5" />} text={t('chooseTitle')} tone="success" />
          {(gift.items?.length ?? 0) > 1 && <p className="text-[13px] leading-relaxed text-text-secondary">{t('chooseHint')}</p>}
        </div>
        <GiftChooser gift={gift} busy={busy} onConfirm={choose} onCancel={state === 'ready' ? () => setChanging(false) : undefined} />
        {errorLine}
      </>
    );
  } else if (state === 'ready') {
    const blocked = gift.orderable && gift.orderable.ok === false;
    const why = blocked ? (gift.orderable?.code && orderableText ? orderableText(gift.orderable.code) : '') || t('notOrderableNow') : '';
    body = (
      <>
        <StateTitle id={titleId} icon={<CheckCircle2 className="w-5 h-5" />} text={t('readyTitle')} tone="success" />
        {item && <GiftItemDetails gift={gift} item={item} />}
        {!giftIsChangeable(gift) && <p className="text-[12px] leading-relaxed text-text-muted">{t('fixedChoice')}</p>}
        <p className="text-[12px] leading-relaxed text-text-muted">{t('freeNote')}</p>
        {blocked && (
          <p role="status" className="text-[13px] leading-relaxed text-warning">
            {why}
          </p>
        )}
        {errorLine}
        <Button
          variant="primary"
          block
          disabled={!!blocked}
          loading={busy}
          loadingLabel={t('adding')}
          icon={<ShoppingCart aria-hidden="true" className="w-4 h-4" />}
          onClick={() => onAddToCart?.(gift)}
          data-gift-add={gift.id}
        >
          {t('addToCart')}
        </Button>
        {giftIsChangeable(gift) && (
          <Button variant="ghost" size="sm" block disabled={busy} onClick={() => setChanging(true)} data-gift-change={gift.id}>
            {t('changeChoice')}
          </Button>
        )}
      </>
    );
  } else if (state === 'in_cart') {
    body = (
      <>
        <StateTitle id={titleId} icon={<ShoppingCart className="w-5 h-5" />} text={t('inCartTitle')} tone="info" />
        {item && <GiftItemDetails gift={gift} item={item} />}
        <p className="text-[13px] leading-relaxed text-text-secondary">{t('inCartBody')}</p>
        {noticeLine}
        <Link to="/cart" className="lv-button lv-button-secondary w-full" data-gift-cart={gift.id}>
          <ShoppingCart aria-hidden="true" className="w-4 h-4" />
          {t('goToCart')}
        </Link>
      </>
    );
  } else if (state === 'ordered' || state === 'delivered') {
    const delivered = state === 'delivered';
    const order = gift.order;
    body = (
      <>
        <StateTitle
          id={titleId}
          icon={delivered ? <CheckCircle2 className="w-5 h-5" /> : <Package className="w-5 h-5" />}
          text={t(delivered ? 'deliveredTitle' : 'orderedTitle')}
          tone={delivered ? 'success' : 'info'}
        />
        {item && <GiftItemDetails gift={gift} item={item} />}
        {order && (
          <dl className="space-y-1.5 text-[13px]">
            <Row label={t('orderNumber')}>
              <bdi dir="ltr" className="font-mono text-text-primary">
                {order.id}
              </bdi>
            </Row>
            <Row label={t('orderStatus')}>
              <StatusChip tone={orderTone(order.status)}>{statusLabel(lang, order.status)}</StatusChip>
            </Row>
          </dl>
        )}
        {delivered
          ? gift.fulfilled_at && <p className="text-[12px] text-text-muted">{t('deliveredOn', { date: formatDate(gift.fulfilled_at, lang) })}</p>
          : gift.ordered_at && <p className="text-[12px] text-text-muted">{t('orderedOn', { date: formatDate(gift.ordered_at, lang) })}</p>}
        {order && (
          <Link
            to={`/orders/${encodeURIComponent(order.id)}`}
            className={`lv-button ${delivered ? 'lv-button-secondary' : 'lv-button-primary'} w-full`}
            data-gift-order={order.id}
          >
            <Package aria-hidden="true" className="w-4 h-4" />
            {t('viewOrder')}
          </Link>
        )}
      </>
    );
  } else if (state === 'cancelled') {
    body = (
      <>
        <StateTitle id={titleId} icon={<XCircle className="w-5 h-5" />} text={t('cancelledTitle')} tone="muted" />
        <p className="text-[13px] leading-relaxed text-text-secondary">{t('cancelledBody')}</p>
        <Link to="/support" className="lv-button lv-button-ghost w-full" data-gift-support={gift.id}>
          {t('contactSupport')}
        </Link>
      </>
    );
  } else {
    // legacy: the earlier box program, read-only.
    const legacy = gift.legacy;
    const where = gift.fulfilled_at ? t('legacyFulfilled') : legacy?.chosen_level ? t('legacySelected') : t('legacyAvailable');
    const contents: unknown[] = Array.isArray(legacy?.contents) ? (legacy?.contents ?? []) : [];
    body = (
      <>
        <StateTitle id={titleId} icon={<Archive className="w-5 h-5" />} text={t('legacyTitle')} tone="muted" />
        <p className="text-[13px] leading-relaxed text-text-secondary">{t('legacyBody')}</p>
        <p className="text-[13px] font-semibold text-text-primary">{where}</p>
        {contents.length > 0 && (
          <div>
            <p className="text-[12px] text-text-muted">{t('legacyContents')}</p>
            <ul className="mt-1 space-y-1">
              {contents.map((raw, i) => {
                const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
                const base = labelOf(lang, {
                  name_ar: String(c.label_ar ?? ''),
                  name_en: String(c.label_en ?? ''),
                  name_ckb: String(c.label_ckb ?? ''),
                });
                const extras = [c.brand, c.material, c.color, c.option_value].filter((x) => typeof x === 'string' && x).join(' · ');
                return (
                  <li key={`${String(c.item_id ?? '')}:${i}`} className="flex items-center gap-2 text-[13px] text-text-secondary">
                    <Gift aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-gold" />
                    {extras ? `${base} (${extras})` : base}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </>
    );
  }

  return (
    <article
      data-gift-card={gift.id}
      data-ui-state={state}
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      className="rounded-2xl border border-border-subtle bg-surface p-4"
    >
      <CardHeader lang={lang} printer={gift.printer} state={state} level={gift.level} />
      <div className="mt-4 space-y-3" aria-live="polite">
        {body}
        {state !== 'in_cart' && noticeLine}
        {state !== 'choose_item' && state !== 'ready' && state !== 'awaiting_code' && errorLine}
      </div>
    </article>
  );
}

/**
 * The quiet card for a review still awaiting the admin («مراجعتك قيد اعتماد
 * الهدية»). No action — except when the admin asked for a change to the
 * review, which the customer can only make from the review itself.
 */
export function PendingGiftCard({ pending }: { pending: PendingGiftView }) {
  const { lang: rawLang } = useLanguage();
  const lang = giftLang(rawLang);
  const titleId = `gift-pending-${pending.reward_id}-title`;
  const revision = pending.reward_state === 'revision_needed';
  return (
    <article
      data-gift-card={pending.reward_id}
      data-ui-state="pending"
      aria-labelledby={titleId}
      className="rounded-2xl border border-border-subtle bg-surface p-4"
    >
      <CardHeader lang={lang} printer={pending.printer} state="pending" level={0} stateText={revision ? giftText(lang, 'stateRevision') : undefined} />
      <div className="mt-4 space-y-1.5">
        <StateTitle
          id={titleId}
          icon={<Clock className="w-5 h-5" />}
          text={giftText(lang, revision ? 'revisionTitle' : 'pendingTitle')}
          tone={revision ? 'warning' : 'muted'}
        />
        <p className="text-[13px] leading-relaxed text-text-secondary">{giftText(lang, revision ? 'revisionBody' : 'pendingBody')}</p>
        {pending.submitted_at && (
          <p className="text-[12px] text-text-muted">{giftText(lang, 'sentOn', { date: formatDate(pending.submitted_at, lang) })}</p>
        )}
      </div>
      {revision && (
        <Link to="/orders" className="lv-button lv-button-secondary mt-3 w-full" data-gift-orders={pending.reward_id}>
          {giftText(lang, 'emptyAction')}
        </Link>
      )}
    </article>
  );
}
