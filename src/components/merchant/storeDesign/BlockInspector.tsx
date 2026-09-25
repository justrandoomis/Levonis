/**
 * THE BLOCK INSPECTOR — one block's shape, settings and visibility.
 *
 * The form is GENERATED from the block's registry entry
 * (packages/storeLayout/src/blocks.ts): each declared setting, in declared
 * order, gets the control its `FieldSpec` type calls for (./fields.tsx). A
 * few settings only matter under another's value (a grid's collection only
 * when its source is «a collection»); those are hidden, not removed — the
 * value stays in the layout exactly as the schema allows.
 */
import { ArrowRight, Copy, Eye, EyeOff, MoreHorizontal, Trash2 } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Segmented } from '../../ui/Segmented';
import { Switch } from '../../ui/Switch';
import { IconButton } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { BLOCKS, type BlockDef, type BlockType, type FieldSpec } from '../../../../packages/storeLayout/src/blocks';
import type { StoreBlock, StoreLayout } from '../../../../packages/storeLayout/src/schema';
import { BLOCK_COPY, ISSUE_COPY, say, VARIANT_COPY } from './catalog';
import { issuesFor, setSetting, setVariant, setVisibility, starvedProductLists, type Validation } from './editorModel';
import { SettingControl } from './fields';

/** Settings that only mean something under another setting's value. */
const SHOWN_WHEN: Partial<Record<BlockType, Record<string, (s: Record<string, unknown>, variant: string) => boolean>>> = {
  products_grid: { collection_id: (s) => s.source === 'collection' },
  products_carousel: { collection_id: (s) => s.source === 'collection' },
  social_links: { items: (s) => s.source === 'custom' },
  info_cards: { items: (s) => s.source === 'custom' },
  hero: {
    show_cover: (_s, v) => v === 'profile',
    show_bio: (_s, v) => v === 'profile',
    align: (_s, v) => v !== 'profile',
  },
};

export function shownSettings(block: StoreBlock): Array<[string, FieldSpec]> {
  const def: BlockDef = BLOCKS[block.type];
  const when = SHOWN_WHEN[block.type] ?? {};
  const s = block.settings as unknown as Record<string, unknown>;
  return Object.entries(def.settings).filter(([k]) => !when[k] || when[k](s, block.variant));
}

