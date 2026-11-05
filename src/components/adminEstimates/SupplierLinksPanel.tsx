/**
 * «روابط المورّد» OF ONE PRODUCT — THE OWNER'S OWN LINKS BESIDE THE MATCHED
 * ONES (docs/SMART_PRICING.md §3.10; DECISIONS row 293; the owner's request
 * of 2026-11-05: «i need to save the link so i can easily track price from
 * supplier or on pre order item to order it or when i need to future buy on
 * inventory»).
 *
 * A lazy chunk of its own. Each host mounts it for the owner alone, on the
 * server's own hint read `=== true`, so no other admin downloads it or calls
 * its route:
 *   - the product form's section ٣ (PricesSectionV2.tsx), as a CARD: every
 *     link of the product, with add, edit and remove;
 *   - the purchase wizard's step 2, under each line's head, and each saved
 *     purchase line (ProcurementPanel.tsx), as a STRIP: the links of that
 *     stock row (its base, model, colour or variant), opened in one tap. A
 *     link is optional: it never blocks a purchase;
 *   - each pre-order line of an order (OrderDetailModal.tsx), as a STRIP: the
 *     links of the exact SKU bought.
 * The matched Tmall / EU facts (§3.9) of the same SKUs and his own prices are
 * listed under his links, with their price and date. A strip opens in one tap
 * only his links and CONFIRMED matches, and quotes the latest price of his own
 * or of a confirmed match, per unit as the estimate divides a pack: an
 * unconfirmed suggestion is never offered as where to buy, nor its price as
 * the supplier's, right beside the raw price he types. Nothing here writes a
 * price: «تحديث السعر» stays in the Links tab, one tap away.
 *
 * A link opens in a new tab with `rel="noopener noreferrer"` and no referrer,
 * so no admin address reaches the supplier. It is drawn as a link only when
 * the stored address reads back to exactly itself through the shared parser
 * (`safeOwnerLinkHref`); anything else is shown as text. Its host is always
 * shown, left to right and punycoded, so a look-alike host is visible.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, Link2, Plus } from 'lucide-react';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { useOptionalAuth } from '../../AuthContext';
import { ApiError, isAborted, type OrderItemSelection } from '../../lib/api';
import { safeOwnerLinkHref } from '../../../packages/catalog/src/supplierPrices/ownerLink';
import { unitPriceOf } from '../../../packages/catalog/src/supplierPrices/format';
import {
  fetchOwnerLinks,
  saveOwnerLinks,
  workspaceHref,
  type LinkSku,
  type OwnerLink,
  type OwnerLinksAnswer,
  type OwnerLinksScope,
  type SupplierLink,
} from './api';
import { ActNote, CopyButton, Failure, Ltr, SourceChip, SupplierAnchor, SupplierLinkRow, openItemText, skuName, useAct, useUiLang, type ActMessage } from './parts';
import OwnerLinkSheet, { type OwnerLinkSheetTarget } from './OwnerLinkSheet';
import { BANNER, COMMON, LINKS, OWNER_LINKS, WORKSPACE, say, type Tri, type UiLang } from './strings';
import { dayOf, moneyText, nameIn } from './format';

export type SupplierLinksContext = 'product' | 'purchase' | 'order';

/**
 * The exact SKU an order line bought, keyed as the cart keys it (the rule of
 * matchOrderCostSelection, worker/lib/inventorySelection.ts): its option values,
 * or its one option on an older line, and its colour — `skuComboKey`'s canonical
 * form (packages/pricing/src/skuChannel.ts; tests/supplierLinksUi.test.ts holds
 * the two equal). Written out here, in the owner's chunk, rather than imported:
 * the product page shares that module, and a new importer would split it into a
 * chunk of its own on the product's opening. The server checks the key again.
 */
