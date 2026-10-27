/**
 * «إنتاج دفعة» — Batch Create (spec §21), client-side and WITHOUT AI: pick
 * several products, a template, a composition, a size and a language; one
 * design is built per product with `buildFromTemplate` from that product's
 * OWN snapshot and picture (a picture or price never crosses to another
 * product's card), one after another, with progress. Each result says what
 * it needs — ready for review, a text edit, a missing picture, a price issue,
 * or failed — and opens in the editor on its own. «Stop» ends the run after
 * the current product; «retry the failed ones» runs only those, and every
 * product carries one idempotency key per run, so a retry never makes a
 * second design.
 */
import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, Input, Select } from '../ui/Field';
import { StatusChip } from '../ui/Badge';
import type { ProductListItemDto } from '../../../packages/creativeDoc/src/api';
import { buildFromTemplate } from '../../../packages/creativeDoc/src/layout';
import { FORMATS, OBJECTIVES, type AdLocale, type FormatId, type Objective } from '../../../packages/creativeDoc/src/schema';
import { localized } from '../../../packages/creativeDoc/src/snapshot';
import { TEMPLATES, VARIANT_LABELS, type TemplateId, type VariantId } from '../../../packages/creativeDoc/src/templates';
import { containsPriceLike } from '../../../packages/creativeDoc/src/text';
import { documents, idempotencyKey, store } from './client';
import { backgroundNatural, evidenceFor, logoNatural } from './editorData';
import { canvasMeasurer } from './media';
import { ProductChip, ProductPicker } from './ProductPicker';
import { CampaignSelect } from './CampaignsTab';
import { firstPicture, loadBuildKit, loadFonts, type BuildKit } from './planningKit';
import { batchState, templateVariants, type BatchState } from './planningModel';
import { FORMAT_TEXT, LOCALE_TEXT, OBJECTIVE_TEXT, S, fill, type Tri } from './strings';
import { failText, useStudio, useText } from './shared';

const MAX_PRODUCTS = 20;
const BATCH_TEMPLATES: TemplateId[] = ['product_hero', 'compact_product'];

interface Item { product: ProductListItemDto; state: BatchState; docId: string | null; error: string }

const STATE_TEXT: Readonly<Record<BatchState, Tri>> = {
  pending: S.batchPending, working: S.batchWorking, ready: S.batchReady, needs_text: S.batchNeedsText,
  missing_asset: S.batchMissingAsset, price_issue: S.batchPriceIssue, failed: S.batchFailed,
};
const STATE_TONE: Readonly<Record<BatchState, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = {
  pending: 'neutral', working: 'info', ready: 'success', needs_text: 'warning', missing_asset: 'warning', price_issue: 'warning', failed: 'danger',
};

