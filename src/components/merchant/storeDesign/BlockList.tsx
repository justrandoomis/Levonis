/**
 * THE BLOCK LIST — the page's sections in order: select one to edit it, drag
 * one by its handle to move it, or use the keyboard.
 *
 * DRAG. Only the grip starts a drag (`dragListener={false}` + drag controls),
 * so a finger scrolling the list never moves a row by accident, and the grip
 * is `touch-action: none` so the finger that grabbed it owns the gesture. The
 * row tracks the pointer 1:1 from where it was grabbed, the others make room
 * with a critically damped spring, and the drop settles from where it was
 * released — all of it interruptible (motion's Reorder). Under reduced motion
 * rows jump instead of travelling.
 *
 * KEYBOARD. The grip is a button: ↑/↓ move the section one place and keep
 * focus on it, and the new position is announced. «تحريك للأعلى / للأسفل» are
 * also in each row's menu, for anyone who does not drag.
 */
import { useRef, useState } from 'react';
import { MotionConfig, Reorder, useDragControls } from 'motion/react';
import { AlertCircle, ArrowDown, ArrowUp, Copy, Eye, EyeOff, GripVertical, Monitor, MoreHorizontal, Smartphone, Trash2 } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { IconButton } from '../../ui/Button';
import { Menu } from '../../ui/Menu';
import { SPRING } from '../../../lib/motion';
import { pickText, type LocalizedText } from '../../../../packages/storeLayout/src/text';
import type { StoreBlock } from '../../../../packages/storeLayout/src/schema';
import { BLOCK_COPY, say, VARIANT_COPY } from './catalog';

export interface RowFlags {
  fatal: boolean;
  starved: boolean;
  canDuplicate: boolean;
}

function titleOf(b: StoreBlock, lang: string): string {
  const s = b.settings as unknown as Record<string, unknown>;
  for (const k of ['title', 'headline', 'label']) {
    const v = s[k] as LocalizedText | undefined;
    if (v && typeof v === 'object') {
      const t = pickText(v, lang);
      if (t) return t;
    }
  }
  return '';
}