export function orderLineComboKey(sel: Pick<OrderItemSelection, 'option_id' | 'option_value_ids' | 'color_id'>): string {
  const ids = sel.option_value_ids?.length ? sel.option_value_ids : sel.option_id ? [sel.option_id] : [];
  const parts = [...ids].filter(Boolean).sort().map((id) => `o:${id}`);
  if (sel.color_id) parts.push(`c:${sel.color_id}`);
  return parts.join('|');
}

export interface SupplierLinksPanelProps {
  productId: string;
  /** The SKUs the links are for: an order line's selection or exact SKU, a purchase line's stock row; none — the whole product. */
  scope?: OwnerLinksScope | { order_selection: OrderItemSelection } | null;
  /** The product form's card, or the compact strip of a purchase or an order line. */
  variant: 'card' | 'strip';
  context: SupplierLinksContext;
  /** A saved purchase line: the links to buy again, nothing to add or change there. */
  readOnly?: boolean;
}

/** The strip's heading: what the links are for, where they show. */
export function headingOf(context: SupplierLinksContext, readOnly: boolean): Tri {
  if (context === 'order') return OWNER_LINKS.orderFrom;
  if (context === 'purchase' && readOnly) return OWNER_LINKS.buyAgain;
  return OWNER_LINKS.title;
}

/** «للمنتج كله» or «لـ أحمر · مع بكرة»: what a link belongs to. */
export function appliesText(link: Pick<OwnerLink, 'combo_key' | 'labels'>, lang: UiLang): string {
  return link.combo_key === '' ? say(OWNER_LINKS.appliesWhole, lang) : say(OWNER_LINKS.appliesLabel, lang, { name: nameIn(link.labels, lang, link.combo_key) });
}

/**
 * The facts a strip trusts, each with its rank on the same day: his own price,
 * then a match confirmed by him, then one confirmed automatically — what the
 * estimate itself prices from (worker/lib/supplierPrices/store.ts). A
 * suggestion is unconfirmed and a rejected match is not his supplier's item:
 * neither is offered as where to buy, nor quoted as the supplier's price.
 */
const TRUSTED_RANK: Readonly<Partial<Record<SupplierLink['state'], number>>> = { manual: 0, confirmed: 1, auto: 2 };

/** A capture's or an entry's day, as text that sorts by time; '' when it carries none. */
const dayKey = (stamp: string | null): string => (stamp && /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : '');

/** The price a strip quotes beside the raw price he types, with what it is. */
export interface KnownPrice {
  /** One unit's price with its currency: a pack he divides is divided as the estimate divides it (`unitPriceOf`). */
  price: string;
  /** The units its offer is divided by (1: not a pack). */
  units: number;
  /** The words printed beside the price (Tmall: 优惠前), '' when none. */
  label: string;
  /** Its day: the capture's, or the day he entered his own price. */
  date: string;
  /** His own price (entered), not a capture. */
  entered: boolean;
  /** The supplier had none in stock at the capture. */
  outOfStock: boolean;
  /** The SKU it is the price of: named when the strip covers several. */
  sku: LinkSku;
}

/**
 * «آخر سعر معروف عند المورّد»: the most recent trusted price among the SKUs
 * read — his own, or a confirmed match's present in the newest capture — his
 * own first on the same day; null when none. Never a suggestion's, and never a
 * whole pack's price as if it were one unit's.
 */
export function lastKnownPrice(skus: readonly LinkSku[]): KnownPrice | null {
  let best: { sku: LinkSku; link: SupplierLink; unit: string; rank: number; day: string } | null = null;
  for (const sku of skus) {
    for (const link of sku.supplier_prices) {
      const rank = TRUSTED_RANK[link.state];
      if (rank === undefined || link.missing || !link.price || !link.currency) continue;
      let unit: string;
      try {
        unit = unitPriceOf(link.price, link.units_per_offer);
      } catch {
        // Not a price the estimate could read either: never quoted.
        continue;
      }
      const day = dayKey(link.captured_on);
      if (!best || day > best.day || (day === best.day && rank < best.rank)) best = { sku, link, unit, rank, day };
    }
  }
  if (!best) return null;
  return {
    price: moneyText(best.unit, best.link.currency),
    units: best.link.units_per_offer,
    label: best.link.price_label ?? '',
    date: dayOf(best.link.captured_on),
    entered: best.link.state === 'manual',
    outOfStock: best.link.quantity === 0,
    sku: best.sku,
  };
}

