/**
 * THE COMMUNITY SURFACES AND READ-OUTS (community UI plan B1; tokens.md §6
 * rows 12, 13, 20–23, 28).
 *
 *   KitCard       the card (the reference body gradient, a 1px contour,
 *                 resting clay) and the raised focal card
 *   SectionCard   a card with its head: icon, title, «(اختياري)», a slot
 *   SectionHead   a section title with the gold «عرض الكل ‹» link
 *   StatePill     a status as a dot and a word: open, waiting, in progress,
 *                 done, cancelled (information: flat, never raised)
 *   StepProgress  four 8px bars and «طلب طباعة · 2 من 4», a progressbar
 *   KitAvatar     24 to 64px, the picture or the initial
 *   MediaTile     a photo tile with its counter, remove × and drag handle;
 *                 MediaAddTile, the dashed «أضف صورة» tile
 *   ActionDock    the sticky bottom bar over the safe area
 *   ListRow       a 56px navigation row: icon tile, label, chevron, and the
 *                 current page dimpled with a gold start bar
 */
import React, { useId } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, GripVertical, Plus, X } from 'lucide-react';
import VariantImg from '../../ui/VariantImg';
import { OnwardChevron, TextLink } from './buttons';
import { useKitStrings } from './strings';

type CardTag = 'div' | 'section' | 'article' | 'li' | 'aside';

export interface KitCardProps extends React.HTMLAttributes<HTMLElement> {
  as?: CardTag;
  /** The one focal card of a screen: the raised fill, lifted. */
  raised?: boolean;
  /** Drop the default padding (a card that holds a photo tray edge to edge). */
  flush?: boolean;
}

export function KitCard({ as: Tag = 'div', raised = false, flush = false, className = '', children, ...rest }: KitCardProps) {
  return (
    <Tag {...rest} className={`${raised ? 'cm-card-raised bg-surface-raised shadow-lg' : 'cm-card shadow-sm'} rounded-xl ${flush ? '' : 'p-3 sm:p-4'} ${className}`}>
      {children}
    </Tag>
  );
}

export interface SectionCardProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode;
  icon?: React.ReactNode;
  optional?: boolean;
  /** The inline-end slot of the head: a counter, a link, a button. */
  trailing?: React.ReactNode;
  level?: 2 | 3;
}

/** «ملفات المجسم (اختياري)»: one card per question of a form. */
export function SectionCard({ title, icon, optional = false, trailing, level = 2, className = '', children, ...rest }: SectionCardProps) {
  const s = useKitStrings();
  const id = useId();
  const H = level === 3 ? 'h3' : 'h2';
  return (
    <section {...rest} aria-labelledby={id} className={`cm-card rounded-xl p-3 shadow-sm sm:p-4 ${className}`}>
      <div className="mb-2.5 flex min-h-7 items-center gap-2">
        {icon && (
          <span aria-hidden="true" className="shrink-0 text-gold">
            {icon}
          </span>
        )}
        <H id={id} className="min-w-0 flex-1 text-ui-lg font-bold text-text-primary">
          {title}
          {optional && <span className="ms-1.5 text-[15px] font-normal text-text-muted">{s.optional}</span>}
        </H>
        {trailing}
      </div>
      {children}
    </section>
  );
}

export interface SectionHeadProps {
  title: React.ReactNode;
  /** The «عرض الكل» destination; no link without one. */
  to?: string;
  /** The link words (default «عرض الكل»). */
  linkLabel?: string;
  /** The page-unique link name («عرض الكل: طلبات الطباعة»): two «عرض الكل» on a page must differ. */
  linkName?: string;
  id?: string;
  level?: 2 | 3;
  className?: string;
}

/** «الرائج هذا الشهر … عرض الكل ‹». */
export function SectionHead({ title, to, linkLabel, linkName, id, level = 2, className = '' }: SectionHeadProps) {
  const s = useKitStrings();
  const H = level === 3 ? 'h3' : 'h2';
  const words = linkLabel ?? s.seeAll;
  return (
    <div className={`mb-2.5 flex items-center justify-between gap-3 ${className}`}>
      <H id={id} className="min-w-0 text-ui-lg font-bold text-text-primary">
        {title}
      </H>
      {to && (
        <TextLink to={to} aria-label={linkName ?? (typeof title === 'string' ? `${words}: ${title}` : undefined)} className="-me-1 shrink-0 px-1">
          {words}
        </TextLink>
      )}
    </div>
  );
}

export type StateTone = 'open' | 'waiting' | 'progress' | 'done' | 'cancelled';

/** «● مفتوح»: the dot, the word and the tint, so a state is never colour alone. */
export function StatePill({ tone, children, className = '' }: { tone: StateTone; children: React.ReactNode; className?: string }) {
  return (
    <span data-state-pill={tone} className={`cm-pill cm-pill-${tone} inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold ${className}`}>
      {children}
    </span>
  );
}

export interface StepProgressProps {
  /** 1-based. */
  step: number;
  total?: number;
  /** The visible caption at the inline end («طلب طباعة · 2 من 4»). */
  caption?: React.ReactNode;
  /** The progressbar name («طلب طباعة»). */
  label: string;
  className?: string;
}

