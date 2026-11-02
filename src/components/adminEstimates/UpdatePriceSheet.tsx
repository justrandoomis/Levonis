/**
 * «تحديث السعر» — THE OWNER UPDATES ONE SUPPLIER PRICE (docs/SMART_PRICING.md
 * §3.6, §3.7, §3.9).
 *
 * Opened on one product and one of its SKUs, from the Links tab, the Review
 * grid or a product's row:
 *   - MANUAL ENTRY, for any source: the price he saw, in USD, EUR or CNY (the
 *     link's own currency selected), for this option or — an explicit act,
 *     stored as typed with the note «مثل …» — for every option of the product
 *     (`PUT /supplier-prices/manual/:product_id`, fenced on the manual token
 *     the view carried). His price comes before any capture (§3.7) until he
 *     removes it;
 *   - THE ONE-PAGE STORE READ, for an EU or US link: that page read once now
 *     (`POST /supplier-prices/read-store-page`), its price saved in the page's
 *     own currency for these SKUs. The server rebuilds the address from the
 *     handle and id; a page the store refuses or challenges saves nothing.
 *     On a sale page the regular price is saved, and he is told the page is
 *     on sale and which price was saved (the sale price is never saved). A
 *     page that gives the option several prices saves nothing, and he is told
 *     that, not that the page could not be read.
 *   - Tmall is never fetched: he taps the link (the Tmall app opens on a
 *     phone), reads the price and types it.
 * Every figure travels as decimal TEXT; nothing is computed here.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Field, Input, Select } from '../ui/Field';
import { Segmented } from '../ui/Segmented';
import {
  SOURCE_CURRENCY,
  SUPPLIER_CURRENCIES,
  isStoreCopiesDisagree,
  linkStore,
  readStorePage,
  setManualPrices,
  storeCopiesDisagree,
  type ProductLinks,
  type StorePageRead,
  type SupplierCurrency,
  type SupplierLink,
} from './api';
import { decimalText, noteText } from './input';
import { ActNote, Ltr, SheetFrame, SupplierAnchor, skuName, useAct, useUiLang, type ActMessage } from './parts';
import { LINKS, PRICE_SHEET, say, type UiLang } from './strings';
import { moneyText } from './format';

export interface PriceTarget {
  product: ProductLinks;
  comboKey: string;
  /** The supplier fact «تحديث السعر» was pressed on: its currency is preselected, a store link is read. */
  link: SupplierLink | null;
}

const STORE_HOSTS = new Set(['eu.store.bambulab.com', 'us.store.bambulab.com']);

