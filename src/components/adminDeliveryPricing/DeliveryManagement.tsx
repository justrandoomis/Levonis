/**
 * «إدارة التوصيل» — ONE page for the store's standard delivery (owner,
 * 2026-10-18): the default price, governorate exceptions, the rule groups by
 * section / product, how they combine (with a simulator running the SAME pure
 * `deliveryCharge` the checkout prices with) and the delivery company's tax.
 *
 * Saved as ONE document: PUT /api/admin/settings/deliveryPolicy. The server's
 * strict validator is the authority; its refusals appear inline here.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Save, Trash2, Truck, Check, CornerDownLeft } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, formatIqd } from '../../lib/api';
import CourierTaxPanel from '../adminWallet/CourierTaxPanel';
import ProductPicker from '../adminProducts/form/ProductPicker';
import type { CatalogNode } from '../adminTaxonomy/shared';
import { IRAQ_GOVERNORATES } from '../../../packages/shipping/src/iraqGovernorates';
import {
  deliveryCharge,
  groupChargeExample,
  type DeliveryMode,
  type DeliveryPolicy,
  type DeliveryRuleGroup,
  type GovernorateRule,
} from '../../../packages/shipping/src/storeDelivery';

type Loc = (ar: string, en: string, ckb?: string) => string;
type ProductInfo = { name_ar: string; name_en: string; name_ckb: string; category_id: string | null; sub_category_id: string | null };
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const MODES: Array<{ id: DeliveryMode; label: (loc: Loc) => string }> = [
  { id: 'flat', label: (loc) => loc('ثابت للطلب', 'Flat per order', 'جێگیر بۆ داواکاری') },
  { id: 'per_piece', label: (loc) => loc('لكل قطعة', 'Per piece', 'بۆ هەر پارچەیەک') },
  { id: 'per_block', label: (loc) => loc('لكل N قطع', 'Per N pieces', 'بۆ هەر N پارچە') },
  { id: 'stopped', label: (loc) => loc('لا يُوصَّل', 'Not delivered', 'ناگەیەنرێت') },
];

const newGroupId = () => `g_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/** catalog id → itself and every parent, nearest first (the server's `catalogAncestry`). */
function ancestry(catalogs: CatalogNode[]): Map<string, string[]> {
  const parent = new Map(catalogs.map((c) => [c.id, c.parent_id]));
  const out = new Map<string, string[]>();
  for (const c of catalogs) {
    const chain: string[] = [];
    let cur: string | null | undefined = c.id;
    while (cur && !chain.includes(cur)) {
      chain.push(cur);
      cur = parent.get(cur) ?? null;
    }
    out.set(c.id, chain);
  }
  return out;
}