export default function BatchTab() {
  const studio = useStudio();
  const { lang, w } = useText();
  const [items, setItems] = useState<Item[]>([]);
  const [template, setTemplate] = useState<TemplateId>('product_hero');
  const [variant, setVariant] = useState<VariantId>(templateVariants('product_hero')[0]!);
  const [formatId, setFormatId] = useState<Exclude<FormatId, 'custom'>>('square');
  const [locale, setLocale] = useState<AdLocale>(lang === 'en' ? 'en' : 'ar');
  const [objective, setObjective] = useState<Objective>('sell');
  const [headline, setHeadline] = useState('');
  const [cta, setCta] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const stopRef = useRef(false);
  const runKey = useRef('');

  const settingsChanged = () => { runKey.current = ''; };
  const patch = (id: string, p: Partial<Item>) => setItems((list) => list.map((x) => (x.product.id === id ? { ...x, ...p } : x)));

  const add = (p: ProductListItemDto) => {
    setItems((list) => (list.some((x) => x.product.id === p.id) || list.length >= MAX_PRODUCTS ? list : [...list, { product: p, state: 'pending', docId: null, error: '' }]));
  };

  const one = async (kit: BuildKit, item: Item, index: number) => {
    patch(item.product.id, { state: 'working', error: '' });
    try {
      const snapshot = await store.snapshot(item.product.id, null);
      const picture = await firstPicture(snapshot);
      if (!picture) return patch(item.product.id, { state: 'missing_asset' });
      const name = localized(snapshot.data.name, locale);
      const b = kit.brand;
      const result = buildFromTemplate({
        template, variant, format: { ...FORMATS[formatId] }, locale, objective, density: 'brief', brand: b.kit, brandVersion: b.version,
        products: [{ slot: 'main', snapshot, image: picture }], service: null,
        copy: { headline: headline.trim() || name, cta: cta.trim() || undefined },
        evidence: evidenceFor(item.product.id, snapshot, kit.opportunities), family: null,
        logo: logoNatural(b.kit, b, kit.assets), backgroundNatural: backgroundNatural(b.kit, kit.assets),
        slide: null, caption: '', alt_text: '', measure: canvasMeasurer(),
      });
      const made = await documents.create({
        title: name.slice(0, 120) || item.product.id, content: result.doc, kind: 'post', campaign_id: campaignId || null,
        origin: 'template', job_id: null, idempotency_key: `${runKey.current}_${index}`,
      });
      patch(item.product.id, { state: batchState(template, variant, snapshot, result), docId: made.id });
    } catch (e) {
      patch(item.product.id, { state: 'failed', error: failText(e, lang) });
    }
  };

  const run = async (onlyFailed: boolean) => {
    setError('');
    setMessage('');
    if ([headline, cta].some((t) => containsPriceLike(t))) return setError(w(S.wordsNoPrice));
    if (!runKey.current) runKey.current = idempotencyKey();
    const todo = items.map((x, i) => ({ x, i })).filter(({ x }) => (onlyFailed ? x.state === 'failed' : x.state === 'pending' || x.state === 'failed'));
    if (!todo.length) return;
    setRunning(true);
    stopRef.current = false;
    try {
      const kit = await loadBuildKit(studio.brand);
      const failed = await loadFonts(kit, `${headline} ${cta} ${items.map((x) => localized(x.product.name, locale)).join(' ')}`);
      if (failed.length) setError(fill(w(S.fontFailed), { name: failed.join('، ') }));
      // One at a time: the layout measures with the page's canvas, and the server is never flooded.
      for (const { x, i } of todo) {
        if (stopRef.current) {
          setMessage(w(S.stopped));
          break;
        }
        await one(kit, x, i);
      }
    } catch (e) {
      setError(failText(e, lang));
    } finally {
      setRunning(false);
    }
  };

  const done = items.filter((x) => x.state !== 'pending' && x.state !== 'working').length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4" data-batch-tab>
      <Card title={w(S.tabBatch)} description={w(S.batchIntro)}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={w(S.batchTemplate)}>
            <Select value={template} disabled={running} onChange={(e) => { const t = e.target.value as TemplateId; setTemplate(t); setVariant(templateVariants(t)[0]!); settingsChanged(); }}>
              {BATCH_TEMPLATES.map((t) => <option key={t} value={t}>{TEMPLATES[t].label[lang]}</option>)}
            </Select>
          </Field>
          <Field label={w(S.batchVariant)}>
            <Select value={variant} disabled={running} onChange={(e) => { setVariant(e.target.value as VariantId); settingsChanged(); }}>
              {templateVariants(template).map((v) => <option key={v} value={v}>{VARIANT_LABELS[v][lang]}</option>)}
            </Select>
          </Field>
          <Field label={w(S.newFormat)}>
            <Select value={formatId} disabled={running} onChange={(e) => { setFormatId(e.target.value as Exclude<FormatId, 'custom'>); settingsChanged(); }}>
              {(['square', 'portrait', 'story'] as const).map((f) => <option key={f} value={f}>{w(FORMAT_TEXT[f])}</option>)}
            </Select>
          </Field>
          <Field label={w(S.newObjective)}>
            <Select value={objective} disabled={running} onChange={(e) => { setObjective(e.target.value as Objective); settingsChanged(); }}>
              {OBJECTIVES.map((o) => <option key={o} value={o}>{w(OBJECTIVE_TEXT[o])}</option>)}
            </Select>
          </Field>
          <Field label={w(S.newLocale)}>
            <Select value={locale} disabled={running} onChange={(e) => { setLocale(e.target.value as AdLocale); settingsChanged(); }}>
              {(['ar', 'en', 'ckb'] as const).map((l) => <option key={l} value={l}>{w(LOCALE_TEXT[l])}</option>)}
            </Select>
          </Field>
          <CampaignSelect value={campaignId} onChange={(id) => { setCampaignId(id); settingsChanged(); }} />
          <Field label={w(S.batchHeadline)} optional className="sm:col-span-2"><Input value={headline} maxLength={90} disabled={running} onChange={(e) => { setHeadline(e.target.value); settingsChanged(); }} /></Field>
          <Field label={w(S.newCta)} optional><Input value={cta} maxLength={40} disabled={running} onChange={(e) => { setCta(e.target.value); settingsChanged(); }} /></Field>
        </div>
      </Card>

      <Card title={w(S.batchProducts)} description={fill(w(S.batchMax), { n: MAX_PRODUCTS })}>
        {!running && items.length < MAX_PRODUCTS ? <ProductPicker label={w(S.batchAdd)} onPick={add} /> : null}
        {items.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {items.map((x) => <ProductChip key={x.product.id} id={x.product.id} name={x.product.name} onRemove={running ? undefined : () => setItems(items.filter((y) => y.product.id !== x.product.id))} />)}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" loading={running} disabled={running || !items.some((x) => x.state === 'pending' || x.state === 'failed')} onClick={() => run(false)} data-batch-run>{w(S.batchRun)}</Button>
          {running ? <Button variant="secondary" onClick={() => { stopRef.current = true; }}>{w(S.stop)}</Button> : null}
          {!running && items.some((x) => x.state === 'failed') ? <Button onClick={() => run(true)}>{w(S.batchRetry)}</Button> : null}
        </div>
        {running || done ? <p className="mt-2 text-sm text-text-muted" role="status">{fill(w(S.progressOf), { done, total: items.length })}</p> : null}
        {error ? <p className="mt-2 text-sm text-danger" role="alert">{error}</p> : null}
        {message ? <p className="mt-2 text-sm text-text-secondary" role="status">{message}</p> : null}
      </Card>

      {done ? (
        <Card title={w(S.batchResults)}>
          <ul className="flex flex-col gap-2" data-batch-results>
            {items.map((x) => (
              <li key={x.product.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border-subtle p-2" data-batch-state={x.state}>
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{localized(x.product.name, lang)}</span>
                <StatusChip tone={STATE_TONE[x.state]}>{w(STATE_TEXT[x.state])}</StatusChip>
                {x.error ? <span className="w-full text-xs text-danger">{x.error}</span> : null}
                {x.docId ? <Button size="sm" onClick={() => studio.openDocument(x.docId!)}>{w(S.open)}</Button> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
