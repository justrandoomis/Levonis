/**
 * «كاروسيل» — a carousel is N linked designs (spec §20): kind 'slide', the
 * first slide has no parent and every other slide names it (`parent_id`),
 * each built from the lesson-slide template with its number «2/5». The words
 * come from Claude's plan (POST /ai/carousel, editable before anything is
 * made; the slides then cite that job, origin 'ai') or are typed by a person
 * (empty slides; always so for Sorani). Each slide opens in the editor, and
 * «export all» draws every slide through the editor's renderer, downloads it
 * and records it as a DRAFT export — a final export still needs approval in
 * the editor. Creation is sequential with one idempotency key per slide, so a
 * retry never makes a slide twice.
 */
import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Checkbox } from '../ui/Switch';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { StatusChip } from '../ui/Badge';
import { AI_COPY_LOCALES, type CarouselSlidePlan } from '../../../packages/creativeDoc/src/aiContracts';
import type { DocumentSummaryDto, ProductListItemDto } from '../../../packages/creativeDoc/src/api';
import { buildFromTemplate } from '../../../packages/creativeDoc/src/layout';
import { FORMATS, type AdLocale, type FormatId } from '../../../packages/creativeDoc/src/schema';
import { localized, type ProductSnapshot } from '../../../packages/creativeDoc/src/snapshot';
import { containsPriceLike } from '../../../packages/creativeDoc/src/text';
import { carousel, documents, idempotencyKey, store } from './client';
import { backgroundNatural, evidenceFor, logoNatural } from './editorData';
import { canvasMeasurer } from './media';
import { renderDocument } from './DocThumb';
import { ProductPicker } from './ProductPicker';
import { CampaignSelect } from './CampaignsTab';
import { firstPicture, loadBuildKit, loadFonts } from './planningKit';
import { carouselGroups } from './planningModel';
import { FORMAT_TEXT, LOCALE_TEXT, STATUS_TEXT, S, fill } from './strings';
import { AiNotReady, RemoteView, canvasBlob, downloadBlob, failText, useRemote, useStudio, useText } from './shared';

interface SlideDraft { headline: string; body: string; uses_product: boolean }

const blank = (): SlideDraft => ({ headline: '', body: '', uses_product: false });

