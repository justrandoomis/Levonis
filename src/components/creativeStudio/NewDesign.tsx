/**
 * «تصميم جديد» — the main path of the brief (spec §11, §12, §33):
 * product → variant → picture → family, goal, priority, amount of text,
 * size, language → template → UP TO THREE compositions side by side (as many
 * as the template has for the goal; the screen says how many) → choose →
 * editor.
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
 *  - The visual PRIORITY is a real choice: only the priorities the template
 *    can honour for the goal are offered, the chosen one's composition leads
 *    (`variantsFor`'s 4th argument), and changing it drops stale compositions.
 *  - A FAMILY sets the goal, the template and the leading composition, and is
 *    passed to the layout and to Claude. Its badge («وصل حديثاً», «عاد
 *    للتوفر», «عرض خاص») is drawn only with evidence from the shop's own
 *    records — an offer on the snapshot, an arrival or a return to stock in
 *    the opportunities — and the screen says why when it is not.
 *  - A service post starts from an APPROVED claim (service_card); with none,
 *    the screen links to «الخدمات المعتمدة».
 *  - From an IDEA: the claim and the idea's composition are preselected, its
 *    caption and alt text carried into the build. A design built from
 *    Claude's words (a composition, or the idea's own headline) is created
 *    with origin 'ai' and its job; from the template alone, 'template'.
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
import { CUSTOM_FORMAT_LIMITS, FORMATS, MAX_ALT_CHARS, MAX_CAPTION_CHARS, OBJECTIVES, formatOf, type AdLocale, type Density, type DocFormat, type FormatId, type Objective, type VisualPriority } from '../../../packages/creativeDoc/src/schema';
import { localized, type ProductSnapshot } from '../../../packages/creativeDoc/src/snapshot';
import { FAMILIES, GRID_PRODUCTS, HOUSE_TEMPLATE, NO_EVIDENCE, PRODUCT_SLOTS, TEMPLATES, VARIANT_LABELS, templateForProduct, type FamilyId, type TemplateId, type VariantId } from '../../../packages/creativeDoc/src/templates';
import { containsPriceLike } from '../../../packages/creativeDoc/src/text';
import { ai, assets as assetsApi, brand as brandApi, documents, idempotencyKey, store } from './client';
import { backgroundNatural, claimText, evidenceFor, logoNatural, searchPriceLabel } from './editorData';
import { ensureNeeds, kitFontNeeds } from './fonts';
import { canvasMeasurer, knockoutBounds } from './media';
import DocThumb from './DocThumb';
import {
  AVAILABILITY_TEXT, CONFLICT_TEXT, DENSITY_TEXT, FORMAT_TEXT, LOCALE_TEXT, OBJECTIVE_TEXT, PRICE_STATUS_TEXT, PRIORITY_TEXT, S, fill,
} from './strings';
import { AiNotReady, RemoteView, codeOf, failText, useRemote, useStudio, useText, type NewDesignPrefill } from './shared';
import {
  PRODUCT_FAMILIES, compositionVariants, createOrigin, effectivePriority, familyBadge, familyChoice, familyForObjective, ideaJobFor, initialPriority,
  isJobRefusal, supportedPriorities,
} from './screensModel';

/** `bounds`: the content box once the white backdrop is knocked out (the house look stands it on its podium). */
interface Picture { url: string; width: number; height: number; bounds?: { x: number; y: number; width: number; height: number } | null }
/** One product of a multi-product post: its own snapshot and picture. */
interface MultiItem { snapshot: ProductSnapshot; picture: Picture | null }
/** `jobId`: the job whose words this composition carries (Claude's composition, or the idea's own headline); null = the template's. */
interface Composition { variant: VariantId; reason: string; result: BuildResult; jobId: string | null }