export function StepProgress({ step, total = 4, caption, label, className = '' }: StepProgressProps) {
  const s = useKitStrings();
  const at = Math.min(Math.max(step, 1), total);
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={at}
        aria-valuetext={s.step(at, total)}
        className="cm-steps grid min-w-0 flex-1 grid-flow-col auto-cols-fr gap-2"
      >
        {Array.from({ length: total }, (_, i) => (
          <span key={i} data-on={i < at || undefined} className="h-2 rounded-full" />
        ))}
      </div>
      {caption && <span className="shrink-0 text-ui-sm text-text-secondary">{caption}</span>}
    </div>
  );
}

export type AvatarSize = 24 | 28 | 40 | 48 | 64;

export interface KitAvatarProps {
  src?: string | null;
  /** The person (the initial when there is no picture). */
  name?: string | null;
  size?: AvatarSize;
  className?: string;
}

/** A person: the picture, or the first letter of the name on the selected fill. Decorative: the name is said beside it. */
export function KitAvatar({ src, name, size = 40, className = '' }: KitAvatarProps) {
  const initial = (name ?? '').trim().charAt(0).toUpperCase();
  return (
    <span aria-hidden="true" className={`cm-line inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-selected font-bold leading-none text-text-secondary ${className}`} style={{ inlineSize: size, blockSize: size, fontSize: Math.round(size * 0.4) }}>
      {src ? (
        <VariantImg sizes={`${size}px`} src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
      ) : (
        initial
      )}
    </span>
  );
}

export interface MediaTileProps {
  src?: string | null;
  alt: string;
  /** CSS aspect ratio: 4/3 a feed or project card, 1/1 a strip, 16/10 a hero. */
  ratio?: string;
  /** «1 / 3» over the photo. */
  index?: number;
  count?: number;
  /** The remove × (its name says which picture). */
  onRemove?: () => void;
  removeLabel?: string;
  /** Draw the drag handle (the caller wires the reorder). */
  draggable?: boolean;
  /** The chosen cover: a 2px gold line. */
  selected?: boolean;
  sizes?: string;
  className?: string;
}

export function MediaTile({ src, alt, ratio = '4 / 3', index, count, onRemove, removeLabel, draggable = false, selected = false, sizes = '50vw', className = '' }: MediaTileProps) {
  const s = useKitStrings();
  return (
    <div className={`cm-media relative overflow-hidden bg-surface-selected ${className}`} data-selected={selected || undefined} style={{ aspectRatio: ratio }}>
      {src && <VariantImg sizes={sizes} src={src} alt={alt} loading="lazy" decoding="async" className="h-full w-full object-cover" />}
      {index !== undefined && count !== undefined && count > 1 && (
        <span className="absolute bottom-2 start-2 inline-flex h-7 items-center rounded-full bg-onyx/70 px-2.5 text-[13px] font-semibold text-snow" dir="ltr">
          <span aria-hidden="true">
            {index} / {count}
          </span>
          <span className="sr-only">{s.photo(index, count)}</span>
        </span>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={removeLabel ?? `${s.remove}: ${alt}`} className="lv-hit absolute top-2 start-2 inline-flex size-6 items-center justify-center rounded-full bg-onyx/70 text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <X aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
      )}
      {draggable && (
        <span aria-hidden="true" title={s.reorder} className="absolute top-2 end-2 inline-flex size-6 items-center justify-center rounded-sm bg-onyx/70 text-snow">
          <GripVertical className="h-3.5 w-3.5" />
        </span>
      )}
    </div>
  );
}

/** «أضف صورة أو فيديو»: the dashed tile that opens the picker. */
export function MediaAddTile({ label, onClick, ratio = '1 / 1', className = '' }: { label: string; onClick: () => void; ratio?: string; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={`cm-media cm-drop flex flex-col items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`} style={{ aspectRatio: ratio }}>
      <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full border-2 border-current">
        <Plus className="h-5 w-5" />
      </span>
      <span className="text-ui-sm">{label}</span>
    </button>
  );
}

/** The sticky bottom bar: the one gold CTA (and at most one secondary beside it). */
export function ActionDock({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`cm-dock sticky z-30 flex gap-3 bg-canvas px-4 pt-3 shadow-dock ${className}`} data-action-dock>
      {children}
    </div>
  );
}

export interface ListRowProps {
  label: React.ReactNode;
  sublabel?: React.ReactNode;
  icon?: React.ReactNode;
  /** An in-app route. */
  to?: string;
  /** An external address: a plain anchor in a new tab, said aloud. */
  href?: string;
  current?: boolean;
  onClick?: () => void;
  className?: string;
}

/** «المشاريع ‹»: one row of the sections menu. */
export function ListRow({ label, sublabel, icon, to, href, current = false, onClick, className = '' }: ListRowProps) {
  const s = useKitStrings();
  const body = (
    <>
      {icon && (
        <span aria-hidden="true" className="cm-line flex size-9 shrink-0 items-center justify-center rounded-sm bg-surface-raised text-gold shadow-1">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium">{label}</span>
        {sublabel && <span className="cm-sub block truncate text-[12px]">{sublabel}</span>}
      </span>
      {href ? <ExternalLink aria-hidden="true" className="h-4 w-4 shrink-0 text-gold" /> : <OnwardChevron className="h-[18px] w-[18px] shrink-0 text-gold" />}
    </>
  );
  const cls = `cm-row relative flex min-h-14 items-center gap-3 rounded-sm px-3 text-text-primary hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${className}`;
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" onClick={onClick} className={cls}>
        {body}
        <span className="sr-only">{s.opensNewTab}</span>
      </a>
    );
  }
  return (
    <Link to={to ?? '#'} aria-current={current ? 'page' : undefined} onClick={onClick} className={cls}>
      {body}
    </Link>
  );
}