export default function BlockInspector({
  layout,
  block,
  validation,
  onChange,
  onBack,
  onDuplicate,
  onToggleHidden,
  onDelete,
  canDuplicate,
}: {
  layout: StoreLayout;
  block: StoreBlock;
  validation: Validation;
  onChange: (layout: StoreLayout, key?: string | null) => void;
  onBack: () => void;
  onDuplicate: () => void;
  onToggleHidden: () => void;
  onDelete: () => void;
  canDuplicate: boolean;
}) {
  const { loc, dir } = useLanguage();
  const def: BlockDef = BLOCKS[block.type];
  const copy = BLOCK_COPY[block.type];
  const settings = block.settings as unknown as Record<string, unknown>;
  const starved = starvedProductLists(layout).has(block.id);
  const variantIssues = issuesFor(validation, block.id, 'variant');

  return (
    <section aria-labelledby="sd-inspector-title" className="space-y-5" data-sd-inspector={block.type}>
      <header className="flex items-center gap-1">
        <IconButton
          icon={<ArrowRight className={`h-5 w-5 ${dir === 'ltr' ? 'rotate-180' : ''}`} />}
          label={loc('كل الأقسام', 'All sections')}
          onClick={onBack}
        />
        <div className="min-w-0 flex-1">
          <h2 id="sd-inspector-title" className="truncate text-[15px] font-bold text-text-primary">
            {say(loc, copy.name)}
          </h2>
          <p className="truncate text-[12px] text-text-muted">{say(loc, copy.line)}</p>
        </div>
        <Menu
          label={loc('إجراءات القسم', 'Section actions')}
          items={[
            { id: 'dup', label: loc('تكرار', 'Duplicate'), icon: <Copy className="h-4 w-4" />, onSelect: onDuplicate, disabled: !canDuplicate, hint: canDuplicate ? undefined : loc('وصلت إلى الحد', 'At the limit') },
            { id: 'hide', label: block.hidden ? loc('إظهار', 'Show') : loc('إخفاء', 'Hide'), icon: block.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />, onSelect: onToggleHidden },
            { id: 'sep', separator: true },
            { id: 'del', label: loc('حذف', 'Delete'), icon: <Trash2 className="h-4 w-4" />, onSelect: onDelete, destructive: true },
          ]}
          trigger={(p) => <IconButton {...p} icon={<MoreHorizontal className="h-5 w-5" />} label={loc('إجراءات القسم', 'Section actions')} />}
        />
      </header>

      {block.hidden && (
        <p className="rounded-xl border border-border-subtle bg-surface px-3 py-2 text-[12.5px] text-text-secondary">
          {loc('هذا القسم مخفي — محفوظ في التصميم ولا يراه زبائنك.', 'This section is hidden — kept in the design, not shown to customers.')}
        </p>
      )}
      {starved && (
        <p role="note" className="rounded-xl border border-warning/40 bg-warning/[0.06] px-3 py-2 text-[12.5px] text-text-secondary">
          {loc('في الصفحة 12 قائمة منتجات مختلفة قبل هذه — لن تُقرأ منتجات هذه القائمة. احذف قائمة أو اجعلها من المصدر نفسه.', 'The page already has 12 different product lists before this one — its products will not load. Remove a list or reuse a source.')}
        </p>
      )}

      {def.variants.length > 1 && (
        <div>
          <p className="mb-1.5 text-sm font-medium text-text-primary" id="sd-variant-label">
            {loc('الشكل', 'Style')}
          </p>
          <Segmented
            size="sm"
            group={`sd-variant-${block.id}`}
            label={loc('الشكل', 'Style')}
            value={block.variant}
            onChange={(v) => onChange(setVariant(layout, block.id, v))}
            items={def.variants.map((v) => ({ id: v, label: say(loc, VARIANT_COPY[v], v) }))}
          />
          {variantIssues.length > 0 && <p className="lv-field-error mt-1">{say(loc, ISSUE_COPY[variantIssues[0].code], variantIssues[0].code)}</p>}
        </div>
      )}

      <div className="space-y-4">
        {shownSettings(block).map(([key, spec]) => (
          <SettingControl
            key={`${block.id}:${key}`}
            blockType={block.type}
            name={key}
            spec={spec}
            value={settings[key]}
            path={`${block.id}.${key}`}
            issues={issuesFor(validation, block.id, key)}
            onChange={(v, k) => onChange(setSetting(layout, block.id, key, v), k ?? null)}
          />
        ))}
      </div>

      <fieldset className="space-y-1 border-t border-border-subtle pt-4">
        <legend className="mb-1 text-sm font-medium text-text-primary">{loc('يظهر على', 'Shows on')}</legend>
        <Switch
          checked={block.visibility.mobile}
          onChange={(v) => onChange(setVisibility(layout, block.id, { mobile: v }))}
          label={loc('الهاتف', 'Phones')}
          description={loc('الشاشات الأضيق من 768 نقطة', 'Screens narrower than 768 points')}
        />
        <Switch
          checked={block.visibility.desktop}
          onChange={(v) => onChange(setVisibility(layout, block.id, { desktop: v }))}
          label={loc('الشاشات الكبيرة', 'Larger screens')}
          description={loc('الأجهزة اللوحية والحواسيب', 'Tablets and computers')}
        />
        {!block.visibility.mobile && !block.visibility.desktop && (
          <p className="text-[12px] text-warning">{loc('لن يظهر هذا القسم على أي شاشة.', 'This section will not show on any screen.')}</p>
        )}
      </fieldset>
    </section>
  );
}