const PRODUCT_TEMPLATES: TemplateId[] = [HOUSE_TEMPLATE, 'product_hero', 'compact_product', 'education_slide'];

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
  const [mode, setMode] = useState<'product' | 'service' | 'multi'>(prefill?.mode ?? 'product');
  const [multi, setMulti] = useState<MultiItem[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductListItemDto[] | null>(null);
  const [searchError, setSearchError] = useState('');
  const [product, setProduct] = useState<ProductDetailDto | null>(null);
  const [variantKey, setVariantKey] = useState<string | null | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  const [claim, setClaim] = useState<ClaimDto | null>(null);
  const [claimMissing, setClaimMissing] = useState(false);
  const [objective, setObjective] = useState<Objective>(prefill?.objective ?? (prefill?.mode === 'service' ? 'service_trust' : 'sell'));
  const [family, setFamily] = useState<FamilyId | null>(() => familyForObjective(prefill?.objective ?? (prefill?.mode === 'service' ? 'service_trust' : 'sell'), prefill?.mode === 'service' ? 'service' : 'product'));
  const [priority, setPriority] = useState<VisualPriority>(initialPriority(prefill));
  const [density, setDensity] = useState<Density>('brief');
  const [formatId, setFormatId] = useState<FormatId>('square');
  const [customW, setCustomW] = useState('1080');
  const [customH, setCustomH] = useState('1350');
  const [locale, setLocale] = useState<AdLocale>(lang === 'en' ? 'en' : 'ar');
  const [template, setTemplate] = useState<TemplateId>(prefill?.mode === 'service' ? 'service_card' : prefill?.mode === 'multi' ? 'product_grid' : HOUSE_TEMPLATE);
  const [brief, setBrief] = useState('');
  const [copy, setCopy] = useState({
    headline: prefill?.copy?.headline ?? '', subhead: prefill?.copy?.subhead ?? '', features: (prefill?.copy?.features ?? []).join('\n'), cta: prefill?.copy?.cta ?? '',
    caption: prefill?.caption ?? '', alt: prefill?.alt ?? '',
  });
  const [compositions, setCompositions] = useState<Composition[] | null>(null);
  const [composeInfo, setComposeInfo] = useState<Pick<ComposeResponse, 'warnings' | 'missing' | 'job_id'> | null>(null);
  const [busy, setBusy] = useState<'' | 'product' | 'snapshot' | 'compose' | 'create'>('');
  const [error, setError] = useState('');
  const searchSeq = useRef(0);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  // The compositions (or what went wrong) appear below the form: bring them into view, or a click on «build» looks like nothing happened.
  useEffect(() => {
    if (compositions || error) resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [compositions, error]);

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

  // A service named by an idea is preselected once the approved claims are known (once: the owner may then change it).
  const claimPrefilled = useRef(false);
  useEffect(() => {
    if (claimPrefilled.current || extras.status !== 'ready' || !prefill?.claimId) return;
    claimPrefilled.current = true;
    const found = extras.data.claims.find((c) => c.id === prefill.claimId && c.status === 'approved');
    if (found) setClaim(found);
    else setClaimMissing(true);
  }, [extras, prefill]);

  // Search as the owner types (debounced; a late answer never replaces a newer one).
  useEffect(() => {
    if (mode === 'service' || query.trim().length < 2) {
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

  const pictureOf = async (img: ProductSnapshot['data']['images'][number]): Promise<Picture | null> => {
    if (!img.same_origin) return null;
    const size = img.width && img.height ? { width: img.width, height: img.height } : await naturalSize(img.url);
    if (!size) return null;
    return { url: img.url, ...size, bounds: await knockoutBounds(img.url, size) };
  };

  const choosePicture = async (img: ProductSnapshot['data']['images'][number]) => {
    if (!img.same_origin) return;
    const pic = await pictureOf(img);
    if (!pic) {
      setError(w(S.imageFailed));
      return;
    }
    setPicture(pic);
    // A lesson family keeps its own template; the house look stays; otherwise the picture's proportions pick between the two product templates.
    setTemplate((t) => (family && FAMILIES[family].template !== 'product_hero' ? FAMILIES[family].template : t === HOUSE_TEMPLATE ? t : templateForProduct(pic)));
    setCompositions(null);
  };

  /** Multi-product post: each product is bound as a whole, with its first same-origin picture. */
  const addToMulti = async (id: string) => {
    setError('');
    if (multi.length >= GRID_PRODUCTS.max) {
      setError(w(S.newMultiMax));
      return;
    }
    if (multi.some((m) => m.snapshot.data.product_id === id)) return;
    setBusy('snapshot');
    try {
      const snap = await store.snapshot(id, null);
      const first = snap.data.images.find((i) => i.same_origin) ?? null;
      const pic = first ? await pictureOf(first) : null;
      setMulti((list) => (list.length >= GRID_PRODUCTS.max ? list : [...list, { snapshot: snap, picture: pic }]));
      setCompositions(null);
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy('');
    }
  };

  const format: DocFormat | null = formatId === 'custom' ? formatOf('custom', Number(customW), Number(customH)) : { ...FORMATS[formatId] };
  const priceStatus = snapshot?.data.price.status ?? null;
  const priorities = useMemo(() => supportedPriorities(template, objective, priceStatus), [template, objective, priceStatus]);
  const prio = effectivePriority(priority, priorities);
  const variants = useMemo(() => compositionVariants(template, objective, priceStatus, prio), [template, objective, priceStatus, prio]);
  const evidence = extras.status === 'ready' ? evidenceFor(product?.id ?? null, snapshot, extras.data.opportunities) : NO_EVIDENCE;
  const badge = familyBadge(family, evidence);
  const aiReady = studio.provider?.ready === true && (AI_COPY_LOCALES as readonly string[]).includes(locale);
  const readyForCompose = !!format && (mode === 'service' ? !!claim : mode === 'multi' ? multi.length >= GRID_PRODUCTS.min : !!snapshot && (template === 'education_slide' || !!picture));

  const build = async (perVariant: Array<{ variant: VariantId; copy: BuildCopy; reason: string; caption: string; alt: string; jobId: string | null }>) => {
    if (extras.status !== 'ready' || !format) return;
    const { brand: b, assets, opportunities } = extras.data;
    const kit = b.kit;
    const names = mode === 'multi' ? multi.map((m) => localized(m.snapshot.data.name, locale)).join(' ') : snapshot ? localized(snapshot.data.name, locale) : '';
    const sample = perVariant.map((p) => [p.copy.headline, p.copy.subhead, p.copy.cta, ...(p.copy.features ?? [])].join(' ')).join(' ') + ' ' + names + ' 0123456789 د.ع بسعر levonis-iq.com L E V O N I S 3D · PRINT · MORE';
    const fonts = await ensureNeeds(kitFontNeeds([kit.fonts.primary, kit.fonts.display, ...(template === HOUSE_TEMPLATE ? ['montserrat' as const] : [])], sample));
    if (fonts.failed.length) setError(fill(w(S.fontFailed), { name: fonts.failed.join('، ') }));
    const measure = canvasMeasurer();
    const out: Composition[] = perVariant.map((p) => ({
      variant: p.variant,
      reason: p.reason,
      jobId: p.jobId,
      result: buildFromTemplate({
        template, variant: p.variant, format, locale, objective, density, brand: kit, brandVersion: b.version,
        products: mode === 'multi'
          ? multi.map((m, i) => ({ slot: PRODUCT_SLOTS[i], snapshot: m.snapshot, image: m.picture }))
          : snapshot && picture ? [{ slot: 'main', snapshot, image: picture }] : [],
        service: mode === 'service' && claim ? claimText(claim) : null,
        copy: p.copy, evidence: mode === 'multi' ? NO_EVIDENCE : evidenceFor(product?.id ?? null, snapshot, opportunities), family: mode === 'multi' ? null : family,
        logo: logoNatural(kit, b, assets), backgroundNatural: backgroundNatural(kit, assets),
        slide: null, caption: p.caption, alt_text: p.alt, measure,
      }),
    }));
    setCompositions(out);
  };

  const manualCopy = (): BuildCopy | null => {
    // Without a headline the product's own name leads (bound data, never invented words): manual creation needs no AI and no copy.
    const fallback = mode === 'multi' ? '' : snapshot ? localized(snapshot.data.name, locale) : claim ? localized(claim.title, locale) : '';
    const headline = copy.headline.trim() || fallback;
    if (!headline && mode !== 'multi') {
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
      const jobId = ideaJobFor(prefill, c.headline);
      await build(variants.map((v) => ({ variant: v, copy: c, reason: VARIANT_LABELS[v][lang], caption: copy.caption.trim(), alt: copy.alt.trim(), jobId })));
    } finally {
      setBusy('');
    }
  };

  const composeAi = async () => {
    setError('');
    setBusy('compose');
    try {
      const res = await ai.compose({
        snapshot_id: (mode === 'multi' ? multi[0]?.snapshot.id : snapshot?.id) ?? null, claim_id: mode === 'service' ? claim?.id ?? null : null, objective, priority: prio, density, template, family,
        variants, locale: locale === 'en' ? 'en' : 'ar', brief: brief.trim().slice(0, 600), idempotency_key: idempotencyKey(),
      });
      setComposeInfo({ warnings: res.warnings, missing: res.missing, job_id: res.job_id });
      if (!res.proposals.length) {
        setError(w(S.chatDiffNothing));
        return;
      }
      await build(res.proposals.map((p) => ({
        variant: p.variant, copy: { headline: p.headline, subhead: p.subhead || undefined, cta: p.cta || undefined, features: p.features }, reason: p.reason,
        caption: p.caption || copy.caption.trim(), alt: p.alt_text || copy.alt.trim(), jobId: res.job_id,
      })));
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
      const title = (headline && headline.type === 'text' ? headline.text : '')
        || (mode === 'multi' ? multi.map((m) => localized(m.snapshot.data.name, lang)).join(' · ') : snapshot ? localized(snapshot.data.name, lang) : claim ? localized(claim.title, lang) : w(S.tabNew));
      const input = { title: title.slice(0, 120), content: c.result.doc };
      const origin = createOrigin(c.jobId);
      let created;
      try {
        created = await documents.create({ ...input, ...origin });
      } catch (e) {
        // A job the server will not link (an ideas job already used for another design, a cancelled one): the design is still made, from the template.
        if (origin.origin !== 'ai' || !isJobRefusal(codeOf(e))) throw e;
        created = await documents.create({ ...input, ...createOrigin(null) });
      }
      studio.openDocument(created.id);
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy('');
    }
  };

  const chooseFamily = (f: FamilyId | null) => {
    setFamily(f);
    setCompositions(null);
    setComposeInfo(null);
    if (!f) return;
    const c = familyChoice(f);
    setObjective(c.objective);
    setTemplate(c.template);
    setPriority(c.priority);
  };

  const pictures = snapshot ? snapshot.data.images.filter((i) => i.variant_key === null || variantKey === null || i.variant_key === variantKey) : [];

  return (
    <RemoteView remote={extras} onRetry={reloadExtras}>
      {(ex) => (
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-new-design>
          <div className="flex flex-wrap gap-2">
            <Button variant={mode === 'product' ? 'primary' : 'secondary'} aria-pressed={mode === 'product'} onClick={() => { setMode('product'); setTemplate(HOUSE_TEMPLATE); setObjective('sell'); setFamily(null); setCompositions(null); }}>{w(S.homeStartProduct)}</Button>
            <Button variant={mode === 'multi' ? 'primary' : 'secondary'} aria-pressed={mode === 'multi'} onClick={() => { setMode('multi'); setTemplate('product_grid'); setObjective('sell'); setFamily(null); setCompositions(null); }} data-mode-multi>{w(S.homeStartMulti)}</Button>
            <Button variant={mode === 'service' ? 'primary' : 'secondary'} aria-pressed={mode === 'service'} onClick={() => { setMode('service'); setTemplate('service_card'); setObjective('service_trust'); setFamily('service'); setCompositions(null); }}>{w(S.homeStartService)}</Button>
          </div>

          {mode === 'multi' ? (
            <Card title={w(S.newMultiTitle)} description={w(S.newMultiHint)}>
              <Field label={w(S.newSearch)}>
                <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
              </Field>
              {searchError ? <p className="mt-2 text-sm text-danger" role="alert">{searchError}</p> : null}
              {results && !results.length ? <p className="mt-2 text-sm text-text-muted">{w(S.newSearchEmpty)}</p> : null}
              {results && results.length ? (
                <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-multi-results>
                  {results.map((p) => {
                    const chosen = multi.some((m) => m.snapshot.data.product_id === p.id);
                    return (
                      <li key={p.id}>
                        <button type="button" disabled={chosen || multi.length >= GRID_PRODUCTS.max} className="flex w-full items-center gap-3 rounded-xl border border-border-subtle p-2 text-start disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" aria-pressed={chosen} onClick={() => addToMulti(p.id)}>
                          <span className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface">
                            {p.image ? <VariantImg src={p.image.url} sizes="56px" naturalWidth={p.image.width} alt="" className="h-full w-full object-contain" /> : null}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-text-primary">{localized(p.name, lang)}</span>
                            <span className="block text-xs text-text-muted">{searchPriceLabel(p) ?? w(PRICE_STATUS_TEXT[p.price_status])}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {busy === 'snapshot' ? <p className="mt-2 text-sm text-text-muted" role="status">{w(S.loading)}</p> : null}
              <ol className="mt-4 grid gap-2 sm:grid-cols-2" data-multi-chosen>
                {multi.map((m, i) => (
                  <li key={m.snapshot.id} className="flex items-center gap-3 rounded-xl border border-border-subtle p-2">
                    <span className="text-xs text-text-muted">{i + 1}</span>
                    <span className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface">{m.picture ? <VariantImg src={m.picture.url} sizes="48px" naturalWidth={m.picture.width} alt="" className="h-full w-full object-contain" /> : null}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">{localized(m.snapshot.data.name, lang)}</span>
                      {!m.picture ? <span className="block text-xs text-warning">{w(S.newMultiNoPicture)}</span> : null}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => { setMulti((list) => list.filter((x) => x !== m)); setCompositions(null); }}>{w(S.newMultiRemove)}</Button>
                  </li>
                ))}
              </ol>
              {multi.length < GRID_PRODUCTS.min ? <p className="mt-2 text-xs text-text-muted">{w(S.newMultiNeed)}</p> : null}
            </Card>
          ) : mode === 'product' ? (
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
              {claimMissing ? <p className="mb-2 text-sm text-warning" role="status">{w(S.newIdeaClaimMissing)}</p> : null}
              {ex.claims.filter((c) => c.status === 'approved').length === 0 ? (
                <div className="flex flex-col items-start gap-2" data-no-claims>
                  <p className="text-sm text-text-muted">{w(S.newNoClaims)}</p>
                  <Button size="sm" onClick={() => studio.goTab('claims')} data-open-claims>{w(S.newOpenClaims)}</Button>
                </div>
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

          {(mode === 'service' ? !!claim : mode === 'multi' ? multi.length >= GRID_PRODUCTS.min : !!snapshot) ? (
            <Card title={w(S.newStepGoal)}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {mode === 'product' ? (
                  <Field label={w(S.newFamily)} hint={w(S.newFamilyHint)}>
                    <Select value={family ?? ''} onChange={(e) => chooseFamily(e.target.value ? (e.target.value as FamilyId) : null)} data-family>
                      <option value="">{w(S.newFamilyNone)}</option>
                      {PRODUCT_FAMILIES.map((f) => <option key={f} value={f}>{FAMILIES[f].label[lang]}</option>)}
                    </Select>
                  </Field>
                ) : null}
                <Field label={w(S.newObjective)}>
                  <Select value={objective} onChange={(e) => { const next = e.target.value as Objective; setObjective(next); if (family && FAMILIES[family].objective !== next) setFamily(null); setCompositions(null); setComposeInfo(null); }}>
                    {OBJECTIVES.map((o) => <option key={o} value={o}>{w(OBJECTIVE_TEXT[o])}</option>)}
                  </Select>
                </Field>
                <Field label={w(S.newPriority)} hint={w(S.newPriorityHint)}>
                  <Select value={prio} onChange={(e) => { setPriority(e.target.value as VisualPriority); setCompositions(null); setComposeInfo(null); }} data-priority>
                    {priorities.map((p) => <option key={p} value={p}>{w(PRIORITY_TEXT[p])}</option>)}
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
              {badge.kind !== 'none' ? (
                <p className={`mt-3 text-sm ${badge.kind === 'drawn' ? 'text-success' : 'text-text-secondary'}`} role="status" data-badge-state={badge.kind}>
                  {badge.kind === 'drawn'
                    ? fill(w(S.newBadgeDrawn), { text: badge.text[locale] })
                    : fill(w(badge.needs === 'arrival' ? S.newBadgeNoArrival : badge.needs === 'back_in_stock' ? S.newBadgeNoBack : S.newBadgeNoOffer), { text: badge.text[locale] })}
                </p>
              ) : null}
            </Card>
          ) : null}

          {readyForCompose ? (
            <Card title={w(S.newStepTemplate)} description={mode === 'product' ? w(S.newTemplateAuto) : undefined}>
              {mode === 'product' ? (
                <div className="flex flex-wrap gap-2">
                  {PRODUCT_TEMPLATES.map((t) => <Button key={t} size="sm" variant={template === t ? 'primary' : 'secondary'} aria-pressed={template === t} onClick={() => { setTemplate(t); setCompositions(null); }}>{TEMPLATES[t].label[lang]}</Button>)}
                </div>
              ) : <p className="text-sm text-text-secondary">{TEMPLATES[mode === 'multi' ? 'product_grid' : 'service_card'].label[lang]}</p>}
              <p className="mt-2 text-xs text-text-muted">{variants.map((v) => VARIANT_LABELS[v][lang]).join(' · ')}</p>
              <p className="mt-1 text-xs text-text-muted" data-composition-count={variants.length}>{fill(w(S.newCompositionCount), { n: variants.length })}</p>
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
                  <Field label={w(S.newHeadline)} hint={mode === 'service' ? undefined : w(S.newHeadlineOptional)}><Input value={copy.headline} maxLength={90} onChange={(e) => setCopy({ ...copy, headline: e.target.value })} data-copy-headline /></Field>
                  <Field label={w(S.newSubhead)} optional><Input value={copy.subhead} maxLength={160} onChange={(e) => setCopy({ ...copy, subhead: e.target.value })} /></Field>
                  <Field label={w(S.newFeatures)} optional><Textarea rows={3} value={copy.features} onChange={(e) => setCopy({ ...copy, features: e.target.value })} /></Field>
                  <Field label={w(S.newCta)} optional><Input value={copy.cta} maxLength={40} onChange={(e) => setCopy({ ...copy, cta: e.target.value })} /></Field>
                  <Field label={w(S.newCaption)} optional><Textarea rows={2} value={copy.caption} maxLength={MAX_CAPTION_CHARS} onChange={(e) => setCopy({ ...copy, caption: e.target.value })} data-copy-caption /></Field>
                  <Field label={w(S.newAlt)} optional><Input value={copy.alt} maxLength={MAX_ALT_CHARS} onChange={(e) => setCopy({ ...copy, alt: e.target.value })} data-copy-alt /></Field>
                  <Button loading={busy === 'compose'} onClick={buildManual} data-build-manual>{w(S.newBuild)}</Button>
                </section>
              </div>
              {composeInfo?.missing.length ? <p className="mt-3 text-sm text-warning">{fill(w(S.newMissingFacts), { list: composeInfo.missing.join('، ') })}</p> : null}
              {composeInfo?.warnings.length ? <ul className="mt-2 list-disc ps-5 text-xs text-text-muted">{composeInfo.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
            </Card>
          ) : null}

          <div ref={resultsRef} className="scroll-mt-4" />
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