/** A Bambu Lab EU or US store product address (the server checks it again and rebuilds it). */
export function isStoreProductUrl(raw: string): boolean {
  try {
    const u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    return STORE_HOSTS.has(u.hostname.toLowerCase()) && /\/products\/[^/]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

export default function UpdatePriceSheet({ target, onClose, onSaved }: { target: PriceTarget | null; onClose: () => void; onSaved: (productId: string) => void }) {
  const { lang, dir } = useUiLang();
  const act = useAct(lang);
  const product = target?.product ?? null;
  const sku = useMemo(() => product?.skus.find((s) => s.combo_key === target?.comboKey) ?? null, [product, target?.comboKey]);
  const manual = sku?.supplier_prices.find((l) => l.state === 'manual') ?? null;
  const [scope, setScope] = useState<'one' | 'all'>('one');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<SupplierCurrency>('CNY');
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; note?: string; url?: string }>({});
  const [read, setRead] = useState<{ answer: StorePageRead; saved: number } | null>(null);

  // A new target starts the sheet over: his price shown, the link's currency chosen, the link's page proposed.
  // The same target read again after a save (its product refreshed) keeps the sheet and its answer.
  const targetKey = target ? [target.product.product_id, target.comboKey, target.link?.source, target.link?.item_key, target.link?.sku_key, target.link?.state].join('\u0000') : '';
  useEffect(() => {
    if (!target) return;
    const m = target.product.skus.find((s) => s.combo_key === target.comboKey)?.supplier_prices.find((l) => l.state === 'manual') ?? null;
    const from = target.link && linkStore(target.link.source);
    setScope('one');
    setAmount(m?.price ?? '');
    setCurrency(m?.currency ?? (from ? SOURCE_CURRENCY[from] : (target.link?.currency ?? 'CNY')));
    setNote(m?.note ?? '');
    setUrl(from === 'bambu_eu' || from === 'bambu_us' ? (target.link?.sku_url ?? target.link?.item_url ?? '') : '');
    setErrors({});
    setRead(null);
    act.setMessage(null);
    // Keyed on the target's identity, not its object: `act.setMessage` is a state setter (stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  if (!target || !product) return null;
  const many = product.skus.length > 1;
  const focusName = sku ? skuName(sku, lang) : say(PRICE_SHEET.oneSku, lang);
  const keys = scope === 'all' ? product.skus.map((s) => s.combo_key) : [target.comboKey];

  const saveManual = async () => {
    const amountText = decimalText(amount);
    const noteClean = noteText(note);
    const next: typeof errors = {};
    if (amountText === '') next.amount = say(PRICE_SHEET.amountRequired, lang);
    else if (amountText === null) next.amount = say(PRICE_SHEET.amountInvalid, lang);
    if (noteClean === null) next.note = say(PRICE_SHEET.noteInvalid, lang);
    setErrors(next);
    if (next.amount || next.note || !amountText || noteClean === null) return;
    // «السعر نفسه لكل الخيارات» is the owner's explicit act: every other option is stored as typed, with «مثل …».
    const sameAs = (noteClean || say(PRICE_SHEET.sameAsNote, lang, { sku: focusName })).slice(0, 300);
    await act.run(
      'manual',
      () =>
        setManualPrices(product.product_id, {
          version: product.versions.manual,
          skus: keys.map((k) => ({ combo_key: k, amount: amountText, currency, note: k === target.comboKey ? noteClean : sameAs })),
        }),
      () => {
        onSaved(product.product_id);
        return { tone: 'success', text: say(PRICE_SHEET.saved, lang, { price: moneyText(amountText, currency) }) };
      }
    );
  };

  const removeManual = async () => {
    await act.run(
      'remove',
      () => setManualPrices(product.product_id, { version: product.versions.manual, skus: [{ combo_key: target.comboKey, amount: null, currency: null, note: '' }] }),
      () => {
        onSaved(product.product_id);
        setAmount('');
        setNote('');
        return { tone: 'success', text: say(PRICE_SHEET.removed, lang) };
      }
    );
  };

  const readPage = async (save: boolean) => {
    if (!isStoreProductUrl(url)) {
      setErrors({ url: say(PRICE_SHEET.urlInvalid, lang) });
      return;
    }
    setErrors({});
    setRead(null);
    await act.run(
      save ? 'read-save' : 'read',
      // A save refused because the page gives this option several prices (null here) is told as such below.
      () =>
        readStorePage({ url: url.trim(), ...(save ? { save: { product_id: product.product_id, combo_keys: keys } } : {}) }).catch((e: unknown) => {
          if (isStoreCopiesDisagree(e)) return null;
          throw e;
        }),
      (answer) => {
        if (!answer) return { tone: 'danger', text: say(PRICE_SHEET.copiesDisagree, lang) };
        setRead({ answer: answer.supplier_prices, saved: answer.saved });
        const chosen = answer.supplier_prices.offers.find((o) => o.sku_key === answer.supplier_prices.chosen_sku_key) ?? null;
        if (answer.saved > 0) onSaved(product.product_id);
        const savedNote = save ? storeSavedNote(answer.supplier_prices, lang) : null;
        if (savedNote) return savedNote;
        if (storeCopiesDisagree(answer.supplier_prices)) return { tone: 'warning', text: say(PRICE_SHEET.copiesDisagree, lang) };
        if (!chosen && answer.supplier_prices.offers.length > 1) return { tone: 'warning', text: say(PRICE_SHEET.noOffer, lang) };
        return { tone: 'success', text: say(PRICE_SHEET.storeRead, lang, { host: answer.supplier_prices.host }) };
      }
    );
  };

  return (
    <SheetFrame open={!!target} onClose={onClose} title={say(PRICE_SHEET.title, lang, { sku: focusName })} lang={lang} dir={dir} testId="estimate-price-sheet">
      <p className="text-[13px] leading-relaxed text-text-secondary">{say(PRICE_SHEET.intro, lang)}</p>
      {target.link?.source === 'tmall_cn' ? (
        <div className="lv-alert lv-alert-info space-y-1 text-[13px] leading-relaxed text-text-primary" data-tmall-note>
          <p>{say(PRICE_SHEET.tmallNote, lang)}</p>
          <SupplierAnchor
            href={target.link.sku_url ?? target.link.item_url}
            label={say(target.link.sku_url ? LINKS.openOption : LINKS.openTmall, lang)}
            lang={lang}
          />
        </div>
      ) : null}

      <section className="space-y-3" data-price-manual>
        <h3 className="text-[14px] font-bold text-text-primary">{say(PRICE_SHEET.manualTitle, lang)}</h3>
        {manual?.price ? (
          <p className="text-[12px] text-text-secondary" data-price-current>
            {say(PRICE_SHEET.current, lang, { price: moneyText(manual.price, manual.currency) })}
          </p>
        ) : null}
        {many ? (
          <Segmented
            group="estimate-price-scope"
            label={say(PRICE_SHEET.sameForAll, lang)}
            value={scope}
            onChange={(v) => setScope(v === 'all' ? 'all' : 'one')}
            size="sm"
            items={[
              { id: 'one', label: say(PRICE_SHEET.oneSku, lang) },
              { id: 'all', label: say(PRICE_SHEET.allSkus, lang) },
            ]}
          />
        ) : null}
        <div className="grid gap-3 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,1fr)]">
          <Field label={say(PRICE_SHEET.amount, lang)} error={errors.amount}>
            <Input ltr inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} data-price-amount />
          </Field>
          <Field label={say(PRICE_SHEET.currency, lang)}>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value as SupplierCurrency)} data-price-currency>
              {SUPPLIER_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={say(PRICE_SHEET.note, lang)} optional error={errors.note}>
          <Input dir="auto" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={act.busy === 'manual'} disabled={!!act.busy && act.busy !== 'manual'} onClick={saveManual} data-price-save>
            {say(PRICE_SHEET.save, lang)}
          </Button>
          {manual ? (
            <Button variant="ghost" loading={act.busy === 'remove'} disabled={!!act.busy && act.busy !== 'remove'} onClick={removeManual} data-price-remove>
              {say(PRICE_SHEET.remove, lang)}
            </Button>
          ) : null}
        </div>
      </section>

      {target.link?.source !== 'tmall_cn' ? (
        <section className="space-y-3 border-t border-border-subtle pt-3" data-price-store-read>
          <h3 className="text-[14px] font-bold text-text-primary">{say(PRICE_SHEET.storeTitle, lang)}</h3>
          <p className="text-[12px] leading-relaxed text-text-muted">{say(PRICE_SHEET.storeIntro, lang)}</p>
          <Field label={say(PRICE_SHEET.storeUrl, lang)} error={errors.url}>
            <Input ltr inputMode="url" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} data-price-store-url />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={act.busy === 'read-save'} disabled={!!act.busy && act.busy !== 'read-save'} onClick={() => readPage(true)} data-price-read-save>
              {say(PRICE_SHEET.readAndSave, lang)}
            </Button>
            <Button variant="ghost" loading={act.busy === 'read'} disabled={!!act.busy && act.busy !== 'read'} onClick={() => readPage(false)} data-price-read>
              {say(PRICE_SHEET.readOnly, lang)}
            </Button>
          </div>
          {read ? <StoreReadResult read={read.answer} lang={lang} /> : null}
        </section>
      ) : null}

      <ActNote message={act.message} />
    </SheetFrame>
  );
}