export default function CarouselTab() {
  const studio = useStudio();
  const { lang, w } = useText();
  const [name, setName] = useState('');
  const [count, setCount] = useState(5);
  const [formatId, setFormatId] = useState<Exclude<FormatId, 'custom'>>('portrait');
  const [locale, setLocale] = useState<AdLocale>(lang === 'en' ? 'en' : 'ar');
  const [campaignId, setCampaignId] = useState('');
  const [topic, setTopic] = useState('');
  const [product, setProduct] = useState<ProductListItemDto | null>(null);
  const [plan, setPlan] = useState<SlideDraft[] | null>(null);
  const [caption, setCaption] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [rejected, setRejected] = useState(0);
  const [busy, setBusy] = useState<'' | 'plan' | 'create' | 'export'>('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const runKey = useRef('');
  const [slides, reloadSlides] = useRemote(() => documents.list({ kind: 'slide', limit: 100 }), []);

  const aiReady = studio.provider?.ready === true && (AI_COPY_LOCALES as readonly string[]).includes(locale);

  const snapshotOf = async (): Promise<ProductSnapshot | null> => (product ? store.snapshot(product.id, null) : null);

  const askPlan = async () => {
    setError('');
    setBusy('plan');
    try {
      const snap = await snapshotOf();
      const res = await carousel.plan({
        snapshot_id: snap?.id ?? null, claim_id: null, topic: topic.trim().slice(0, 300), slides: count, locale: locale === 'en' ? 'en' : 'ar', idempotency_key: idempotencyKey(),
      });
      setPlan(res.slides.map((s: CarouselSlidePlan) => ({ headline: s.headline, body: s.body, uses_product: s.uses_product && !!product })));
      setCaption(res.caption);
      setJobId(res.job_id);
      setRejected(res.rejected);
      runKey.current = '';
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy('');
    }
  };

  const startManual = () => {
    setPlan(Array.from({ length: count }, blank));
    setCaption('');
    setJobId(null);
    setRejected(0);
    runKey.current = '';
  };

  const editSlide = (i: number, patch: Partial<SlideDraft>) => {
    setPlan((p) => (p ? p.map((s, j) => (j === i ? { ...s, ...patch } : s)) : p));
    runKey.current = '';
  };

  const create = async () => {
    if (!plan?.length) return;
    setError('');
    setMessage('');
    if (plan.some((s) => !s.headline.trim())) return setError(w(S.carHeadlineRequired));
    if (plan.some((s) => containsPriceLike(s.headline) || containsPriceLike(s.body)) || containsPriceLike(caption)) return setError(w(S.wordsNoPrice));
    setBusy('create');
    // One key per run: pressing again after a failure answers the slides already made.
    if (!runKey.current) runKey.current = idempotencyKey();
    try {
      const kit = await loadBuildKit(studio.brand);
      const snap = plan.some((s) => s.uses_product) ? await snapshotOf() : null;
      const picture = snap ? await firstPicture(snap) : null;
      if (snap && !picture) setMessage(w(S.carNoPicture));
      const failed = await loadFonts(kit, plan.map((s) => `${s.headline} ${s.body}`).join(' '));
      if (failed.length) setError(fill(w(S.fontFailed), { name: failed.join('، ') }));
      const measure = canvasMeasurer();
      const b = kit.brand;
      const title = name.trim() || plan[0]!.headline.trim();
      let firstId: string | null = null;
      setProgress({ done: 0, total: plan.length });
      for (let i = 0; i < plan.length; i++) {
        const s = plan[i]!;
        const result = buildFromTemplate({
          template: 'education_slide', variant: 'feature_first', format: { ...FORMATS[formatId] }, locale, objective: 'education', density: 'detailed',
          brand: b.kit, brandVersion: b.version,
          products: s.uses_product && snap && picture ? [{ slot: 'main', snapshot: snap, image: picture }] : [],
          service: null, copy: { headline: s.headline.trim(), body: s.body.trim() || undefined },
          evidence: evidenceFor(product?.id ?? null, snap, kit.opportunities), family: 'education',
          logo: logoNatural(b.kit, b, kit.assets), backgroundNatural: backgroundNatural(b.kit, kit.assets),
          slide: { index: i + 1, count: plan.length }, caption: i === 0 ? caption.trim() : '', alt_text: '', measure,
        });
        const made = await documents.create({
          title: `${title} · ${i + 1}/${plan.length}`.slice(0, 120), content: result.doc, kind: 'slide', parent_id: firstId,
          campaign_id: campaignId || null, idempotency_key: `${runKey.current}_${i}`,
          ...(jobId ? { origin: 'ai' as const, job_id: jobId } : { origin: 'template' as const, job_id: null }),
        });
        if (i === 0) firstId = made.id;
        setProgress({ done: i + 1, total: plan.length });
      }
      setPlan(null);
      setJobId(null);
      runKey.current = '';
      reloadSlides();
      if (firstId) studio.openDocument(firstId);
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy('');
    }
  };

  const exportAll = async (group: DocumentSummaryDto[]) => {
    setError('');
    setMessage('');
    setBusy('export');
    setProgress({ done: 0, total: group.length });
    try {
      for (let i = 0; i < group.length; i++) {
        const d = await documents.get(group[i]!.id);
        const { canvas } = await renderDocument(d.content, d.content.format.width);
        const blob = await canvasBlob(canvas, 'image/png');
        if (!blob) throw new Error(w(S.editorLoadFailed));
        downloadBlob(blob, `carousel-${String(i + 1).padStart(2, '0')}.png`);
        await documents.uploadExport(d.id, { file: blob, kind: 'png', version: d.version, final: false, width: canvas.width, height: canvas.height });
        setProgress({ done: i + 1, total: group.length });
      }
      setMessage(w(S.carExported));
      reloadSlides();
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-carousel-tab>
      <Card title={w(S.carNewTitle)} description={w(S.carIntro)}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={w(S.carName)} optional><Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={w(S.carCount)}>
            <Select value={String(count)} onChange={(e) => { setCount(Number(e.target.value)); setPlan(null); }}>
              {Array.from({ length: 9 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </Field>
          <Field label={w(S.newFormat)}>
            <Select value={formatId} onChange={(e) => setFormatId(e.target.value as Exclude<FormatId, 'custom'>)}>
              {(['square', 'portrait', 'story'] as const).map((f) => <option key={f} value={f}>{w(FORMAT_TEXT[f])}</option>)}
            </Select>
          </Field>
          <Field label={w(S.newLocale)}>
            <Select value={locale} onChange={(e) => { setLocale(e.target.value as AdLocale); setPlan(null); }}>
              {(['ar', 'en', 'ckb'] as const).map((l) => <option key={l} value={l}>{w(LOCALE_TEXT[l])}</option>)}
            </Select>
          </Field>
          <CampaignSelect value={campaignId} onChange={setCampaignId} />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <section className="flex flex-col gap-2">
            {aiReady ? (
              <>
                <Field label={w(S.carTopic)}><Textarea rows={2} value={topic} maxLength={300} onChange={(e) => setTopic(e.target.value)} /></Field>
                {product ? (
                  <p className="text-sm text-text-secondary">{w(S.carProduct)}: {localized(product.name, lang)} <Button size="sm" variant="ghost" onClick={() => setProduct(null)}>{w(S.remove)}</Button></p>
                ) : <ProductPicker label={w(S.carProduct)} onPick={setProduct} />}
                <Button variant="primary" loading={busy === 'plan'} disabled={!!busy} onClick={askPlan} data-carousel-ask>{w(S.carAskPlan)}</Button>
              </>
            ) : locale === 'ckb' ? <p className="text-sm text-text-secondary">{w(S.carCkbManual)}</p> : <AiNotReady provider={studio.provider} onSettings={() => studio.goTab('settings')} />}
          </section>
          <section className="flex flex-col items-start gap-2">
            <Button disabled={!!busy} onClick={startManual} data-carousel-manual>{w(S.carManual)}</Button>
          </section>
        </div>
      </Card>

      {plan ? (
        <Card title={w(S.carPlan)} description={w(S.carPlanHint)}>
          {rejected ? <p className="mb-2 text-sm text-warning">{fill(w(S.carRejected), { n: rejected })}</p> : null}
          <ol className="flex flex-col gap-3" data-carousel-plan>
            {plan.map((s, i) => (
              <li key={i} className="rounded-xl border border-border-subtle p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-text-primary">{fill(w(S.carSlideN), { n: i + 1 })}</span>
                  {plan.length > 2 ? <Button size="sm" variant="ghost" onClick={() => setPlan(plan.filter((_, j) => j !== i))}>{w(S.remove)}</Button> : null}
                </div>
                <Field label={w(S.carHeadline)}><Input value={s.headline} maxLength={90} onChange={(e) => editSlide(i, { headline: e.target.value })} /></Field>
                <Field label={w(S.carBody)} optional><Textarea rows={2} value={s.body} maxLength={360} onChange={(e) => editSlide(i, { body: e.target.value })} /></Field>
                {product ? <Checkbox className="mt-2" checked={s.uses_product} onChange={(next) => editSlide(i, { uses_product: next })} label={w(S.carUsesProduct)} /> : null}
              </li>
            ))}
          </ol>
          <Field label={w(S.carCaption)} optional className="mt-3"><Textarea rows={3} value={caption} maxLength={1500} onChange={(e) => { setCaption(e.target.value); runKey.current = ''; }} /></Field>
          <Button className="mt-3" variant="primary" loading={busy === 'create'} disabled={!!busy} onClick={create} data-carousel-create>{w(S.carCreate)}</Button>
        </Card>
      ) : null}

      {progress && busy ? <p className="text-sm text-text-muted" role="status">{fill(w(S.progressOf), progress)}</p> : null}
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      {message ? <p className="text-sm text-text-secondary" role="status">{message}</p> : null}

      <Card title={w(S.carList)}>
        <RemoteView remote={slides} onRetry={reloadSlides} compact>
          {(data) => {
            const groups = carouselGroups(data.documents);
            if (!groups.length) return <p className="text-sm text-text-muted">{w(S.carListEmpty)}</p>;
            return (
              <ul className="flex flex-col gap-3" data-carousel-list>
                {groups.map((g) => (
                  <li key={g[0]!.id} className="rounded-xl border border-border-subtle p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{g[0]!.title}</span>
                      <span className="text-xs text-text-muted">{fill(w(S.carSlides), { n: g.length })}</span>
                      <Button size="sm" loading={busy === 'export'} disabled={!!busy} onClick={() => exportAll(g)}>{w(S.carExportAll)}</Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {g.map((s, i) => (
                        <Button key={s.id} size="sm" variant="secondary" onClick={() => studio.openDocument(s.id)} aria-label={`${fill(w(S.carSlideN), { n: i + 1 })} · ${w(STATUS_TEXT[s.status])}`}>
                          {i + 1} <StatusChip tone={s.status === 'approved' ? 'success' : s.status === 'in_review' ? 'info' : 'neutral'}>{w(STATUS_TEXT[s.status])}</StatusChip>
                        </Button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            );
          }}
        </RemoteView>
      </Card>
    </div>
  );
}