/**
 * Nothing to read rather than a failure: a 404. An older Worker without this
 * route answers its bare 404 (no code, worker/index.ts `app.notFound`), and a
 * product deleted since a purchase was saved answers NOT_FOUND. A retry would
 * never succeed, so a strip says nothing.
 */
export const isAbsentRead = (e: unknown): boolean => e instanceof ApiError && e.status === 404;
/** An older Worker without this route: its bare 404 carries no code. */
export const isRouteMissing = (e: unknown): boolean => isAbsentRead(e) && !(e as ApiError).code;

/**
 * One of his links in a new tab, without an opener or a referrer — only when
 * the stored address reads back to itself (`safeOwnerLinkHref`); else nothing.
 */
export function OwnerLinkAnchor({ href, label, lang }: { href: string | null | undefined; label: string; lang: UiLang }) {
  const safe = safeOwnerLinkHref(href);
  if (!safe) return null;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      data-owner-link-open={safe}
      className="inline-flex min-h-11 min-w-0 items-center gap-1.5 px-1 text-[13px] font-bold text-text-primary underline underline-offset-2"
    >
      <ExternalLink aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span dir="auto" className="min-w-0 break-words">
        {label}
      </span>
      <span className="sr-only">{say(LINKS.newTab, lang)}</span>
    </a>
  );
}

/**
 * ONE OF HIS LINKS: its name (or its host) opening the page, the host left to
 * right, the store when it is one the shop knows, what it belongs to, the
 * supplier and the note (its lines kept), when it was added or edited, a copy
 * button and his acts. A stored address that does not read back to itself is
 * shown as text.
 */
export function OwnerLinkRow({ link, lang, actions }: { link: OwnerLink; lang: UiLang; actions?: React.ReactNode }) {
  const href = safeOwnerLinkHref(link.url);
  const title = link.label || link.host;
  const store = link.source === 'other' ? null : link.source;
  const edited = link.updated_at !== '' && link.updated_at !== link.created_at;
  return (
    <li data-owner-link={link.id} data-owner-link-source={link.source} className="min-w-0 space-y-1 border-t border-border-subtle/60 py-2.5 first:border-t-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {href ? (
          <OwnerLinkAnchor href={href} label={title} lang={lang} />
        ) : (
          <span dir="auto" className="min-w-0 break-words text-[13px] font-bold text-text-primary">
            {title}
          </span>
        )}
        <Ltr className="break-all text-[12px] text-text-muted">{link.host}</Ltr>
        {store ? <SourceChip source={store} lang={lang} /> : null}
      </div>
      <p className="break-words text-[12px] text-text-secondary">{appliesText(link, lang)}</p>
      {link.supplier_name ? (
        <p dir="auto" className="break-words text-[12px] text-text-secondary">
          {say(OWNER_LINKS.supplierName, lang, { name: link.supplier_name })}
        </p>
      ) : null}
      {link.note ? (
        <p dir="auto" className="whitespace-pre-line break-words text-[12px] text-text-muted" data-owner-link-note>
          {say(LINKS.note, lang, { note: link.note })}
        </p>
      ) : null}
      {href ? null : (
        <p className="break-words text-[12px] font-semibold text-warning" data-owner-link-unsafe>
          {say(OWNER_LINKS.unsafe, lang)} <Ltr className="break-all font-mono font-normal">{link.url}</Ltr>
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[11px] text-text-muted">{say(edited ? OWNER_LINKS.edited : OWNER_LINKS.added, lang, { date: dayOf(edited ? link.updated_at : link.created_at) })}</span>
        <CopyButton value={link.url} what={say(OWNER_LINKS.url, lang)} lang={lang} />
        {actions}
      </div>
    </li>
  );
}

