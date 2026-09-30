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
import { BLOCKS, MEDIA_CAPS, type BlockDef, type BlockType, type FieldSpec } from '../../../../packages/storeLayout/src/blocks';
import type { BlockSchedule, StoreBlock, StoreLayout } from '../../../../packages/storeLayout/src/schema';
import { BLOCK_COPY, ISSUE_COPY, say, VARIANT_COPY } from './catalog';
import { issuesFor, setSetting, setVariant, setVisibility, starvedProductLists, type Validation } from './editorModel';
import { SettingControl, type ControlProps } from './fields';
import { Button } from '../../ui/Button';
import { useMediaStrings, type MediaStrings } from './strings';

/** Settings that only mean something under another setting's value. */
const SHOWN_WHEN: Partial<Record<BlockType, Record<string, (s: Record<string, unknown>, variant: string) => boolean>>> = {
  products_grid: { collection_id: (s) => s.source === 'collection' },
  products_carousel: { collection_id: (s) => s.source === 'collection' },
  social_links: { items: (s) => s.source === 'custom' },
  info_cards: { items: (s) => s.source === 'custom' },
  // A field is offered only where the variant draws it (review of the store
  // builder, 2026-09-28): the minimal hero has no picture, and the split hero
  // always sets its words beside the picture, start-aligned.
  hero: {
    show_cover: (_s, v) => v === 'profile',
    show_bio: (_s, v) => v === 'profile',
    align: (_s, v) => v === 'cover' || v === 'minimal',
    image: (_s, v) => v !== 'minimal',
    // The hero's video (storefront L3) plays over the picture, so the minimal
    // hero — no picture — has none; «on phones too» only means something once
    // there is a video.
    video: (_s, v) => v !== 'minimal',
    video_on_phone: (s, v) => v !== 'minimal' && typeof s.video === 'string' && s.video !== '',
  },
};

/** A block's schedule (storefront L8): both bounds blank takes the key away, as the normaliser does. */
export function setSchedule(layout: StoreLayout, id: string, patch: Partial<BlockSchedule> | null): StoreLayout {
  let hit = false;
  const blocks = layout.blocks.map((b) => {
    if (b.id !== id) return b;
    hit = true;
    const cur = b.schedule ?? { from: '', until: '' };
    const next = patch === null ? { from: '', until: '' } : { from: patch.from ?? cur.from, until: patch.until ?? cur.until };
    if (!next.from && !next.until) {
      const { schedule: _gone, ...rest } = b;
      return rest as StoreBlock;
    }
    return { ...b, schedule: next } as StoreBlock;
  });
  return hit ? { ...layout, blocks } : layout;
}

/** The end of a window that is not after its start (the normaliser would drop it). */
export function windowOutOfOrder(from: string | undefined, until: string | undefined): boolean {
  return !!from && !!until && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(until)) && Date.parse(until) <= Date.parse(from);
}

/** The words the builder's own strings give a setting (the hero's video fields), over the catalogue's. */
export function ownWords(t: MediaStrings, type: BlockType, key: string, settings: Record<string, unknown>): { label?: string; hint?: string } {
  if (type !== 'hero') return {};
  if (key === 'video') return { label: t.hero.video, hint: t.hero.videoHint };
  if (key === 'video_on_phone') return { label: t.hero.videoOnPhone, hint: t.hero.videoOnPhoneHint };
  if (key === 'image' && typeof settings.video === 'string' && settings.video) return { hint: t.hero.posterNote };
  return {};
}

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
  const t = useMediaStrings();
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
          <div key={`${block.id}:${key}`} className="space-y-1.5">
            <SettingControl
              blockType={block.type}
              name={key}
              spec={spec}
              value={settings[key]}
              path={`${block.id}.${key}`}
              issues={issuesFor(validation, block.id, key)}
              onChange={(v, k) => onChange(setSetting(layout, block.id, key, v), k ?? null)}
              {...ownWords(t, block.type, key, settings)}
              poster={posterSlot(layout, block, key, onChange)}
            />
            {/* The poster rule (storefront L3): a hero video without its still cannot be published. */}
            {block.type === 'hero' && key === 'image' && !!settings.video && !settings.image && (
              <p className="lv-field-error" data-sd-poster-required>
                {t.library.posterRequired}
              </p>
            )}
          </div>
        ))}
      </div>

      <ScheduleFields layout={layout} block={block} onChange={onChange} t={t} />

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

/**
 * A video's sibling POSTER slot, for the picker's capture (storefront W8): the
 * hero's cover is its video's poster, the video block has its own. The two
 * keys are written in ONE change.
 */
function posterSlot(layout: StoreLayout, block: StoreBlock, key: string, onChange: (l: StoreLayout, k?: string | null) => void): ControlProps['poster'] {
  if (key !== 'video' || (block.type !== 'hero' && block.type !== 'video')) return undefined;
  const slot = block.type === 'hero' ? 'image' : 'poster';
  const s = block.settings as unknown as Record<string, unknown>;
  return {
    value: typeof s[slot] === 'string' ? (s[slot] as string) : '',
    maxBytes: block.type === 'hero' ? MEDIA_CAPS.cover : MEDIA_CAPS.poster,
    setBoth: (video, poster) => onChange(setSetting(setSetting(layout, block.id, 'video', video), block.id, slot, poster)),
  };
}

/** «يظهر من … حتى …» (storefront L8): shown to visitors only inside the window; the preview shows it always, marked. */
function ScheduleFields({ layout, block, onChange, t }: { layout: StoreLayout; block: StoreBlock; onChange: (l: StoreLayout, k?: string | null) => void; t: MediaStrings }) {
  const from = block.schedule?.from ?? '';
  const until = block.schedule?.until ?? '';
  const outOfOrder = windowOutOfOrder(from, until);
  return (
    <fieldset className="space-y-2 border-t border-border-subtle pt-4" data-sd-schedule>
      <legend className="mb-1 text-sm font-medium text-text-primary">{t.schedule.title}</legend>
      {/* One under the other: the inspector is a narrow column, and a date-and-time field needs its whole line. */}
      <div className="grid gap-3">
        <SettingControl
          blockType={block.type}
          name="schedule_from"
          spec={{ t: 'date' }}
          value={from}
          path={`${block.id}.schedule.from`}
          issues={[]}
          label={t.schedule.from}
          onChange={(v) => onChange(setSchedule(layout, block.id, { from: typeof v === 'string' ? v : '' }))}
        />
        <SettingControl
          blockType={block.type}
          name="schedule_until"
          spec={{ t: 'date' }}
          value={until}
          path={`${block.id}.schedule.until`}
          issues={[]}
          label={t.schedule.until}
          onChange={(v) => onChange(setSchedule(layout, block.id, { until: typeof v === 'string' ? v : '' }))}
        />
      </div>
      {outOfOrder ? (
        <p className="lv-field-error" data-sd-schedule-order>
          {t.schedule.order}
        </p>
      ) : (
        <p className="text-[12px] leading-relaxed text-text-muted">{t.schedule.hint}</p>
      )}
      {block.schedule && (
        <Button size="sm" variant="ghost" onClick={() => onChange(setSchedule(layout, block.id, null))}>
          {t.schedule.clear}
        </Button>
      )}
    </fieldset>
  );
}