export default function BlockList({
  blocks,
  selectedId,
  flags,
  onSelect,
  onReorder,
  onMove,
  onDuplicate,
  onToggleHidden,
  onDelete,
}: {
  blocks: StoreBlock[];
  selectedId: string | null;
  flags: (b: StoreBlock) => RowFlags;
  onSelect: (id: string) => void;
  /** A drag in progress: the new order of ids. */
  onReorder: (ids: string[]) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onDuplicate: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { loc } = useLanguage();
  const [said, setSaid] = useState('');
  const ids = blocks.map((b) => b.id);

  const move = (id: string, delta: -1 | 1) => {
    const i = ids.indexOf(id);
    const to = i + delta;
    if (i < 0 || to < 0 || to >= ids.length) return;
    onMove(id, delta);
    const name = say(loc, BLOCK_COPY[blocks[i].type].name);
    setSaid(loc(`«${name}» الآن في الموضع ${to + 1} من ${ids.length}`, `«${name}» is now at position ${to + 1} of ${ids.length}`));
  };

  return (
    <MotionConfig reducedMotion="user">
      <Reorder.Group as="ol" axis="y" values={ids} onReorder={onReorder} className="space-y-1.5" aria-label={loc('أقسام الصفحة بالترتيب', 'Page sections in order')}>
        {blocks.map((b, i) => (
          <Row
            key={b.id}
            block={b}
            index={i}
            count={blocks.length}
            selected={b.id === selectedId}
            flags={flags(b)}
            onSelect={() => onSelect(b.id)}
            onMove={(d) => move(b.id, d)}
            onDuplicate={() => onDuplicate(b.id)}
            onToggleHidden={() => onToggleHidden(b.id)}
            onDelete={() => onDelete(b.id)}
          />
        ))}
      </Reorder.Group>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </MotionConfig>
  );
}

function Row({
  block,
  index,
  count,
  selected,
  flags,
  onSelect,
  onMove,
  onDuplicate,
  onToggleHidden,
  onDelete,
}: {
  block: StoreBlock;
  index: number;
  count: number;
  selected: boolean;
  flags: RowFlags;
  onSelect: () => void;
  onMove: (delta: -1 | 1) => void;
  onDuplicate: () => void;
  onToggleHidden: () => void;
  onDelete: () => void;
}) {
  const { loc, lang } = useLanguage();
  const controls = useDragControls();
  const [dragging, setDragging] = useState(false);
  const grip = useRef<HTMLButtonElement>(null);
  const copy = BLOCK_COPY[block.type];
  const name = say(loc, copy.name);
  const title = titleOf(block, lang);
  const variant = say(loc, VARIANT_COPY[block.variant], block.variant);
  const onlyPhone = block.visibility.mobile && !block.visibility.desktop;
  const onlyLarge = !block.visibility.mobile && block.visibility.desktop;
  const nowhere = !block.visibility.mobile && !block.visibility.desktop;

  return (
    <Reorder.Item
      value={block.id}
      as="li"
      dragListener={false}
      dragControls={controls}
      transition={SPRING.move}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => setDragging(false)}
      data-dragging={dragging || undefined}
      data-sd-row={block.id}
      className="sd-row lv-choice relative flex items-center gap-1 pe-1 ps-0.5"
      data-selected={selected || undefined}
      style={{ position: 'relative' }}
    >
      <button
        ref={grip}
        type="button"
        className="sd-grip flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        aria-label={loc(`نقل «${name}» — الموضع ${index + 1} من ${count}. استخدم السهمين للأعلى والأسفل`, `Move «${name}» — position ${index + 1} of ${count}. Use the up and down arrows`)}
        onPointerDown={(e) => {
          e.preventDefault();
          controls.start(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            onMove(e.key === 'ArrowUp' ? -1 : 1);
            requestAnimationFrame(() => grip.current?.focus());
          }
        }}
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected || undefined}
        className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[13.5px] font-semibold ${block.hidden ? 'text-text-muted' : 'text-text-primary'}`}>{name}</span>
          <span className="block truncate text-[11.5px] text-text-muted" dir="auto">
            {title || variant}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-text-muted">
          {flags.fatal && (
            <span className="flex items-center gap-1 text-[11px] text-danger">
              <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">{loc('يحتاج تصحيحًا', 'Needs a fix')}</span>
            </span>
          )}
          {flags.starved && !flags.fatal && <AlertCircle className="h-3.5 w-3.5 text-warning" aria-label={loc('لن تُقرأ منتجاته', 'Its products will not load')} />}
          {block.hidden ? (
            <span className="flex items-center gap-1 text-[11px]">
              <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
              {loc('مخفي', 'Hidden')}
            </span>
          ) : nowhere ? (
            <span className="text-[11px] text-warning">{loc('لا يظهر', 'Not shown')}</span>
          ) : onlyPhone ? (
            <Smartphone className="h-3.5 w-3.5" aria-label={loc('الهاتف فقط', 'Phones only')} />
          ) : onlyLarge ? (
            <Monitor className="h-3.5 w-3.5" aria-label={loc('الشاشات الكبيرة فقط', 'Larger screens only')} />
          ) : null}
        </span>
      </button>
      <Menu
        label={loc(`إجراءات «${name}»`, `«${name}» actions`)}
        items={[
          { id: 'up', label: loc('تحريك للأعلى', 'Move up'), icon: <ArrowUp className="h-4 w-4" />, onSelect: () => onMove(-1), disabled: index === 0 },
          { id: 'down', label: loc('تحريك للأسفل', 'Move down'), icon: <ArrowDown className="h-4 w-4" />, onSelect: () => onMove(1), disabled: index === count - 1 },
          {
            id: 'dup',
            label: loc('تكرار', 'Duplicate'),
            icon: <Copy className="h-4 w-4" />,
            onSelect: onDuplicate,
            disabled: !flags.canDuplicate,
            hint: flags.canDuplicate ? undefined : loc('وصلت إلى الحد', 'At the limit'),
          },
          { id: 'hide', label: block.hidden ? loc('إظهار', 'Show') : loc('إخفاء', 'Hide'), icon: block.hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />, onSelect: onToggleHidden },
          { id: 'sep', separator: true },
          { id: 'del', label: loc('حذف', 'Delete'), icon: <Trash2 className="h-4 w-4" />, onSelect: onDelete, destructive: true },
        ]}
        trigger={(p) => <IconButton {...p} icon={<MoreHorizontal className="h-5 w-5" />} label={loc(`إجراءات «${name}»`, `«${name}» actions`)} />}
      />
    </Reorder.Item>
  );
}