/** The matched Tmall / EU / US facts (§3.9) and his own prices of the SKUs read, each SKU named when there are several. */
function MatchedList({ skus, lang }: { skus: readonly LinkSku[]; lang: UiLang }) {
  if (!skus.length) return null;
  return (
    <div className="space-y-2" data-supplier-links-matched>
      <p className="text-[12px] font-bold text-text-secondary">{say(OWNER_LINKS.matched, lang)}</p>
      {skus.map((s) => (
        <div key={s.combo_key || '_'} className="min-w-0 rounded-xl bg-surface p-2.5">
          {skus.length > 1 || s.combo_key !== '' ? (
            <p dir="auto" className="break-words text-[12px] font-bold text-text-primary">
              {skuName(s, lang)}
            </p>
          ) : null}
          <ul>
            {s.supplier_prices.map((l, i) => (
              <SupplierLinkRow key={`${l.source}-${l.item_key ?? 'manual'}-${l.sku_key ?? ''}-${i}`} link={l} lang={lang} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Up to three pages to open at once in a strip: his links first, then the
 * items of CONFIRMED matches (by him or automatically). A suggestion waits for
 * his review in the full list, with its state said; it is never one tap away
 * as where to buy.
 */
export function quickLinks(own: readonly OwnerLink[], skus: readonly LinkSku[], max = 3): Array<{ kind: 'owner'; link: OwnerLink } | { kind: 'matched'; link: SupplierLink; href: string }> {
  const out: Array<{ kind: 'owner'; link: OwnerLink } | { kind: 'matched'; link: SupplierLink; href: string }> = [];
  const seen = new Set<string>();
  for (const l of own) {
    if (out.length >= max) return out;
    const href = safeOwnerLinkHref(l.url);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push({ kind: 'owner', link: l });
  }
  for (const s of skus) {
    for (const l of s.supplier_prices) {
      if (out.length >= max) return out;
      if (l.state !== 'confirmed' && l.state !== 'auto') continue;
      const href = l.sku_url ?? l.item_url;
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push({ kind: 'matched', link: l, href });
    }
  }
  return out;
}

export interface SupplierLinksViewProps {
  answer: OwnerLinksAnswer;
  variant: 'card' | 'strip';
  context: SupplierLinksContext;
  lang: UiLang;
  dir: 'rtl' | 'ltr';
  /** His acts are offered (the session's own write hint, and not a saved purchase line). */
  canWrite: boolean;
  readOnly?: boolean;
  /** A strip's full list is open. */
  open?: boolean;
  onToggle?: () => void;
  onAdd?: (comboKey: string) => void;
  onEdit?: (link: OwnerLink) => void;
  onRemove?: (link: OwnerLink) => void;
  busy?: string | null;
  message?: ActMessage | null;
  /** The heading, focusable by script: the keyboard lands there when a removed link's row goes. */
  headingRef?: (el: HTMLElement | null) => void;
}

/** What the panel draws for a read: pure, so every state is rendered the same in a test. */
export function SupplierLinksView({ answer, variant, context, lang, dir, canWrite, readOnly = false, open = false, onToggle, onAdd, onEdit, onRemove, busy = null, message = null, headingRef }: SupplierLinksViewProps) {
  const product = answer.product;
  const own = product.supplier_links;
  const writable = canWrite && !readOnly && answer.installed;
  const acts = (l: OwnerLink) => {
    if (!writable) return null;
    // Every row has the same two words: each button is named by its link, so a screen reader can tell them apart.
    const name = l.label || l.host;
    return (
      <>
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => onEdit?.(l)} aria-label={say(OWNER_LINKS.editNamed, lang, { name })} data-owner-link-edit={l.id}>
          {say(OWNER_LINKS.edit, lang)}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={busy === `remove:${l.id}`}
          disabled={!!busy && busy !== `remove:${l.id}`}
          onClick={() => onRemove?.(l)}
          aria-label={say(OWNER_LINKS.removeNamed, lang, { name })}
          data-owner-link-remove={l.id}
        >
          {say(OWNER_LINKS.remove, lang)}
        </Button>
      </>
    );
  };
  const addButton = writable ? (
    <Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" className="h-4 w-4" />} disabled={!!busy} onClick={() => onAdd?.(answer.scope_key)} data-owner-link-add>
      {say(OWNER_LINKS.add, lang)}
    </Button>
  ) : null;
  const notInstalled =
    !answer.installed && canWrite && !readOnly ? (
      <p role="status" className="lv-alert lv-alert-info text-[12px] leading-relaxed text-text-primary" data-supplier-links-not-installed>
        {say(OWNER_LINKS.notInstalled, lang)}
      </p>
    ) : null;
  const ownList = own.length ? (
    <ul data-supplier-links-own>
      {own.map((l) => (
        <OwnerLinkRow key={l.id} link={l} lang={lang} actions={acts(l)} />
      ))}
    </ul>
  ) : null;

  if (variant === 'card') {
    return (
      <section dir={dir} className="lv-surface mb-3 min-w-0 space-y-3 p-3" data-supplier-links={context} data-supplier-links-installed={answer.installed ? '1' : '0'}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link2 aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
          <h3 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 text-[14px] font-bold text-text-primary outline-none" data-supplier-links-heading>
            {say(OWNER_LINKS.title, lang)}
          </h3>
          {addButton}
        </div>
        <p className="text-[12px] leading-relaxed text-text-secondary">{say(OWNER_LINKS.intro, lang)}</p>
        {notInstalled}
        <div className="min-w-0 space-y-1">
          <p className="text-[12px] font-bold text-text-secondary">{say(OWNER_LINKS.yours, lang)}</p>
          {ownList ?? <p className="text-[12px] text-text-muted">{say(OWNER_LINKS.none, lang)}</p>}
        </div>
        <ActNote message={message} />
        {product.skus.length ? (
          <button type="button" className="inline-flex min-h-11 items-center gap-1 px-1 text-[13px] font-bold text-text-primary underline underline-offset-2" aria-expanded={open} onClick={onToggle} data-supplier-links-toggle>
            {say(BANNER.links, lang, { n: product.skus.reduce((n, s) => n + s.supplier_prices.length, 0) })}
            <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        ) : null}
        {open ? <MatchedList skus={product.skus} lang={lang} /> : null}
        <a href={workspaceHref('links', product.product_id)} className="inline-flex min-h-11 items-center px-1 text-[13px] font-bold text-text-primary underline underline-offset-2" data-supplier-links-workspace>
          {say(BANNER.allLinks, lang)}
        </a>
      </section>
    );
  }

  const quick = quickLinks(own, product.skus);
  const total = own.length + product.skus.reduce((n, s) => n + s.supplier_prices.length, 0);
  const price = lastKnownPrice(product.skus);
  return (
    <div dir={dir} className="min-w-0 space-y-1.5 rounded-xl bg-surface-raised p-2.5" data-supplier-links={context} data-supplier-links-installed={answer.installed ? '1' : '0'}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Link2 aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        <span ref={headingRef} tabIndex={-1} className="text-[12px] font-bold text-text-primary outline-none" data-supplier-links-heading>
          {say(headingOf(context, readOnly), lang)}
        </span>
        {quick.map((q) =>
          q.kind === 'owner' ? (
            <OwnerLinkAnchor key={`o-${q.link.id}`} href={q.link.url} label={q.link.label || q.link.host} lang={lang} />
          ) : (
            <SupplierAnchor key={`m-${q.href}`} href={q.href} label={openItemText(q.link.source, lang)} lang={lang} />
          )
        )}
      </div>
      {price ? (
        // Beside the raw unit price he types: one unit's price, with what it is (a pack divided, the price's own words, his or a capture, its day).
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] text-text-muted" data-supplier-links-price>
          <span>{say(OWNER_LINKS.lastPrice, lang)}:</span>
          <Ltr className="font-bold text-text-primary">{price.price}</Ltr>
          {price.label ? <span dir="auto">{price.label}</span> : null}
          {price.units > 1 ? (
            <span className="font-semibold text-warning" data-supplier-links-price-units>
              {say(LINKS.unitsDivided, lang, { n: price.units })}
            </span>
          ) : null}
          <span>{say(price.entered ? LINKS.entered : LINKS.captured, lang, { date: price.date })}</span>
          {price.outOfStock ? <span className="font-semibold text-warning">{say(LINKS.outOfStock, lang)}</span> : null}
          {product.skus.length > 1 ? <span dir="auto">{say(OWNER_LINKS.appliesLabel, lang, { name: skuName(price.sku, lang) })}</span> : null}
        </p>
      ) : null}
      {notInstalled}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {total > 0 ? (
          <button type="button" className="inline-flex min-h-11 items-center gap-1 px-1 text-[12px] font-bold text-text-primary underline underline-offset-2" aria-expanded={open} onClick={onToggle} data-supplier-links-toggle>
            {open ? say(OWNER_LINKS.showLess, lang) : say(OWNER_LINKS.showAll, lang, { n: total })}
            <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        ) : (
          <span className="text-[12px] text-text-muted">{say(LINKS.noLinkForSku, lang)}</span>
        )}
        {addButton}
      </div>
      <ActNote message={message} />
      {open ? (
        <div className="min-w-0 space-y-2">
          {ownList}
          <MatchedList skus={product.skus} lang={lang} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the panel draws when its read failed. A strip beside a purchase or an
 * order line says nothing when there is nothing to read (an older Worker, a
 * product gone since), and a short retry otherwise. The card says the calm
 * «not on this server yet» when the Worker is older than this screen, and the
 * refusal or a retry otherwise — never a red refusal for a route not there yet.
 */
export function SupplierLinksFailure({
  error,
  variant,
  context,
  lang,
  dir,
  canWrite,
  onRetry,
}: {
  error: unknown;
  variant: 'card' | 'strip';
  context: SupplierLinksContext;
  lang: UiLang;
  dir: 'rtl' | 'ltr';
  canWrite: boolean;
  onRetry: () => void;
}) {
  if (variant === 'strip') {
    if (isAbsentRead(error)) return null;
    return (
      <p dir={dir} className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-text-muted" data-supplier-links={context} data-supplier-links-error>
        {say(OWNER_LINKS.title, lang)}: {say(COMMON.loadFailed, lang)}
        <Button size="sm" variant="ghost" onClick={onRetry}>
          {say(COMMON.retry, lang)}
        </Button>
      </p>
    );
  }
  if (isRouteMissing(error)) {
    if (!canWrite) return null;
    return (
      <section dir={dir} className="lv-surface mb-3 min-w-0 space-y-2 p-3" data-supplier-links={context} data-supplier-links-installed="0">
        <p className="text-[14px] font-bold text-text-primary">{say(OWNER_LINKS.title, lang)}</p>
        <p role="status" className="lv-alert lv-alert-info text-[12px] leading-relaxed text-text-primary" data-supplier-links-not-installed>
          {say(OWNER_LINKS.notInstalled, lang)}
        </p>
      </section>
    );
  }
  return (
    <section dir={dir} className="lv-surface mb-3 min-w-0 space-y-2 p-3" data-supplier-links={context} data-supplier-links-error>
      <p className="text-[14px] font-bold text-text-primary">{say(OWNER_LINKS.title, lang)}</p>
      <Failure error={error} lang={lang} onRetry={onRetry} listRead={false} />
    </section>
  );
}

/** The panel: reads its links, holds the sheet and his acts. */
export default function SupplierLinksPanel({ productId, scope = null, variant, context, readOnly = false }: SupplierLinksPanelProps) {
  const { lang, dir } = useUiLang();
  // Fail closed: only the session's own write hint offers an act (the server refuses any other caller regardless).
  const canWrite = useOptionalAuth()?.user?.can_write_cost === true && !readOnly;
  const comboKey = scope && 'order_selection' in scope ? orderLineComboKey(scope.order_selection) : scope && 'combo_key' in scope ? scope.combo_key : null;
  const stockScope = scope && 'scope' in scope ? scope.scope : null;
  const stockId = scope && 'scope' in scope ? scope.scope_id : '';
  const [answer, setAnswer] = useState<OwnerLinksAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<OwnerLinkSheetTarget | null>(null);
  const [confirm, dialog] = useConfirm();
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  const act = useAct(lang, refresh);
  const heading = useRef<HTMLElement | null>(null);
  const setHeading = useCallback((el: HTMLElement | null) => {
    heading.current = el;
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const want: OwnerLinksScope | null = comboKey !== null ? { combo_key: comboKey } : stockScope ? { scope: stockScope, scope_id: stockId } : null;
    setError(null);
    fetchOwnerLinks(productId, want, { signal: ac.signal, mascot: 'silent' })
      .then((a) => {
        if (!ac.signal.aborted) setAnswer(a);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted && !isAborted(e)) setError(e);
      });
    return () => ac.abort();
  }, [productId, comboKey, stockScope, stockId, reload]);

  const remove = useCallback(
    async (link: OwnerLink) => {
      if (!answer) return;
      const yes = await confirm({
        title: say(OWNER_LINKS.removeAsk, lang),
        consequence: say(OWNER_LINKS.removeBody, lang),
        confirmLabel: say(OWNER_LINKS.remove, lang),
        cancelLabel: say(COMMON.cancel, lang),
        destructive: true,
      });
      if (!yes) return;
      await act.run(`remove:${link.id}`, () => saveOwnerLinks(answer.product.product_id, { version: answer.product.versions.links, remove: [link.id] }), () => {
        refresh();
        // The removed row goes with the reload, and the keyboard with it: it lands on the panel's heading instead of the page's top.
        heading.current?.focus();
        return { tone: 'success', text: say(OWNER_LINKS.removed, lang) };
      });
    },
    [answer, act, confirm, lang, refresh]
  );

  const sheetVersion = answer?.product.versions.links ?? '';
  const choices = useMemo(() => answer?.product.choices ?? [], [answer]);

  if (error) return <SupplierLinksFailure error={error} variant={variant} context={context} lang={lang} dir={dir} canWrite={canWrite} onRetry={refresh} />;
  if (!answer) {
    return variant === 'card' ? (
      <p className="mb-3 text-[12px] text-text-muted" data-supplier-links={context} data-supplier-links-loading>
        {say(WORKSPACE.loading, lang)}
      </p>
    ) : null;
  }
  return (
    <>
      <SupplierLinksView
        answer={answer}
        variant={variant}
        context={context}
        lang={lang}
        dir={dir}
        canWrite={canWrite}
        readOnly={readOnly}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        // The line's own key when the product still offers it; else the whole product.
        onAdd={(key) => setSheet({ link: null, comboKey: choices.some((c) => c.combo_key === key) ? key : '' })}
        onEdit={(link) => setSheet({ link, comboKey: link.combo_key })}
        onRemove={(link) => void remove(link)}
        busy={act.busy}
        message={act.message}
        headingRef={setHeading}
      />
      <OwnerLinkSheet
        productId={answer.product.product_id}
        version={sheetVersion}
        choices={choices}
        target={sheet}
        onClose={() => setSheet(null)}
        onSaved={() => {
          setSheet(null);
          act.setMessage({ tone: 'success', text: say(OWNER_LINKS.saved, lang) });
          refresh();
        }}
        onStale={refresh}
      />
      {dialog}
    </>
  );
}
