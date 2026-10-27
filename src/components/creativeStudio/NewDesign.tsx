/**
 * «تصميم جديد» — the main path of the brief (spec §11, §12, §33):
 * product → variant → picture → goal, priority, amount of text, size,
 * language → template → THREE compositions side by side → choose → editor.
 *
 *  - Only the product’s own SAME-ORIGIN pictures can be chosen (a picture
 *    from another site would taint the export canvas); remote ones are shown
 *    and marked.
 *  - The snapshot is taken first (POST /snapshots): the design binds to it,
 *    and the price, availability and product name are drawn from it — they
 *    are never typed here.
 *  - The compositions are `buildFromTemplate` for `variantsFor(...)`, laid
 *    out with the real measurer after the brand fonts loaded. With AI ready,
 *    Claude writes each one’s copy and reason (POST /ai/compose); without it,
 *    a person writes the copy once and the three layouts are built from it.
 *    A Sorani ad’s words are always typed by a person (DECISIONS row 262).
 *  - A service post starts from an APPROVED claim (service_card).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { Card } from '../ui/Card';
import { StatusChip } from '../ui/Badge';
import VariantImg from '../ui/VariantImg';
import { AI_COPY_LOCALES } from '../../../packages/creativeDoc/src/aiContracts';
import type { ClaimDto, ComposeResponse, ProductDetailDto, ProductListItemDto } from '../../../packages/creativeDoc/src/api';
import { buildFromTemplate, type BuildCopy, type BuildResult } from '../../../packages/creativeDoc/src/layout';
import { CUSTOM_FORMAT_LIMITS, FORMATS, OBJECTIVES, VISUAL_PRIORITIES, formatOf, type AdLocale, type Density, type DocFormat, type FormatId, type Objective, type VisualPriority } from '../../../packages/creativeDoc/src/schema';
import { localized, type ProductSnapshot } from '../../../packages/creativeDoc/src/snapshot';
import { TEMPLATES, VARIANT_LABELS, templateForProduct, variantsFor, type TemplateId, type VariantId } from '../../../packages/creativeDoc/src/templates';
import { containsPriceLike } from '../../../packages/creativeDoc/src/text';
import { ai, assets as assetsApi, brand as brandApi, documents, idempotencyKey, store } from './client';
import { backgroundNatural, claimText, evidenceFor, logoNatural, searchPriceLabel } from './editorData';
import { ensureNeeds, kitFontNeeds } from './fonts';
import { canvasMeasurer } from './media';
import DocThumb from './DocThumb';
import {
  AVAILABILITY_TEXT, CONFLICT_TEXT, DENSITY_TEXT, FORMAT_TEXT, LOCALE_TEXT, OBJECTIVE_TEXT, PRICE_STATUS_TEXT, PRIORITY_TEXT, S, fill,
} from './strings';
import { AiNotReady, RemoteView, failText, useRemote, useStudio, useText, type NewDesignPrefill } from './shared';

interface Picture { url: string; width: number; height: number }
interface Composition { variant: VariantId; reason: string; result: BuildResult }

const PRODUCT_TEMPLATES: TemplateId[] = ['product_hero', 'compact_product', 'education_slide'];

function naturalSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export default function NewDesign({ prefill }: { prefill: NewDesignPrefill | null }) {
  const studio = useStudio();
  const { lang, w } = useText();
  const [mode, setMode] = useState<'product' | 'service'>(prefill?.mode ?? 'product');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductListItemDto[] | null>(null);
  const [searchError, setSearchError] = useState('');
  const [product, setProduct] = useState<ProductDetailDto | null>(null);
  const [variantKey, setVariantKey] = useState<string | null | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  const [claim, setClaim] = useState<ClaimDto | null>(null);
  const [objective, setObjective] = useState<Objective>(prefill?.objective ?? (prefill?.mode === 'service' ? 'service_trust' : 'sell'));
  const [priority, setPriority] = useState<VisualPriority>('product');
  const [density, setDensity] = useState<Density>('brief');
  const [formatId, setFormatId] = useState<FormatId>('square');
  const [customW, setCustomW] = useState('1080');
  const [customH, setCustomH] = useState('1350');
  const [locale, setLocale] = useState<AdLocale>(lang === 'en' ? 'en' : 'ar');
  const [template, setTemplate] = useState<TemplateId>(prefill?.mode === 'service' ? 'service_card' : 'product_hero');
  const [brief, setBrief] = useState('');
  const [copy, setCopy] = useState({ headline: prefill?.copy?.headline ?? '', subhead: prefill?.copy?.subhead ?? '', features: (prefill?.copy?.features ?? []).join('\n'), cta: prefill?.copy?.cta ?? '' });
  const [compositions, setCompositions] = useState<Composition[] | null>(null);
  const [composeInfo, setComposeInfo] = useState<Pick<ComposeResponse, 'warnings' | 'missing' | 'job_id'> | null>(null);
  const [busy, setBusy] = useState<'' | 'product' | 'snapshot' | 'compose' | 'create'>('');
  const [error, setError] = useState('');
  const searchSeq = useRef(0);

  const [extras, reloadExtras] = useRemote(async () => {
    const [b, claims, assets, opportunities] = await Promise.all([
      studio.brand ? Promise.resolve(studio.brand) : brandApi.get(),
      brandApi.claims(),
      assetsApi.list(),
      ai.opportunities(),
    ]);
    return { brand: b, claims, assets, opportunities };
  }, []);

  // A product named by an idea on the home page opens at its variant step.
  useEffect(() => {
    if (prefill?.productId) void chooseProduct(prefill.productId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Search as the owner types (debounced; a late answer never replaces a newer one).
  useEffect(() => {
    if (mode !== 'product' || query.trim().length < 2) {
      setResults(null);
      return;
    }
    const mine = ++searchSeq.current;
    const t = setTimeout(() => {
      store.search(query.trim()).then(
        (list) => { if (searchSeq.current === mine) { setResults(list); setSearchError(''); } },
        (e: unknown) => { if (searchSeq.current === mine) setSearchError(failText(e, lang)); },
      );
    }, 300);
    return () => clearTimeout(t);
  }, [query, mode, lang]);

  const chooseProduct = async (id: string) => {
    setError('');
    setBusy('product');
    setSnapshot(null);
    setPicture(null);
    setCompositions(null);
    try {
      const p = await store.product(id);
      setProduct(p);
      setVariantKey(p.variants.length ? undefined : null);
      if (!p.variants.length) await takeSnapshot(p, null);
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy('');
    }
  };

  const takeSnapshot = async (p: ProductDetailDto, key: string | null) => {
    setError('');
    setBusy('snapshot');
    setVariantKey(key);
    setPicture(null);
    setCompositions(null);
    try {
      const snap = await store.snapshot(p.id, key);
      setSnapshot(snap);
      if (snap.data.price.status !== 'priced' && priority === 'price') setPriority('product');
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy('');
    }
  };

  const choosePicture = async (img: ProductSnapshot['data']['images'][number]) => {
    if (!img.same_origin) return;
    const size = img.width && img.height ? { width: img.width, height: img.height } : await naturalSize(img.url);
    if (!size) {
      setError(w(S.imageFailed));
      return;
    }
    setPicture({ url: img.url, ...size });
    setTemplate(templateForProduct(size));
    setCompositions(null);
  };

  const format: DocFormat | null = formatId === 'custom' ? formatOf('custom', Number(customW), Number(customH)) : { ...FORMATS[formatId] };
  const priceStatus = snapshot?.data.price.status ?? null;
  const variants = useMemo(() => variantsFor(template, objective, priceStatus).slice(0, 3), [template, objective, priceStatus]);
  const aiReady = studio.provider?.ready === true && (AI_COPY_LOCALES as readonly string[]).includes(locale);
  const readyForCompose = !!format && (mode === 'service' ? !!claim : !!snapshot && (template === 'education_slide' || !!picture));

  const build = async (perVariant: Array<{ variant: VariantId; copy: BuildCopy; reason: string; caption: string; alt: string }>) => {
    if (extras.status !== 'ready' || !format) return;
    const { brand: b, assets, opportunities } = extras.data;
    const kit = b.kit;
    const sample = perVariant.map((p) => [p.copy.headline, p.copy.subhead, p.copy.cta, ...(p.copy.features ?? [])].join(' ')).join(' ') + ' ' + (snapshot ? localized(snapshot.data.name, locale) : '') + ' 0123456789 د.ع';
    const fonts = await ensureNeeds(kitFontNeeds([kit.fonts.primary, kit.fonts.display], sample));
    if (fonts.failed.length) setError(fill(w(S.fontFailed), { name: fonts.failed.join('، ') }));
    const measure = canvasMeasurer();
    const out: Composition[] = perVariant.map((p) => ({
      variant: p.variant,
      reason: p.reason,
      result: buildFromTemplate({
        template, variant: p.variant, format, locale, objective, density, brand: kit, brandVersion: b.version,
        products: snapshot && picture ? [{ slot: 'main', snapshot, image: picture }] : [],
        service: mode === 'service' && claim ? claimText(claim) : null,
        copy: p.copy, evidence: evidenceFor(product?.id ?? null, snapshot, opportunities), family: null,
        logo: logoNatural(kit, b, assets), backgroundNatural: backgroundNatural(kit, assets),
        slide: null, caption: p.caption, alt_text: p.alt, measure,
      }),
    }));
    setCompositions(out);
  };

  const manualCopy = (): BuildCopy | null => {
    const headline = copy.headline.trim();
    if (!headline) {
      setError(w(S.newHeadlineRequired));
      return null;
    }
    const features = copy.features.split('\n').map((f) => f.trim()).filter(Boolean).slice(0, 6);
    const all = [headline, copy.subhead, copy.cta, ...features];
    if (all.some((t) => containsPriceLike(t))) {
      setError(w(S.newPriceInCopy));
      return null;
    }
    return { headline, subhead: copy.subhead.trim() || undefined, cta: copy.cta.trim() || undefined, features };
  };

  const buildManual = async () => {
    setError('');
    const c = manualCopy();
    if (!c) return;
    setBusy('compose');
    setComposeInfo(null);
    try {
      await build(variants.map((v) => ({ variant: v, copy: c, reason: VARIANT_LABELS[v][lang], caption: '', alt: '' })));
    } finally {
      setBusy('');
    }
  };

  const composeAi = async () => {
    setError('');
    setBusy('compose');
    try {
      const res = await ai.compose({
        snapshot_id: snapshot?.id ?? null, claim_id: mode === 'service' ? claim?.id ?? null : null, objective, priority, density, template, family: null,
        variants, locale: locale === 'en' ? 'en' : 'ar', brief: brief.trim().slice(0, 600), idempotency_key: idempotencyKey(),
      });
      setComposeInfo({ warnings: res.warnings, missing: res.missing, job_id: res.job_id });
      if (!res.proposals.length) {
        setError(w(S.chatDiffNothing));
        return;
      }
      await build(res.proposals.map((p) => ({ variant: p.variant, copy: { headline: p.headline, subhead: p.subhead || undefined, cta: p.cta || undefined, features: p.features }, reason: p.reason, caption: p.caption, alt: p.alt_text })));
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy('');
    }
  };

  const choose = async (c: Composition) => {
    setError('');
    setBusy('create');
    try {
      const headline = c.result.doc.layers.find((l) => l.id === 'headline');
      const title = (headline && headline.type === 'text' ? headline.text : '') || (snapshot ? localized(snapshot.data.name, lang) : claim ? localized(claim.title, lang) : w(S.tabNew));
      const created = await documents.create({ title: title.slice(0, 120), content: c.result.doc, origin: composeInfo ? 'ai' : 'template', job_id: composeInfo?.job_id ?? null });
      studio.openDocument(created.id);
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy('');
    }
  };

  const pictures = snapshot ? snapshot.data.images.filter((i) => i.variant_key === null || variantKey === null || i.variant_key === variantKey) : [];

  return (
    <RemoteView remote={extras} onRetry={reloadExtras}>
      {(ex) => (
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-new-design>
          <div className="flex flex-wrap gap-2">
            <Button variant={mode === 'product' ? 'primary' : 'secondary'} aria-pressed={mode === 'product'} onClick={() => { setMode('product'); setTemplate('product_hero'); setObjective('sell'); setCompositions(null); }}>{w(S.homeStartProduct)}</Button>
            <Button variant={mode === 'service' ? 'primary' : 'secondary'} aria-pressed={mode === 'service'} onClick={() => { setMode('service'); setTemplate('service_card'); setObjective('service_trust'); setCompositions(null); }}>{w(S.homeStartService)}</Button>
          </div>

          {mode === 'product' ? (
            <>
              <Card title={w(S.newStepProduct)}>
                <Field label={w(S.newSearch)}>
                  <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
                </Field>
                {searchError ? <p className="mt-2 text-sm text-danger" role="alert">{searchError}</p> : null}
                {results && !results.length ? <p className="mt-2 text-sm text-text-muted">{w(S.newSearchEmpty)}</p> : null}
                {results && results.length ? (
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-product-results>
                    {results.map((p) => (
                      <li key={p.id}>
                        <button type="button" className="flex w-full items-center gap-3 rounded-xl border border-border-subtle p-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" aria-pressed={product?.id === p.id} onClick={() => chooseProduct(p.id)}>
                          <span className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface">
                            {p.image ? <VariantImg src={p.image.url} sizes="56px" naturalWidth={p.image.width} alt="" className="h-full w-full object-contain" /> : null}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-text-primary">{localized(p.name, lang)}</span>
                            <span className="block text-xs text-text-muted">
                              {searchPriceLabel(p) ?? w(PRICE_STATUS_TEXT[p.price_status])} · {w(AVAILABILITY_TEXT[p.availability])}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {busy === 'product' ? <p className="mt-2 text-sm text-text-muted" role="status">{w(S.loading)}</p> : null}
              </Card>

              {product ? (
                <Card title={w(S.newStepVariant)} description={localized(product.name, lang)}>
                  {product.variants.length ? (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant={variantKey === null ? 'primary' : 'secondary'} onClick={() => takeSnapshot(product, null)}>{w(S.newWholeProduct)}</Button>
                      {product.variants.map((v) => (
                        <Button key={v.key} size="sm" variant={variantKey === v.key ? 'primary' : 'secondary'} onClick={() => takeSnapshot(product, v.key)}>
                          {localized(v.label, lang)} · {w(AVAILABILITY_TEXT[v.availability])}
                        </Button>
                      ))}
                    </div>
                  ) : <p className="text-sm text-text-muted">{w(S.newNoVariants)}</p>}
                  {busy === 'snapshot' ? <p className="mt-2 text-sm text-text-muted" role="status">{w(S.loading)}</p> : null}
                </Card>
              ) : null}

              {snapshot ? (
                <Card title={w(S.newStepPicture)} action={snapshot.source === 'test' ? <StatusChip tone="warning">{w(S.newTestSnapshot)}</StatusChip> : undefined}>
                  {!pictures.some((p) => p.same_origin) ? <p className="text-sm text-text-muted">{w(S.newNoPictures)}</p> : null}
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-picture-choices>
                    {pictures.map((img) => (
                      <button
                        key={img.url}
                        type="button"
                        disabled={!img.same_origin}
                        aria-pressed={picture?.url === img.url}
                        aria-label={img.same_origin ? (img.width && img.height ? fill(w(S.newPictureSize), { w: img.width, h: img.height }) : img.alt || w(S.newStepPicture)) : w(S.newRemotePicture)}
                        title={img.same_origin ? undefined : w(S.newRemotePicture)}
                        className="relative aspect-square overflow-hidden rounded-xl bg-surface disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        style={{ boxShadow: picture?.url === img.url ? 'inset 0 0 0 3px #3b82f6' : undefined }}
                        onClick={() => choosePicture(img)}
                      >
                        <VariantImg src={img.url} sizes="160px" naturalWidth={img.width} alt="" className="h-full w-full object-contain" />
                        {!img.same_origin ? <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-center text-xs" style={{ background: 'rgba(185,28,28,0.85)', color: '#ffffff' }}>{w(S.newRemotePicture)}</span> : null}
                      </button>
                    ))}
                  </div>
                </Card>
              ) : null}
            </>
          ) : (
            <Card title={w(S.newServiceTitle)}>
              {ex.claims.filter((c) => c.status === 'approved').length === 0 ? (
                <p className="text-sm text-text-muted">{w(S.newNoClaims)}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {ex.claims.filter((c) => c.status === 'approved').map((c) => (
                    <li key={c.id}>
                      <button type="button" aria-pressed={claim?.id === c.id} className="w-full rounded-xl border border-border-subtle p-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" style={{ boxShadow: claim?.id === c.id ? 'inset 0 0 0 2px #3b82f6' : undefined }} onClick={() => { setClaim(c); setCompositions(null); }}>
                        <span className="block text-sm font-semibold text-text-primary">{localized(c.title, lang)}</span>
                        <span className="block text-sm text-text-secondary">{localized(c.summary, lang)}</span>
                        <span className="block text-xs text-text-muted">{w(S.newClaimConditions)}: {localized(c.conditions, lang)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {(mode === 'service' ? !!claim : !!snapshot) ? (
            <Card title={w(S.newStepGoal)}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={w(S.newObjective)}>
                  <Select value={objective} onChange={(e) => { setObjective(e.target.value as Objective); setCompositions(null); }}>
                    {OBJECTIVES.map((o) => <option key={o} value={o}>{w(OBJECTIVE_TEXT[o])}</option>)}
                  </Select>
                </Field>
                <Field label={w(S.newPriority)}>
                  <Select value={priority} onChange={(e) => setPriority(e.target.value as VisualPriority)}>
                    {VISUAL_PRIORITIES.filter((p) => p !== 'price' || priceStatus === 'priced').map((p) => <option key={p} value={p}>{w(PRIORITY_TEXT[p])}</option>)}
                  </Select>
                </Field>
                <Field label={w(S.newDensity)}>
                  <Select value={density} onChange={(e) => { setDensity(e.target.value as Density); setCompositions(null); }}>
                    {(['brief', 'detailed'] as const).map((d) => <option key={d} value={d}>{w(DENSITY_TEXT[d])}</option>)}
                  </Select>
                </Field>
                <Field label={w(S.newFormat)}>
                  <Select value={formatId} onChange={(e) => { setFormatId(e.target.value as FormatId); setCompositions(null); }}>
                    {(['square', 'portrait', 'story', 'custom'] as const).map((f) => <option key={f} value={f}>{w(FORMAT_TEXT[f])}</option>)}
                  </Select>
                </Field>
                {formatId === 'custom' ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={w(S.propW)} hint={fill(w(S.formatsLimits), { min: CUSTOM_FORMAT_LIMITS.min, max: CUSTOM_FORMAT_LIMITS.max, aspect: CUSTOM_FORMAT_LIMITS.maxAspect })}><Input type="number" ltr value={customW} onChange={(e) => setCustomW(e.target.value)} /></Field>
                    <Field label={w(S.propH)}><Input type="number" ltr value={customH} onChange={(e) => setCustomH(e.target.value)} /></Field>
                  </div>
                ) : null}
                <Field label={w(S.newLocale)}>
                  <Select value={locale} onChange={(e) => { setLocale(e.target.value as AdLocale); setCompositions(null); }}>
                    {(['ar', 'en', 'ckb'] as const).map((l) => <option key={l} value={l}>{w(LOCALE_TEXT[l])}</option>)}
                  </Select>
                </Field>
              </div>
            </Card>
          ) : null}

          {readyForCompose ? (
            <Card title={w(S.newStepTemplate)} description={mode === 'product' ? w(S.newTemplateAuto) : undefined}>
              {mode === 'product' ? (
                <div className="flex flex-wrap gap-2">
                  {PRODUCT_TEMPLATES.map((t) => <Button key={t} size="sm" variant={template === t ? 'primary' : 'secondary'} aria-pressed={template === t} onClick={() => { setTemplate(t); setCompositions(null); }}>{TEMPLATES[t].label[lang]}</Button>)}
                </div>
              ) : <p className="text-sm text-text-secondary">{TEMPLATES.service_card.label[lang]}</p>}
              <p className="mt-2 text-xs text-text-muted">{variants.map((v) => VARIANT_LABELS[v][lang]).join(' · ')}</p>
            </Card>
          ) : null}

          {readyForCompose ? (
            <Card title={w(S.newStepCompose)}>
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="flex flex-col gap-2">
                  {aiReady ? (
                    <>
                      <Field label={w(S.newBrief)}><Textarea rows={2} value={brief} maxLength={600} onChange={(e) => setBrief(e.target.value)} /></Field>
                      <Button variant="primary" loading={busy === 'compose'} onClick={composeAi}>{w(S.newComposeAi)}</Button>
                    </>
                  ) : locale === 'ckb' ? (
                    <p className="text-sm text-text-secondary">{w(LOCALE_TEXT.ckb)}</p>
                  ) : (
                    <AiNotReady provider={studio.provider} onSettings={() => studio.goTab('settings')} />
                  )}
                </section>
                <section className="flex flex-col gap-2" data-manual-copy>
                  <h3 className="text-sm font-semibold text-text-primary">{w(S.newManualCopy)}</h3>
                  <p className="text-xs text-text-muted">{w(S.newManualHint)}</p>
                  <Field label={w(S.newHeadline)}><Input value={copy.headline} maxLength={90} onChange={(e) => setCopy({ ...copy, headline: e.target.value })} data-copy-headline /></Field>
                  <Field label={w(S.newSubhead)} optional><Input value={copy.subhead} maxLength={160} onChange={(e) => setCopy({ ...copy, subhead: e.target.value })} /></Field>
                  <Field label={w(S.newFeatures)} optional><Textarea rows={3} value={copy.features} onChange={(e) => setCopy({ ...copy, features: e.target.value })} /></Field>
                  <Field label={w(S.newCta)} optional><Input value={copy.cta} maxLength={40} onChange={(e) => setCopy({ ...copy, cta: e.target.value })} /></Field>
                  <Button loading={busy === 'compose'} onClick={buildManual} data-build-manual>{w(S.newBuild)}</Button>
                </section>
              </div>
              {composeInfo?.missing.length ? <p className="mt-3 text-sm text-warning">{fill(w(S.newMissingFacts), { list: composeInfo.missing.join('، ') })}</p> : null}
              {composeInfo?.warnings.length ? <ul className="mt-2 list-disc ps-5 text-xs text-text-muted">{composeInfo.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
            </Card>
          ) : null}

          {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}

          {compositions ? (
            <div className="grid gap-4 md:grid-cols-3" data-compositions>
              {compositions.map((c) => (
                <Card key={c.variant} title={VARIANT_LABELS[c.variant][lang]} level={3}>
                  <DocThumb doc={c.result.doc} width={280} label={VARIANT_LABELS[c.variant][lang]} />
                  <p className="mt-2 text-sm text-text-secondary"><span className="text-text-muted">{w(S.newProposalReason)}: </span>{c.reason}</p>
                  {c.result.dropped.length ? <p className="mt-1 text-xs text-text-muted">{fill(w(S.newProposalDropped), { list: c.result.dropped.join('، ') })}</p> : null}
                  {c.result.conflicts.length ? <p className="mt-1 text-xs text-warning">{fill(w(S.newProposalConflicts), { list: c.result.conflicts.map((x) => w(CONFLICT_TEXT[x.code])).join('، ') })}</p> : null}
                  <Button className="mt-3" variant="primary" block loading={busy === 'create'} onClick={() => choose(c)} data-choose={c.variant}>{w(S.newChoose)}</Button>
                </Card>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </RemoteView>
  );
}