/**
 * What "Read and save" tells him: the price saved, and on a sale page that it
 * is the regular price (the sale price is never saved). The sale price is
 * named only when it is the saved variant's: the link named the variant, or
 * every offer has the same one. Without a variant the SKUs saved may be any
 * of the page's options. null when no offer was chosen.
 */
export function storeSavedNote(read: StorePageRead, lang: UiLang): ActMessage | null {
  const chosen = read.offers.find((o) => o.sku_key === read.chosen_sku_key);
  if (!chosen) return null;
  const vars = { price: moneyText(chosen.price, chosen.currency), host: read.host };
  const saleKnown = read.variant_id !== null || read.offers.every((o) => o.sale_price === chosen.sale_price);
  if (!saleKnown) return { tone: 'warning', text: say(PRICE_SHEET.storeSavedRegular, lang, vars) };
  if (chosen.sale_price) return { tone: 'warning', text: say(PRICE_SHEET.storeSavedSale, lang, { ...vars, sale: moneyText(chosen.sale_price, chosen.currency) }) };
  return { tone: 'success', text: say(PRICE_SHEET.storeSaved, lang, vars) };
}

/** What one store page answered: the host, a redirect and a sale told plainly, and its options with the one asked for. */
export function StoreReadResult({ read, lang }: { read: StorePageRead; lang: UiLang }) {
  return (
    <div className="space-y-2" data-store-read-result={read.source}>
      {read.redirected ? (
        <p className="lv-alert lv-alert-warning text-[12px] leading-relaxed text-text-primary" data-store-redirected>
          {say(PRICE_SHEET.redirected, lang)}
        </p>
      ) : null}
      {read.offers.some((o) => o.sale_price) ? (
        <p className="lv-alert lv-alert-warning text-[12px] leading-relaxed text-text-primary" data-store-on-sale>
          {say(PRICE_SHEET.saleNote, lang)}
        </p>
      ) : null}
      <p className="text-[12px] font-semibold text-text-secondary">{say(PRICE_SHEET.offers, lang)}</p>
      <ul className="space-y-1">
        {read.offers.map((o, i) => (
          <li key={`${o.sku_key}-${i}`} data-store-offer={o.sku_key} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-text-secondary">
            <span dir="ltr" className="min-w-0 break-words text-text-primary">
              {o.name}
            </span>
            <Ltr className="font-bold text-text-primary">{moneyText(o.price, o.currency)}</Ltr>
            {o.sale_price ? (
              <span className="text-text-muted" data-store-sale-price>
                {say(PRICE_SHEET.salePrice, lang)} <Ltr>{moneyText(o.sale_price, o.currency)}</Ltr>
              </span>
            ) : null}
            <span className="text-text-muted">
              {say(o.availability === 'in_stock' ? PRICE_SHEET.inStock : o.availability === 'out_of_stock' ? PRICE_SHEET.outOfStock : PRICE_SHEET.unknownStock, lang)}
            </span>
            {o.sku_key && o.sku_key === read.chosen_sku_key ? <span className="font-bold text-success">{say(PRICE_SHEET.chosen, lang)}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
