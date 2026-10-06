/**
 * THE GIFT CONFIGURATOR (lazy) — one sheet for both brief §10 and §11:
 *
 *   mode 'level-item'  a real store product added to (or edited in) a level:
 *                      sale type, and for every option group either ONE fixed
 *                      value or the subset the customer may pick from; the
 *                      colour the same way; the pre-order route. Saved through
 *                      POST/PUT /api/reviews/admin/pools (validateLevelItem).
 *   mode 'manual-gift' the one product the admin fixes for this review: every
 *                      group and the colour pinned. Nothing is saved here — the
 *                      selection goes back to the decision panel and is sent
 *                      with «تأكيد وإصدار الكود».
 *
 * The choices offered come from the server's projection of the product
 * (GET /api/reviews/admin/gift-options/:id): the sale types it really
 * offers, its live groups and values, its colours with their option links,
 * its pre-order routes. The client never combines ids on its own: the
 * preview (POST /api/reviews/admin/pools/preview) validates the selection
 * with the store's own rules and returns the picture, name and words shown
 * before anything is confirmed.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import * as T from '../adminProducts/theme';
import ProductPicker from '../adminProducts/form/ProductPicker';
import { Sheet } from '../ui/Sheet';
import { Switch } from '../ui/Switch';
import { api, formatIqd } from '../../lib/api';
import { toast } from '../../lib/toastStore';
import { useLanguage } from '../../LanguageContext';
import {
  TRANSPORTS,
  colorFits,
  draftForProduct,
  draftFromItem,
  draftPreviewSelection,
  draftProblems,
  draftToLevelInput,
  draftToSelection,
  emptyDraft,
  errorFacts,
  fill,
  nameIn,
  normalizeDisplay,
  normalizeGiftOptions,
  normalizeLevelItem,
  obj,
  variantIn,
  type DraftMode,
  type GiftDisplay,
  type GiftDraft,
  type GiftOptions,
  type Lang,
  type LevelItem,
  type ManualGift,
  type Problem,
  type SaleType,
  type Transport,
} from './model';
import { adminRefusal, adminStrings, type AdminReviewStrings } from './strings';
import { errorText } from './errorText';
import { Chip, Notice, RADIO_CHIP, RadioGroup, Thumb } from './ui';

export interface GiftItemSheetProps {
  open: boolean;
  mode: DraftMode;
  level: number;
  /** level-item: the item being edited (null = a new item). */
  item?: LevelItem | null;
  /** manual-gift: the gift chosen before, to change it. */
  initialManual?: ManualGift | null;
  onClose: () => void;
  onSaved?: (item: LevelItem | null) => void;
  onChosen?: (gift: ManualGift) => void;
}

interface PreviewState {
  ok: boolean;
  display: GiftDisplay | null;
  errors: string[];
}

export function problemText(S: AdminReviewStrings, p: Problem, options: GiftOptions | null, lang: Lang): string {
  const group = p.group ? options?.groups.find((g) => g.id === p.group) : undefined;
  const groupName = group ? nameIn(lang, group) : '';
  return fill(S.sheet.problems[p.key], { group: groupName });
}

/** The draft of a manual gift chosen before, rebuilt once the product's options are known. */
function draftFromManual(gift: ManualGift, options: GiftOptions | null): GiftDraft {
  const d = draftForProduct(gift.selection.productId, options);
  d.saleType = gift.selection.saleType;
  d.transport = gift.selection.transportMethod;
  d.colorPin = gift.selection.colorId;
  for (const v of gift.selection.optionValueIds) {
    const g = options?.groups.find((x) => x.values.some((y) => y.id === v));
    if (g) d.pins[g.id] = v;
  }
  return d;
}