/** Catalogs in tree order with their depth, for an indented picker. */
function treeOrder(catalogs: CatalogNode[]): Array<{ node: CatalogNode; depth: number }> {
  const kids = new Map<string | null, CatalogNode[]>();
  for (const c of catalogs) {
    const k = c.parent_id && catalogs.some((p) => p.id === c.parent_id) ? c.parent_id : null;
    kids.set(k, [...(kids.get(k) ?? []), c]);
  }
  const out: Array<{ node: CatalogNode; depth: number }> = [];
  const walk = (id: string | null, depth: number) => {
    for (const c of (kids.get(id) ?? []).sort((a, b) => a.sort - b.sort)) {
      out.push({ node: c, depth });
      if (depth < 6) walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export default function DeliveryManagement() {
  const { lang, loc } = useLanguage();
  const [policy, setPolicy] = useState<DeliveryPolicy | null>(null);
  const [products, setProducts] = useState<Record<string, ProductInfo>>({});
  const [catalogs, setCatalogs] = useState<CatalogNode[]>([]);
  const [loadError, setLoadError] = useState('');
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get<{ policy: DeliveryPolicy; products: Record<string, ProductInfo> }>('/api/admin/delivery-policy'),
      api.get<{ catalogs: CatalogNode[] }>('/api/admin/taxonomy/catalogs').catch(() => ({ catalogs: [] as CatalogNode[] })),
    ])
      .then(([p, c]) => {
        if (!live) return;
        setPolicy(p.policy);
        setProducts(p.products ?? {});
        setCatalogs(c.catalogs ?? []);
      })
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  // «تعديل في إدارة التوصيل» from the product form lands on #rule-<id>.
  const loaded = policy !== null;
  useEffect(() => {
    if (!loaded) return;
    try {
      const hash = window.location.hash;
      if (hash.startsWith('#rule-')) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
    } catch {
      /* a missing anchor is not an error */
    }
  }, [loaded]);

  const index = useMemo(() => ancestry(catalogs), [catalogs]);
  const tree = useMemo(() => treeOrder(catalogs), [catalogs]);
  const catalogName = (id: string) => {
    const c = catalogs.find((x) => x.id === id);
    return c ? (lang === 'en' ? c.name_en : lang === 'ckb' ? c.name_ckb || c.name_ar : c.name_ar) || id : id;
  };
  const productName = (id: string) => {
    const p = products[id];
    return p ? (lang === 'en' ? p.name_en : lang === 'ckb' ? p.name_ckb || p.name_ar : p.name_ar) || p.name_en || id : id;
  };
  const productPath = (id: string): string[] => {
    const p = products[id];
    if (!p) return [];
    const out = new Set<string>();
    for (const c of [p.sub_category_id, p.category_id]) if (c) for (const s of index.get(c) ?? [c]) out.add(s);
    return [...out];
  };

  if (loadError) return <div className="lv-surface p-6 text-danger" role="alert">{loadError}</div>;
  if (!policy) return <div className="lv-surface p-6 text-text-secondary">{loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</div>;

  const update = (next: DeliveryPolicy) => {
    setPolicy(next);
    setState('dirty');
    setError('');
  };
  const setGroup = (id: string, patch: Partial<DeliveryRuleGroup>) =>
    update({ ...policy, groups: policy.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) });
  const removeGroup = (id: string) => update({ ...policy, groups: policy.groups.filter((g) => g.id !== id) });
  const addGroup = (seed?: Partial<DeliveryRuleGroup>) => {
    const g: DeliveryRuleGroup = {
      id: newGroupId(),
      name: { ar: '', en: '', ckb: '' },
      enabled: true,
      mode: 'per_piece',
      fee_iqd: 5_000,
      block_size: 1,
      catalog_ids: [],
      product_ids: [],
      ...seed,
    };
    update({ ...policy, groups: [...policy.groups, g] });
  };
  /** Which enabled group already holds a catalog / product (the validator's rule). */
  const owner = (kind: 'catalog' | 'product', id: string, except: string) =>
    policy.groups.find((g) => g.enabled && g.id !== except && (kind === 'catalog' ? g.catalog_ids : g.product_ids).includes(id));

  /** Display-only nesting: a product-only group whose products sit inside a section group. */
  const parentOf = (g: DeliveryRuleGroup): DeliveryRuleGroup | undefined => {
    if (g.catalog_ids.length || !g.product_ids.length) return undefined;
    return policy.groups.find(
      (p) => p.id !== g.id && p.catalog_ids.length > 0 && g.product_ids.every((pid) => productPath(pid).some((c) => p.catalog_ids.includes(c)))
    );
  };
  const topGroups = policy.groups.filter((g) => !parentOf(g));

  const save = async () => {
    setState('saving');
    setError('');
    try {
      await api.put('/api/admin/settings/deliveryPolicy', { value: policy });
      const fresh = await api.get<{ policy: DeliveryPolicy; products: Record<string, ProductInfo> }>('/api/admin/delivery-policy');
      setPolicy(fresh.policy);
      setProducts((prev) => ({ ...prev, ...fresh.products }));
      setState('saved');
    } catch (e) {
      setState('error');
      const m = e instanceof ApiError ? (e.details?.message as { ar?: string; en?: string; ckb?: string } | undefined) : undefined;
      setError(m ? loc(m.ar ?? '', m.en ?? '', m.ckb) : e instanceof Error ? e.message : loc('تعذّر الحفظ', 'Save failed', 'پاشەکەوتکردن سەرکەوتوو نەبوو'));
    }
  };

  const renderGroup = (g: DeliveryRuleGroup, nested = false) => {
    const example = groupChargeExample(g);
    const children = policy.groups.filter((c) => parentOf(c)?.id === g.id);
    return (
      <div key={g.id} id={`rule-${g.id}`} className={`lv-surface p-4 space-y-3 ${nested ? 'ms-4 border-s-2 border-[var(--ap-accent,currentColor)]' : ''}`} data-delivery-group={g.id}>
        <div className="flex items-center justify-between gap-2">
          <label className="inline-flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={g.enabled} onChange={(e) => setGroup(g.id, { enabled: e.target.checked })} />
            {loc('مفعّلة', 'Enabled', 'چالاکە')}
          </label>
          <span className="text-[11px] text-text-muted" dir="ltr">{g.id}</span>
          <button type="button" className="lv-button lv-button-danger px-3" onClick={() => removeGroup(g.id)} aria-label={loc('حذف القاعدة', 'Delete rule', 'سڕینەوەی یاسا')}>
            <Trash2 className="w-4 h-4" aria-hidden />
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {(['ar', 'en', 'ckb'] as const).map((k) => (
            <label key={k} className="block">
              <span className="block text-[12px] text-text-secondary mb-1">
                {k === 'ar' ? loc('الاسم بالعربية', 'Name (Arabic)', 'ناو بە عەرەبی') : k === 'en' ? loc('الاسم بالإنجليزية', 'Name (English)', 'ناو بە ئینگلیزی') : loc('الاسم بالكردية', 'Name (Kurdish)', 'ناو بە کوردی')}
              </span>
              <input className="lv-input" dir={k === 'en' ? 'ltr' : 'rtl'} value={g.name[k]} maxLength={80} onChange={(e) => setGroup(g.id, { name: { ...g.name, [k]: e.target.value } })} />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={loc('طريقة التسعير', 'Pricing mode', 'شێوازی نرخدانان')}>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={g.mode === m.id}
              className={`lv-button px-3 h-9 text-[13px] ${g.mode === m.id ? 'lv-button-primary' : ''}`}
              onClick={() => setGroup(g.id, { mode: m.id, block_size: m.id === 'per_block' ? Math.max(2, g.block_size) : 1 })}
            >
              {m.label(loc)}
            </button>
          ))}
        </div>
        {g.mode !== 'stopped' && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[12px] text-text-secondary mb-1">{loc('الرسم (د.ع)', 'Fee (IQD)', 'کرێ (دینار)')}</span>
              <input className="lv-input tabular-nums" type="number" min={0} step={250} dir="ltr" value={g.fee_iqd} onChange={(e) => setGroup(g.id, { fee_iqd: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })} />
            </label>
            {g.mode === 'per_block' && (
              <label className="block">
                <span className="block text-[12px] text-text-secondary mb-1">{loc('عدد القطع في الدفعة (N)', 'Pieces per block (N)', 'ژمارەی پارچە لە کۆمەڵەیەکدا (N)')}</span>
                <input className="lv-input tabular-nums" type="number" min={2} step={1} dir="ltr" value={g.block_size} onChange={(e) => setGroup(g.id, { block_size: Math.max(2, Math.trunc(Number(e.target.value) || 2)) })} />
              </label>
            )}
          </div>
        )}
        {example.length > 0 && (
          <p className="text-[12px] text-text-muted tabular-nums" data-delivery-example dir="ltr">
            {example
              .map((s) => (s.to === Infinity ? `${loc('أي عدد', 'any number', 'هەر ژمارەیەک')} → ${formatIqd(s.fee_iqd)}` : `${s.from === s.to ? s.from : `${s.from}–${s.to}`} → ${formatIqd(s.fee_iqd)}`))
              .join(' · ')}
          </p>
        )}
        <div className="space-y-1.5">
          <span className="block text-[12px] font-semibold text-text-secondary">{loc('الأقسام', 'Sections', 'بەشەکان')}</span>
          <div className="flex flex-wrap gap-1.5">
            {g.catalog_ids.map((id) => (
              <span key={id} className="inline-flex items-center gap-1 rounded-full lv-well px-2.5 py-1 text-[12px]">
                {catalogName(id)}
                <button type="button" aria-label={loc('إزالة', 'Remove', 'لابردن')} onClick={() => setGroup(g.id, { catalog_ids: g.catalog_ids.filter((x) => x !== id) })}>×</button>
              </span>
            ))}
          </div>
          <select
            className="lv-input"
            value=""
            onChange={(e) => e.target.value && setGroup(g.id, { catalog_ids: [...g.catalog_ids, e.target.value] })}
            aria-label={loc('إضافة قسم', 'Add a section', 'زیادکردنی بەش')}
          >
            <option value="">{loc('+ إضافة قسم أو فئة', '+ Add a section or category', '+ زیادکردنی بەش یان پۆل')}</option>
            {tree.map(({ node, depth }) => {
              const taken = owner('catalog', node.id, g.id);
              return (
                <option key={node.id} value={node.id} disabled={!!taken || g.catalog_ids.includes(node.id)}>
                  {`${'— '.repeat(depth)}${catalogName(node.id)}${taken ? ` (${taken.name[lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar'] || taken.id})` : ''}`}
                </option>
              );
            })}
          </select>
        </div>
        <div className="space-y-1.5">
          <span className="block text-[12px] font-semibold text-text-secondary">{loc('المنتجات', 'Products', 'بەرهەمەکان')}</span>
          <div className="flex flex-wrap gap-1.5">
            {g.product_ids.map((id) => (
              <span key={id} className="inline-flex items-center gap-1 rounded-full lv-well px-2.5 py-1 text-[12px]">
                {productName(id)}
                <button type="button" aria-label={loc('إزالة', 'Remove', 'لابردن')} onClick={() => setGroup(g.id, { product_ids: g.product_ids.filter((x) => x !== id) })}>×</button>
              </span>
            ))}
          </div>
          <ProductPicker
            value=""
            keepOpen
            excludeComposition={false}
            ariaLabel={loc('إضافة منتج', 'Add a product', 'زیادکردنی بەرهەم')}
            placeholder={loc('ابحث عن منتج…', 'Search a product…', 'بەدوای بەرهەمێکدا بگەڕێ…')}
            onChange={(id, p) => {
              if (!id || g.product_ids.includes(id)) return;
              const taken = owner('product', id, g.id);
              if (taken) {
                setError(loc(`المنتج مستخدم في قاعدة «${taken.name.ar}».`, `This product is already used by "${taken.name.en}".`, `ئەم بەرهەمە لە یاسای «${taken.name.ckb}» بەکارهاتووە.`));
                return;
              }
              if (p) setProducts((prev) => ({ ...prev, [id]: prev[id] ?? { name_ar: p.name_ar, name_en: p.name_en, name_ckb: '', category_id: null, sub_category_id: null } }));
              setGroup(g.id, { product_ids: [...g.product_ids, id] });
            }}
          />
        </div>
        {g.catalog_ids.length > 0 && (
          <div className="space-y-2">
            {children.length > 0 && <span className="block text-[12px] font-semibold text-text-secondary">{loc('استثناءات داخل القسم', 'Exceptions inside the section', 'جیاکارییەکان لەناو بەشەکەدا')}</span>}
            {children.map((c) => renderGroup(c, true))}
            <button
              type="button"
              className="lv-button px-3 h-9 text-[13px]"
              onClick={() =>
                addGroup({
                  name: { ar: `${g.name.ar} — استثناء`, en: `${g.name.en} — exception`, ckb: `${g.name.ckb} — جیاکاری` },
                  mode: g.mode === 'stopped' ? 'per_piece' : g.mode,
                  fee_iqd: g.fee_iqd,
                  block_size: g.block_size,
                })
              }
            >
              <CornerDownLeft className="w-4 h-4" aria-hidden /> {loc('+ استثناء منتج', '+ Product exception', '+ جیاکاریی بەرهەم')}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6" data-admin="delivery-management">
      <div className="flex items-center gap-3">
        <Truck className="w-6 h-6 text-text-secondary" aria-hidden />
        <h2 className="text-xl font-bold">{loc('إدارة التوصيل', 'Delivery management', 'بەڕێوەبردنی گەیاندن')}</h2>
      </div>

      {/* 1. The default price */}
      <section className="lv-surface p-6 space-y-2" aria-labelledby="dm-default">
        <h3 id="dm-default" className="text-lg font-bold">{loc('السعر الافتراضي', 'Default price', 'نرخی بنەڕەت')}</h3>
        <p className="text-sm text-text-secondary">{loc('لكل الطلب، بلا حد لعدد القطع.', 'For the whole order, with no limit on the number of pieces.', 'بۆ هەموو داواکارییەکە، بێ سنوور بۆ ژمارەی پارچەکان.')}</p>
        <input
          className="lv-input tabular-nums max-w-[220px]"
          type="number"
          min={0}
          step={250}
          dir="ltr"
          value={policy.default_fee_iqd}
          onChange={(e) => update({ ...policy, default_fee_iqd: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
          aria-label={loc('السعر الافتراضي (د.ع)', 'Default price (IQD)', 'نرخی بنەڕەت (دینار)')}
          data-delivery-default
        />
      </section>

      {/* 2. Governorates */}
      <section className="lv-surface p-6 space-y-3" aria-labelledby="dm-gov">
        <h3 id="dm-gov" className="text-lg font-bold">{loc('المحافظات', 'Governorates', 'پارێزگاکان')}</h3>
        <p className="text-sm text-text-secondary">
          {loc(
            'سعر المحافظة يحل محل السعر الافتراضي فقط؛ قواعد الأقسام نفسها في كل المحافظات.',
            'A governorate price replaces the default price only; the section rules are the same in every governorate.',
            'نرخی پارێزگا تەنها جێگەی نرخی بنەڕەت دەگرێتەوە؛ یاساکانی بەشەکان لە هەموو پارێزگاکاندا وەک یەکن.'
          )}
        </p>
        <div className="divide-y divide-[var(--ap-border,transparent)]">
          {IRAQ_GOVERNORATES.map((gov) => {
            const rule: GovernorateRule | undefined = policy.governorates[gov.id];
            const kind = !rule ? 'default' : 'stopped' in rule ? 'stopped' : 'price';
            const setRule = (next: GovernorateRule | undefined) => {
              const governorates = { ...policy.governorates };
              if (next) governorates[gov.id] = next;
              else delete governorates[gov.id];
              update({ ...policy, governorates });
            };
            return (
              <div key={gov.id} className="flex flex-wrap items-center gap-2 py-2" data-delivery-governorate={gov.id}>
                <span className="w-32 text-sm font-semibold">{lang === 'en' ? gov.en : lang === 'ckb' ? gov.ckb : gov.ar}</span>
                <select
                  className="lv-input w-auto"
                  value={kind}
                  onChange={(e) =>
                    setRule(e.target.value === 'stopped' ? { stopped: true } : e.target.value === 'price' ? { fee_iqd: policy.default_fee_iqd } : undefined)
                  }
                >
                  <option value="default">{loc('الافتراضي', 'Default', 'بنەڕەت')}</option>
                  <option value="price">{loc('سعر مختلف', 'Different price', 'نرخی جیاواز')}</option>
                  <option value="stopped">{loc('التوصيل متوقف', 'Delivery stopped', 'گەیاندن ڕاگیراوە')}</option>
                </select>
                {rule && 'fee_iqd' in rule && (
                  <input
                    className="lv-input tabular-nums w-36"
                    type="number"
                    min={0}
                    step={250}
                    dir="ltr"
                    placeholder={loc('مثال: بغداد 3,000', 'e.g. Baghdad 3,000', 'نموونە: بەغدا 3,000')}
                    value={rule.fee_iqd}
                    onChange={(e) => setRule({ fee_iqd: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 3. Rule groups */}
      <section className="space-y-3" aria-labelledby="dm-rules">
        <div className="flex items-center justify-between">
          <h3 id="dm-rules" className="text-lg font-bold">{loc('قواعد الأقسام والمنتجات', 'Section and product rules', 'یاساکانی بەش و بەرهەم')}</h3>
          <button type="button" className="lv-button px-3 h-9 text-[13px]" onClick={() => addGroup()} data-delivery-add-group>
            <Plus className="w-4 h-4" aria-hidden /> {loc('قاعدة جديدة', 'New rule', 'یاسای نوێ')}
          </button>
        </div>
        {topGroups.length === 0 && (
          <p className="text-sm text-text-secondary">{loc('لا قواعد — كل الطلبات بالسعر الافتراضي.', 'No rules — every order pays the default price.', 'هیچ یاسایەک نییە — هەموو داواکارییەکان نرخی بنەڕەت دەدەن.')}</p>
        )}
        {topGroups.map((g) => renderGroup(g))}
      </section>

      {/* 4. How the fee is summed, and the simulator */}
      <HowItCombines policy={policy} catalogs={tree} index={index} catalogName={catalogName} productName={productName} productPath={productPath} loc={loc} lang={lang} />

      {/* Save */}
      <div className="lv-surface p-4 space-y-2 sticky bottom-2">
        {error && <p className="text-sm font-semibold text-danger" role="alert" data-delivery-error>{error}</p>}
        <button type="button" className="lv-button lv-button-primary w-full" onClick={save} disabled={state === 'saving'} data-delivery-save>
          <Save className="w-4 h-4" aria-hidden /> {state === 'saving' ? loc('جارٍ الحفظ…', 'Saving…', 'پاشەکەوت دەکرێت…') : loc('حفظ إدارة التوصيل', 'Save delivery management', 'پاشەکەوتکردنی بەڕێوەبردنی گەیاندن')}
        </button>
        {state === 'saved' && (
          <p className="text-xs font-semibold text-text-muted flex items-center gap-1">
            <Check className="w-3 h-3 text-success" aria-hidden /> {loc('تم الحفظ — يسري على الطلبات الجديدة؛ الطلبات المؤكدة تحتفظ برسومها.', 'Saved — applies to new orders; placed orders keep their fee.', 'پاشەکەوت کرا — بۆ داواکارییە نوێیەکان؛ داواکارییە تۆمارکراوەکان کرێی خۆیان دەپارێزن.')}
          </p>
        )}
        <p className="text-[11px] text-text-muted" data-delivery-updated>
          {loc('آخر تعديل', 'Last changed', 'دوایین گۆڕانکاری')}: <span dir="ltr">{policy.updated_at ? `${policy.updated_at.slice(0, 16).replace('T', ' ')} · ${policy.updated_by}` : '—'}</span>
        </p>
      </div>

      {/* 5. The delivery company's tax — the existing editor, unchanged. */}
      <CourierTaxPanel />
    </div>
  );
}

function HowItCombines(props: {
  policy: DeliveryPolicy;
  catalogs: Array<{ node: CatalogNode; depth: number }>;
  index: Map<string, string[]>;
  catalogName: (id: string) => string;
  productName: (id: string) => string;
  productPath: (id: string) => string[];
  loc: Loc;
  lang: string;
}) {
  const { policy, loc } = props;
  const [lines, setLines] = useState<Array<{ key: string; product_id: string; category_path: string[]; label: string; qty: number }>>([]);
  const [governorate, setGovernorate] = useState('');
  const result = deliveryCharge({ parts: lines, policy, governorate });
  const groupName = (id: string) => {
    if (id === 'default') return loc('السعر الافتراضي', 'Default price', 'نرخی بنەڕەت');
    const g = policy.groups.find((x) => x.id === id);
    if (!g) return id;
    return props.lang === 'en' ? g.name.en : props.lang === 'ckb' ? g.name.ckb : g.name.ar;
  };
  const add = (line: { product_id: string; category_path: string[]; label: string }) =>
    setLines((prev) => [...prev, { ...line, key: `${Date.now()}-${prev.length}`, qty: 1 }]);

  return (
    <section className="lv-surface p-6 space-y-3" aria-labelledby="dm-how">
      <h3 id="dm-how" className="text-lg font-bold">{loc('كيف يُجمع الرسم', 'How the fee is summed', 'کرێکە چۆن کۆ دەکرێتەوە')}</h3>
      <ul className="list-disc ps-5 text-sm text-text-secondary space-y-1">
        <li>{loc('رسم الطلب = مجموع رسم كل قاعدة موجودة في الطلب.', "The order's fee = the sum of every rule present in the order.", 'کرێی داواکاری = کۆی کرێی هەر یاسایەک کە لە داواکارییەکەدا هەیە.')}</li>
        <li>{loc('السعر الافتراضي لا يُضاف إذا وُجدت أي قاعدة في الطلب (حتى قاعدة رسمها 0).', 'The default price is not added when any rule is present (even a rule priced 0).', 'نرخی بنەڕەت زیاد ناکرێت ئەگەر هەر یاسایەک هەبێت (تەنانەت یاسایەک کە کرێکەی 0 بێت).')}</li>
        <li>{loc('الأدق يفوز: المنتج ← الفئة الفرعية ← القسم ← الافتراضي.', 'The most specific wins: product → sub-section → section → default.', 'وردترین دەباتەوە: بەرهەم ← بەشی لاوەکی ← بەش ← بنەڕەت.')}</li>
        <li>{loc('إعفاءات PRO وPREMIUM والمحفظة والعروض تُطبَّق فوق الرسم المحسوب كما هي.', 'PRO, PREMIUM, wallet and promotion waivers still apply on top of the computed fee.', 'لێخۆشبوونەکانی PRO و PREMIUM و جزدان و ئۆفەرەکان وەک خۆیان لەسەر کرێی هەژمارکراو جێبەجێ دەکرێن.')}</li>
      </ul>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <select className="lv-input" value="" onChange={(e) => e.target.value && add({ product_id: `sim:${e.target.value}`, category_path: props.index.get(e.target.value) ?? [e.target.value], label: props.catalogName(e.target.value) })} aria-label={loc('أضف قسماً للتجربة', 'Add a section to try', 'بەشێک زیاد بکە بۆ تاقیکردنەوە')}>
          <option value="">{loc('+ قطعة من قسم', '+ A piece from a section', '+ پارچەیەک لە بەشێک')}</option>
          {props.catalogs.map(({ node, depth }) => (
            <option key={node.id} value={node.id}>{`${'— '.repeat(depth)}${props.catalogName(node.id)}`}</option>
          ))}
        </select>
        <ProductPicker
          value=""
          keepOpen
          excludeComposition={false}
          ariaLabel={loc('أضف منتجاً للتجربة', 'Add a product to try', 'بەرهەمێک زیاد بکە بۆ تاقیکردنەوە')}
          onChange={(id, p) => {
            if (!id) return;
            void api
              .get<{ category_path: string[] }>(`/api/admin/delivery-policy/resolve?product_id=${encodeURIComponent(id)}`)
              .then((r) => r.category_path)
              .catch(() => props.productPath(id))
              .then((path) => add({ product_id: id, category_path: path ?? [], label: p ? (props.lang === 'en' ? p.name_en : p.name_ar) || id : props.productName(id) }));
          }}
        />
        <select className="lv-input" value={governorate} onChange={(e) => setGovernorate(e.target.value)} aria-label={loc('المحافظة', 'Governorate', 'پارێزگا')}>
          <option value="">{loc('أي محافظة (الافتراضي)', 'Any governorate (default)', 'هەر پارێزگایەک (بنەڕەت)')}</option>
          {IRAQ_GOVERNORATES.map((g) => (
            <option key={g.id} value={g.id}>{props.lang === 'en' ? g.en : props.lang === 'ckb' ? g.ckb : g.ar}</option>
          ))}
        </select>
      </div>
      {lines.length > 0 && (
        <div className="space-y-1.5" data-delivery-simulator>
          {lines.map((l) => (
            <div key={l.key} className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate">{l.label}</span>
              <input
                className="lv-input w-20 tabular-nums"
                type="number"
                min={0}
                dir="ltr"
                value={l.qty}
                onChange={(e) => setLines((prev) => prev.map((x) => (x.key === l.key ? { ...x, qty: Math.max(0, Math.trunc(Number(e.target.value) || 0)) } : x)))}
                aria-label={loc('الكمية', 'Quantity', 'بڕ')}
              />
              <button type="button" className="lv-button lv-button-danger px-2" onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))} aria-label={loc('إزالة', 'Remove', 'لابردن')}>
                <Trash2 className="w-4 h-4" aria-hidden />
              </button>
            </div>
          ))}
          <div className="border-t pt-2 space-y-1 text-sm">
            {result.governorate_rule === 'stopped' ? (
              <p className="font-semibold">{loc('التوصيل متوقف إلى هذه المحافظة.', 'Delivery to this governorate is stopped.', 'گەیاندن بۆ ئەم پارێزگایە ڕاگیراوە.')}</p>
            ) : (
              result.components.map((c) => (
                <div key={c.rule_id} className="flex justify-between tabular-nums">
                  <span>{groupName(c.rule_id)} · {c.units}</span>
                  <span>{formatIqd(c.fee_iqd)}</span>
                </div>
              ))
            )}
            {result.stopped_product_ids.length > 0 && (
              <p className="text-danger">{loc('بعض القطع لا تُوصَّل (قاعدة «لا يُوصَّل»).', 'Some pieces are not delivered (a "not delivered" rule).', 'هەندێک پارچە ناگەیەنرێن (یاسای «ناگەیەنرێت»).')}</p>
            )}
            <div className="flex justify-between font-bold tabular-nums">
              <span>{loc('المجموع', 'Total', 'کۆ')}</span>
              <span data-delivery-sim-total>{formatIqd(result.total_iqd)}</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
