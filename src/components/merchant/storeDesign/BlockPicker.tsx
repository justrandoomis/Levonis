/**
 * «أضف قسمًا» — every block type, grouped, each with a LIVE preview: the
 * storefront's own renderer drawing that block in the page's current look,
 * with example words (./samples.ts) that are never inserted.
 *
 * Limits are shown before they bite: a type at its per-page maximum, a page
 * at 40 sections, or a 13th product list is shown with its count and the
 * reason, and cannot be added (editorModel.canAdd).
 */
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { Segmented } from '../../ui/Segmented';
import StoreRenderer from '../../storefront/StoreRenderer';
import '../../storefront/styles';
import { StorefrontRuntimeProvider } from '../../storefront/runtime';
import { previewRuntime } from '../../storefront/preview';
import type { StorefrontStore } from '../../storefront/types';
import { BLOCKS, blockMax, type BlockDef, type BlockType } from '../../../../packages/storeLayout/src/blocks';
import type { BlockData } from '../../../../packages/storeLayout/src/data';
import type { StoreLayout } from '../../../../packages/storeLayout/src/schema';
import { ADD_REFUSAL_COPY, BLOCK_COPY, CATEGORIES, say, VARIANT_COPY, type BlockCategory } from './catalog';
import { canAdd, limitsOf, PRODUCT_LIST_TYPES } from './editorModel';
import PreviewCanvas from './PreviewCanvas';
import { ChoiceChips } from './panels';
import { samplePage } from './samples';

const runtime = previewRuntime();

export default function BlockPicker({
  open,
  onClose,
  layout,
  store,
  data,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  layout: StoreLayout;
  store: StorefrontStore;
  data: BlockData;
  onAdd: (type: BlockType, variant: string) => void;
}) {
  const { loc } = useLanguage();
  const [cat, setCat] = useState<BlockCategory>('products');
  const [type, setType] = useState<BlockType | null>(null);
  const [variant, setVariant] = useState<string>('');
  const limits = limitsOf(layout);
  const category = CATEGORIES.find((c) => c.id === cat) ?? CATEGORIES[0];

  const chosen = type ?? category.types[0];
  const def: BlockDef = BLOCKS[chosen];
  const v = def.variants.includes(variant) ? variant : def.variants[0];
  const refused = canAdd(layout, chosen);
  const page = useMemo(() => samplePage(layout, chosen, v, loc, store.bannerUrl), [layout, chosen, v, loc, store.bannerUrl]);

  const pick = (t: BlockType) => {
    setType(t);
    setVariant(BLOCKS[t].variants[0]);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={loc('أضف قسمًا', 'Add a section')}
      detents={['large']}
      panelClassName="sm:max-w-4xl"
      testId="sd-block-picker"
      header={
        <div className="min-w-0 space-y-2 px-4 pb-2 pt-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[15px] font-bold text-text-primary">{loc('أضف قسمًا', 'Add a section')}</h2>
            <span className="ms-auto text-[12px] text-text-muted tabular-nums">
              {loc(`${limits.blocks} من ${limits.maxBlocks} قسمًا`, `${limits.blocks} of ${limits.maxBlocks} sections`)}
              {' · '}
              {loc(`${limits.productLists} من ${limits.maxProductLists} قوائم منتجات`, `${limits.productLists} of ${limits.maxProductLists} product lists`)}
            </span>
          </div>
          <ChoiceChips
            label={loc('أنواع الأقسام', 'Kinds of sections')}
            value={cat}
            options={CATEGORIES.map((c) => c.id)}
            onChange={(id) => {
              setCat(id);
              const first = CATEGORIES.find((c) => c.id === id)?.types[0];
              if (first) pick(first);
            }}
            render={(id) => say(loc, CATEGORIES.find((c) => c.id === id)!.label)}
          />
        </div>
      }
      footer={
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-muted">
            {!refused ? loc('يُضاف بعد القسم المحدد، أو في آخر الصفحة.', 'Added after the selected section, or at the end.') : <span className="text-warning">{say(loc, ADD_REFUSAL_COPY[refused])}</span>}
          </p>
          <Button
            variant="primary"
            icon={<Plus className="h-4 w-4" aria-hidden="true" />}
            disabled={!!refused}
            onClick={() => {
              onAdd(chosen, v);
              onClose();
            }}
            data-sd-add={chosen}
          >
            {loc(`أضف «${say(loc, BLOCK_COPY[chosen].name)}»`, `Add «${say(loc, BLOCK_COPY[chosen].name)}»`)}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 px-4 pb-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <ul role="listbox" aria-label={say(loc, category.label)} className="order-2 min-w-0 space-y-1.5 sm:order-1">
          {category.types.map((t) => {
            const on = t === chosen;
            const count = limits.perType[t] ?? 0;
            const max = blockMax(t);
            const no = canAdd(layout, t);
            return (
              <li key={t}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  data-selected={on || undefined}
                  data-sd-type={t}
                  onClick={() => pick(t)}
                  className="lv-choice flex w-full items-center gap-3 px-3 py-2.5 text-start"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-semibold text-text-primary">{say(loc, BLOCK_COPY[t].name)}</span>
                    <span className="block text-[11.5px] leading-snug text-text-muted">{say(loc, BLOCK_COPY[t].line)}</span>
                  </span>
                  <span className={`shrink-0 text-[11px] tabular-nums ${!no ? 'text-text-muted' : 'text-warning'}`}>
                    {max <= 4 || count > 0 ? `${count}/${max}` : ''}
                    {no === 'product_lists' && PRODUCT_LIST_TYPES.includes(t) ? ` · ${loc('القوائم ممتلئة', 'lists full')}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="order-1 min-w-0 space-y-2 sm:order-2">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-text-secondary">{loc('معاينة', 'Preview')}</span>
            <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[10.5px] text-text-muted">{loc('مثال — المحتوى الحقيقي تكتبه أنت', 'Example — you write the real content')}</span>
          </div>
          <PreviewCanvas width={390} maxHeight="min(38dvh, 340px)" label={loc(`معاينة «${say(loc, BLOCK_COPY[chosen].name)}»`, `Preview of «${say(loc, BLOCK_COPY[chosen].name)}»`)}>
            <StorefrontRuntimeProvider value={runtime}>
              <StoreRenderer store={store} layout={page} data={data} className="pb-3" />
            </StorefrontRuntimeProvider>
          </PreviewCanvas>
          {def.variants.length > 1 && (
            <Segmented
              size="sm"
              group="sd-picker-variant"
              label={loc('الشكل', 'Style')}
              value={v}
              onChange={setVariant}
              items={def.variants.map((x) => ({ id: x, label: say(loc, VARIANT_COPY[x], x) }))}
            />
          )}
        </div>
      </div>
    </Sheet>
  );
}