export default function GiftItemSheet({ open, mode, level, item, initialManual, onClose, onSaved, onChosen }: GiftItemSheetProps) {
  const { lang: rawLang, dir } = useLanguage();
  const lang: Lang = rawLang === 'en' ? 'en' : rawLang === 'ckb' ? 'ckb' : 'ar';
  const S = adminStrings(lang);
  const [draft, setDraft] = useState<GiftDraft>(emptyDraft);
  const [touched, setTouched] = useState(false);
  const [options, setOptions] = useState<GiftOptions | null>(null);
  const [optionsBusy, setOptionsBusy] = useState(false);
  const [optionsError, setOptionsError] = useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const optionsSeq = useRef(0);
  const previewSeq = useRef(0);

  const loadOptions = useCallback(
    async (productId: string, build: (o: GiftOptions | null) => GiftDraft) => {
      const mine = ++optionsSeq.current;
      setOptions(null);
      setOptionsError('');
      setPreview(null);
      if (!productId) {
        setDraft(build(null));
        return;
      }
      setOptionsBusy(true);
      try {
        const res = await api.get<unknown>(`/api/reviews/admin/gift-options/${encodeURIComponent(productId)}`);
        if (mine !== optionsSeq.current) return;
        const o = normalizeGiftOptions(res);
        setOptions(o);
        setDraft(build(o));
      } catch (e) {
        if (mine !== optionsSeq.current) return;
        setOptionsError(await errorText(e, lang));
        setDraft(build(null));
      } finally {
        if (mine === optionsSeq.current) setOptionsBusy(false);
      }
    },
    [lang]
  );

  // Opening: start from the item / the earlier manual gift / nothing.
  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setServerError('');
    setServerErrors([]);
    if (mode === 'level-item' && item?.product_id) {
      void loadOptions(item.product_id, (o) => draftFromItem(item, o));
    } else if (mode === 'manual-gift' && initialManual) {
      void loadOptions(initialManual.selection.productId, (o) => draftFromManual(initialManual, o));
    } else {
      optionsSeq.current++;
      setOptions(null);
      setOptionsError('');
      setPreview(null);
      setDraft(emptyDraft());
    }
    // Only on opening; a parent re-render must not reset the admin's work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const problems = useMemo(() => (draft.productId ? draftProblems(draft, options, mode) : [{ key: 'needProduct' as const }]), [draft, options, mode]);

  // The server preview: the store's own validation and the words to show.
  const previewKey = useMemo(() => {
    if (!options || optionsBusy) return '';
    const sel = mode === 'manual-gift' ? (problems.length ? null : draftToSelection(draft, options)) : draftPreviewSelection(draft, options, mode);
    return sel ? JSON.stringify(sel) : '';
  }, [draft, options, optionsBusy, problems, mode]);

  useEffect(() => {
    if (!open || !previewKey) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    const mine = ++previewSeq.current;
    setPreviewing(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.post<unknown>('/api/reviews/admin/pools/preview', JSON.parse(previewKey));
        if (mine !== previewSeq.current) return;
        const r = obj(res);
        const ok = r?.ok === undefined ? !!r?.display : r.ok === true;
        setPreview({
          ok,
          display: r?.display ? normalizeDisplay(r.display) : null,
          errors: Array.isArray(r?.errors) ? (r?.errors as unknown[]).map(String) : r?.code ? [String(r.code)] : [],
        });
      } catch (e) {
        if (mine !== previewSeq.current) return;
        const f = errorFacts(e);
        const extra = Array.isArray(obj(f.details)?.errors) ? ((obj(f.details)?.errors as unknown[]) ?? []).map(String) : [];
        setPreview({ ok: false, display: null, errors: [f.code, ...extra].filter(Boolean) });
      } finally {
        if (mine === previewSeq.current) setPreviewing(false);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [previewKey, open]);

  const update = (fn: (d: GiftDraft) => GiftDraft) => {
    setTouched(true);
    setServerError('');
    setServerErrors([]);
    setDraft((d) => fn({ ...d, pins: { ...d.pins }, customerPicks: { ...d.customerPicks }, allowed: { ...d.allowed }, allowedColors: [...d.allowedColors] }));
  };

  const pickProduct = (id: string) => {
    setTouched(true);
    setServerError('');
    setServerErrors([]);
    void loadOptions(id, (o) => draftForProduct(id, o));
  };

  const canFinish = problems.length === 0 && !!options && !optionsBusy && !saving && (mode === 'level-item' || (!!preview?.ok && !!preview.display && !previewing));

  const finish = async () => {
    if (!canFinish || !options) return;
    if (mode === 'manual-gift') {
      if (!preview?.display) return;
      onChosen?.({ selection: draftToSelection(draft, options), display: preview.display });
      return;
    }
    setSaving(true);
    setServerError('');
    setServerErrors([]);
    try {
      const input = draftToLevelInput(draft, level, options);
      const res = item?.id
        ? await api.put<unknown>(`/api/reviews/admin/pools/${encodeURIComponent(item.id)}`, { ...input, sort: item.sort })
        : await api.post<unknown>('/api/reviews/admin/pools', input);
      toast.success(S.levels.saved);
      onSaved?.(normalizeLevelItem(obj(res)?.item));
    } catch (e) {
      const f = errorFacts(e);
      const extra = Array.isArray(f.details?.errors) ? (f.details?.errors as unknown[]).map(String) : [];
      setServerErrors(extra);
      setServerError(await errorText(e, lang));
    } finally {
      setSaving(false);
    }
  };

  const title =
    mode === 'manual-gift' ? S.sheet.manualTitle : item?.id ? fill(S.sheet.editTitle, { n: level }) : fill(S.sheet.addTitle, { n: level });
  const titleId = 'gift-item-sheet-title';
  const saleTypes = options?.sale_types ?? [];
  const preOrder = saleTypes.find((t) => t.type === 'pre_order');
  const transports: Transport[] = preOrder?.transports.length ? preOrder.transports : options?.transports.length ? options.transports : [...TRANSPORTS];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      dirty={touched && !saving}
      panelClassName={`${T.AP} sm:max-w-2xl sm:w-[92vw]`}
      testId="gift-item-sheet"
      header={
        <div className="flex items-center gap-2 border-b border-[var(--ap-border)] px-2 pb-2 pt-1">
          <button type="button" onClick={onClose} aria-label={S.close} className={`${T.btnIconGhost} relative lv-hit`}>
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-[15px] font-bold text-[var(--ap-text-1)]">
            {title}
          </h2>
        </div>
      }
      footer={
        <div className="space-y-2">
          {problems.length > 0 && draft.productId && !optionsBusy && (
            <p className="text-[12px] text-[var(--ap-text-3)]" data-sheet-problems={problems.length}>
              {S.sheet.fixFirst} {problems.map((p) => problemText(S, p, options, lang)).join(' · ')}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" className={`${T.btnSecondary} relative lv-hit shrink-0`} onClick={onClose}>
              {S.cancel}
            </button>
            <button type="button" className={`${T.btnPrimary} relative lv-hit flex-1`} disabled={!canFinish} onClick={() => void finish()} data-sheet-finish aria-busy={saving || undefined}>
              {saving ? S.sheet.saving : mode === 'manual-gift' ? S.sheet.useGift : fill(S.sheet.saveToLevel, { n: level })}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 px-4 pb-4 pt-3 sm:px-5" dir={dir}>
        <div>
          <p className="mb-1.5 text-[12px] font-semibold text-[var(--ap-text-2)]">{S.sheet.product}</p>
          <ProductPicker value={draft.productId} onChange={(id) => pickProduct(id)} excludeComposition ariaLabel={S.sheet.product} />
          <p className="mt-1 text-[11.5px] text-[var(--ap-text-3)]">{S.sheet.productHint}</p>
        </div>

        {optionsBusy && (
          <p className="text-[12.5px] text-[var(--ap-text-3)]" role="status">
            {S.sheet.optionsLoading}
          </p>
        )}
        {optionsError && <Notice tone="danger" live>{optionsError}</Notice>}

        {options && !optionsBusy && (
          <>
            <div className={`${T.surface} p-3 flex items-center gap-3`} data-gift-product={options.product.id}>
              <Thumb src={(preview?.display?.image || options.product.image) ?? ''} size="lg" />
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold text-[var(--ap-text-1)] break-words">{nameIn(lang, options.product) || options.product.id}</p>
                {options.product.status && options.product.status !== 'active' && (
                  <Chip tone="warning">{S.levels.warnings.archived}</Chip>
                )}
              </div>
            </div>

            {/* Sale type: only what this product really offers. */}
            <fieldset>
              <legend className="mb-1.5 text-[12px] font-semibold text-[var(--ap-text-2)]">{S.sheet.saleType}</legend>
              <RadioGroup
                label={S.sheet.saleType}
                options={saleTypes.map((t) => ({
                  value: t.type,
                  label: t.available ? S.sheet.saleTypes[t.type] : `${S.sheet.saleTypes[t.type]} — ${S.sheet.saleTypeUnavailable}`,
                  disabled: !t.available,
                }))}
                value={draft.saleType || null}
                onChange={(v: SaleType) => update((d) => ({ ...d, saleType: v, transport: v === 'pre_order' ? d.transport : '' }))}
                className="flex flex-wrap gap-2"
                itemClassName={RADIO_CHIP}
                dir={dir}
                dataAttr="data-sale-type"
              />
            </fieldset>

            {draft.saleType === 'pre_order' && (
              <fieldset>
                <legend className="mb-1.5 text-[12px] font-semibold text-[var(--ap-text-2)]">{S.sheet.transport}</legend>
                <RadioGroup
                  label={S.sheet.transport}
                  options={transports.map((m) => ({ value: m, label: S.sheet.transports[m] }))}
                  value={draft.transport || null}
                  onChange={(v: Transport) => update((d) => ({ ...d, transport: v }))}
                  className="flex flex-wrap gap-2"
                  itemClassName={RADIO_CHIP}
                  dir={dir}
                  dataAttr="data-transport"
                />
              </fieldset>
            )}

            {options.groups.map((g) => {
              const picks = mode === 'level-item' && !!draft.customerPicks[g.id];
              const allowed = draft.allowed[g.id] ?? [];
              return (
                <fieldset key={g.id} data-option-group={g.id}>
                  <legend className="mb-1.5 text-[12px] font-semibold text-[var(--ap-text-2)]">{nameIn(lang, g)}</legend>
                  {mode === 'level-item' && (
                    <RadioGroup
                      label={nameIn(lang, g)}
                      options={[
                        { value: 'pin', label: S.sheet.pinOne },
                        { value: 'customer', label: S.sheet.customerChooses },
                      ]}
                      value={picks ? 'customer' : 'pin'}
                      onChange={(v) => update((d) => ({ ...d, customerPicks: { ...d.customerPicks, [g.id]: v === 'customer' } }))}
                      className="mb-2 flex flex-wrap gap-1.5"
                      itemClassName={RADIO_CHIP}
                      dir={dir}
                    />
                  )}
                  {picks ? (
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${nameIn(lang, g)} — ${S.sheet.customerChooses}`}>
                      {g.values.map((v) => {
                        const on = allowed.includes(v.id);
                        return (
                          <button
                            key={v.id}
                            type="button"
                            aria-pressed={on}
                            className={`${T.chip} relative lv-hit`}
                            onClick={() =>
                              update((d) => ({
                                ...d,
                                allowed: { ...d.allowed, [g.id]: on ? allowed.filter((x) => x !== v.id) : [...allowed, v.id] },
                              }))
                            }
                          >
                            {nameIn(lang, v)}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <RadioGroup
                      label={nameIn(lang, g)}
                      options={g.values.map((v) => ({ value: v.id, label: nameIn(lang, v) }))}
                      value={draft.pins[g.id] || null}
                      onChange={(v: string) => update((d) => ({ ...d, pins: { ...d.pins, [g.id]: v } }))}
                      className="flex flex-wrap gap-1.5"
                      itemClassName={RADIO_CHIP}
                      dir={dir}
                      dataAttr="data-option-value"
                    />
                  )}
                </fieldset>
              );
            })}

            {options.colors.length > 0 && (
              <fieldset data-colors>
                <legend className="mb-1.5 text-[12px] font-semibold text-[var(--ap-text-2)]">{S.sheet.color}</legend>
                {mode === 'level-item' && (
                  <RadioGroup
                    label={S.sheet.color}
                    options={[
                      { value: 'pin', label: S.sheet.pinOne },
                      { value: 'customer', label: S.sheet.customerChooses },
                    ]}
                    value={draft.customerPicksColor ? 'customer' : 'pin'}
                    onChange={(v) => update((d) => ({ ...d, customerPicksColor: v === 'customer' }))}
                    className="mb-2 flex flex-wrap gap-1.5"
                    itemClassName={RADIO_CHIP}
                    dir={dir}
                  />
                )}
                {mode === 'level-item' && draft.customerPicksColor ? (
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${S.sheet.color} — ${S.sheet.customerChooses}`}>
                    {options.colors.map((c) => {
                      const on = draft.allowedColors.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          aria-pressed={on}
                          className={`${T.chip} relative lv-hit`}
                          onClick={() => update((d) => ({ ...d, allowedColors: on ? d.allowedColors.filter((x) => x !== c.id) : [...d.allowedColors, c.id] }))}
                        >
                          <Swatch hex={c.hex} />
                          {nameIn(lang, c)}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <RadioGroup
                    label={S.sheet.color}
                    options={options.colors.map((c) => {
                      const fits = colorFits(c, options.groups, draft.pins);
                      return {
                        value: c.id,
                        label: (
                          <>
                            <Swatch hex={c.hex} />
                            {nameIn(lang, c)}
                          </>
                        ),
                        disabled: !fits,
                        title: fits ? undefined : S.sheet.colorNotLinked,
                        ariaLabel: fits ? undefined : `${nameIn(lang, c)} — ${S.sheet.colorNotLinked}`,
                      };
                    })}
                    value={draft.colorPin || null}
                    onChange={(v: string) => update((d) => ({ ...d, colorPin: v }))}
                    className="flex flex-wrap gap-1.5"
                    itemClassName={RADIO_CHIP}
                    dir={dir}
                    dataAttr="data-color"
                  />
                )}
              </fieldset>
            )}

            {mode === 'level-item' && (
              <div className={`${T.surface} px-3`}>
                <Switch checked={draft.active} onChange={(v) => update((d) => ({ ...d, active: v }))} label={S.sheet.activeLabel} description={S.levels.activeHint} />
              </div>
            )}

            {/* The preview: the store's own validation, the picture and the words. */}
            <section aria-live="polite" data-gift-preview={preview ? (preview.ok ? 'ok' : 'refused') : previewing ? 'checking' : 'none'}>
              <p className="mb-1.5 text-[12px] font-semibold text-[var(--ap-text-2)]">{S.sheet.preview}</p>
              {previewing ? (
                <p className="text-[12.5px] text-[var(--ap-text-3)]">{S.sheet.previewing}</p>
              ) : preview?.ok && preview.display ? (
                <div className={`${T.surface} p-3 flex items-start gap-3`}>
                  <Thumb src={preview.display.image} size="lg" />
                  <div className="min-w-0 space-y-1">
                    <p className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ap-success)]">
                      <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                      {S.sheet.previewOk}
                    </p>
                    <p className="text-[13.5px] font-semibold text-[var(--ap-text-1)] break-words">{nameIn(lang, preview.display)}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {draft.saleType && <Chip tone="accent">{S.sheet.saleTypes[draft.saleType]}</Chip>}
                      {draft.saleType === 'pre_order' && draft.transport && <Chip tone="neutral">{S.sheet.transports[draft.transport]}</Chip>}
                      {variantIn(lang, preview.display) && <Chip tone="neutral">{variantIn(lang, preview.display)}</Chip>}
                      {preview.display.color_name && <Chip tone="neutral" icon={<Swatch hex={preview.display.color_hex} />}>{preview.display.color_name}</Chip>}
                    </div>
                    {preview.display.regular_iqd !== null && (
                      <p className="text-[12px] text-[var(--ap-text-3)]">{fill(S.sheet.price, { price: formatIqd(preview.display.regular_iqd) })}</p>
                    )}
                  </div>
                </div>
              ) : preview && !preview.ok ? (
                <Notice tone="danger">
                  <ul className="space-y-0.5">
                    {(preview.errors.length ? preview.errors : ['GIFT_SELECTION_INVALID']).map((code) => (
                      <li key={code}>{adminRefusal(code, lang) ?? S.errors.generic}</li>
                    ))}
                  </ul>
                </Notice>
              ) : (
                <ul className="list-disc space-y-0.5 ps-5 text-[12.5px] text-[var(--ap-text-3)]" data-problems>
                  {problems.map((p) => (
                    <li key={`${p.key}:${p.group ?? ''}`}>{problemText(S, p, options, lang)}</li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        {serverError && (
          <Notice tone="danger" live>
            <p>{serverError}</p>
            {serverErrors.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {serverErrors.map((code) => (
                  <li key={code}>{adminRefusal(code, lang) ?? code}</li>
                ))}
              </ul>
            )}
          </Notice>
        )}
      </div>
    </Sheet>
  );
}

function Swatch({ hex }: { hex: string }) {
  if (!hex) return null;
  return <span aria-hidden="true" className="inline-block w-2.5 h-2.5 shrink-0 rounded-full border border-[var(--ap-border-strong)]" style={{ background: hex }} />;
}
