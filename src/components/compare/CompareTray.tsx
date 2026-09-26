import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Plus, Scale, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { isBottomNavHidden } from '../BottomNav';
import { Toaster, useToast } from '../ui/Toast';
import { useConfirm } from '../ui/ConfirmDialog';
import {
  COMPARE_TRAY_MAX,
  compareHref,
  compareTray,
  trayVisibleOn,
  type TrayItem,
} from '../../lib/compareTray';
import { traySubline, trayTitle } from './trayStrings';

/**
 * THE COMPARE TRAY (docs/ux/CATALOG_DISCOVERY.md §10.4, mockup 03a).
 *
 * A lazy chunk, loaded by CompareTrayGate the first time the tray holds
 * something — a visitor who never taps a compare toggle never downloads it.
 *
 * WHAT IT IS. A floating bar 12 px from the edges, above the bottom nav: the
 * products' thumbnails, a dashed slot while there is room, «طابعتان للمقارنة /
 * يمكنك إضافة طابعتين», the primary «قارن» (→ /compare?ids=…; disabled with a
 * single product, and the line under the title says what to do), and ✕ to
 * empty it — with «تراجع» for five seconds, because clearing four careful
 * picks by a slipped thumb must be undoable.
 *
 * After four seconds untouched it folds into a 44 px pill at the inline end
 * (scale icon + count) so it stops covering the grid; a tap unfolds it. Any
 * change to the list unfolds it again. Under reduced motion the fold is
 * instant.
 *
 * It is not drawn on /compare, the cart, checkout, the finder, the admin or
 * any page with its own purchase bar (`trayVisibleOn`); on the product page
 * the top bar's CompareBadge stands in for it. It still ANSWERS there: a
 * refused add raises its toast or its dialog on every route.
 *
 * THE TOASTER. The customer shell had none (only the merchant workspace and
 * the admin mount one), so this chunk mounts it — except on /admin, which
 * mounts its own.
 */
export default function CompareTray() {
  const { loc, lang } = useLanguage();
  const location = useLocation();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const state = useSyncExternalStore(compareTray.subscribe, compareTray.getSnapshot, compareTray.getSnapshot);
  const notice = useSyncExternalStore(compareTray.subscribeNotice, compareTray.getNotice, compareTray.getNotice);
  const count = state.items.length;
  const visible = count > 0 && trayVisibleOn(location.pathname);
  const navHidden = isBottomNavHidden(location.pathname);
  const onAdmin = location.pathname.toLowerCase().startsWith('/admin');

  // ------------------------------------------------------- fold after 4 s
  const [folded, setFolded] = useState(false);
  const timer = useRef<number | null>(null);
  const holding = useRef(false);
  const arm = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!holding.current) setFolded(true);
    }, 4000);
  }, []);
  const unfold = useCallback(() => {
    setFolded(false);
    arm();
  }, [arm]);
  const ids = state.items.map((i) => i.id).join(',');
  useEffect(() => {
    if (!visible) return;
    unfold();
  }, [ids, visible, unfold]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  // --------------------------------------------- toasts sit above the tray
  useEffect(() => {
    if (onAdmin) return;
    const root = document.documentElement;
    const before = root.style.getPropertyValue('--shell-bottom-inset');
    const tray = visible ? (folded ? 56 : 84) : 0;
    const nav = navHidden ? '0px' : 'var(--nav-stack)';
    root.style.setProperty('--shell-bottom-inset', `calc(${nav} + ${tray}px)`);
    return () => {
      if (before) root.style.setProperty('--shell-bottom-inset', before);
      else root.style.removeProperty('--shell-bottom-inset');
    };
  }, [visible, folded, navHidden, onAdmin]);

  // ---------------------------------------------------- refused additions
  useEffect(() => {
    if (!notice) return;
    compareTray.consumeNotice(notice.seq);
    if (notice.kind === 'full') {
      unfold();
      // OWNER: Sorani to be written by hand.
      toast.info(loc('الحد الأقصى أربع. أزل واحدة أولًا.', 'Four at most. Remove one first.'), { id: 'compare-full' });
      return;
    }
    const { item, type } = notice;
    void confirm({
      // OWNER: Sorani to be written by hand (the dialog's three lines).
      title: loc('بدء مقارنة جديدة؟', 'Start a new comparison?'),
      consequence: loc(
        `المقارنة تكون بين منتجات من النوع نفسه. هل تبدأ مقارنة جديدة بـ ${item.name}؟`,
        `A comparison lines up products of the same type. Start a new one with ${item.name}?`
      ),
      confirmLabel: loc('ابدأ من جديد', 'Start over'),
    }).then((yes) => {
      if (yes) compareTray.replaceAll([item], type);
    });
  }, [notice, confirm, loc, toast, unfold]);

  const clear = () => {
    const saved = compareTray.clear();
    if (!saved.items.length) return;
    // OWNER: Sorani to be written by hand («أُفرغت المقارنة»).
    toast.info(loc('أُفرغت المقارنة', 'Comparison cleared'), {
      id: 'compare-cleared',
      duration: 5000,
      action: { label: loc('تراجع', 'Undo'), onClick: () => compareTray.restore(saved) },
    });
  };

  const title = trayTitle(count, state.type, lang);
  const sub = traySubline(count, state.type, lang);
  const bottom = navHidden
    ? 'calc(max(12px, env(safe-area-inset-bottom)) + 4px)'
    : 'calc(var(--nav-stack) + 4px)';

  return (
    <>
      {!onAdmin && <Toaster />}
      {confirmDialog}
      {visible && (
        <>
          {/* In-flow room for the tray, so the grid's last row can scroll
              clear of it. */}
          <div aria-hidden="true" data-compare-tray-spacer className="shrink-0" style={{ height: folded ? 56 : 84 }} />
          <div
            className="pointer-events-none fixed inset-x-3 flex justify-end sm:inset-x-6"
            style={{ bottom, zIndex: 'calc(var(--z-bottom-nav) - 1)' }}
          >
            {folded ? (
              <button
                type="button"
                data-compare-tray="folded"
                onClick={unfold}
                aria-label={`${title}. ${loc('عرض المقارنة', 'Show comparison')}`}
                aria-expanded={false}
                className="pointer-events-auto inline-flex h-11 items-center gap-2 rounded-full border border-border-subtle bg-surface-raised ps-1.5 pe-3.5 text-[13px] font-extrabold text-text-primary shadow-[var(--shadow-2)] transition-transform active:scale-[0.97] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span className="flex -space-x-2 rtl:space-x-reverse" aria-hidden="true">
                  {state.items.slice(0, 3).map((it) => (
                    <Thumb key={it.id} item={it} size="sm" />
                  ))}
                </span>
                <Scale aria-hidden="true" className="size-4 text-text-secondary" />
                <span className="tabular-nums">{count}</span>
              </button>
            ) : (
              <section
                role="region"
                aria-label={loc('المقارنة', 'Comparison', 'بەراورد')}
                data-compare-tray="open"
                onPointerEnter={() => (holding.current = true)}
                onPointerLeave={() => {
                  holding.current = false;
                  arm();
                }}
                onFocus={() => (holding.current = true)}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    holding.current = false;
                    arm();
                  }
                }}
                className="pointer-events-auto mx-auto flex w-full max-w-[560px] items-center gap-2 rounded-[18px] sm:gap-2.5 border border-border-subtle bg-surface-raised p-2.5 shadow-[var(--shadow-3)]"
              >
                <ul className="flex shrink-0 gap-1.5" aria-label={title}>
                  {state.items.map((it) => (
                    <li key={it.id}>
                      <Thumb item={it} size="md" />
                    </li>
                  ))}
                  {count < COMPARE_TRAY_MAX && (
                    <li aria-hidden="true" className="hidden min-[420px]:block">
                      <span className="grid size-10 place-items-center rounded-[10px] border-[1.5px] border-dashed border-zinc-700 text-text-muted">
                        <Plus className="size-4" />
                      </span>
                    </li>
                  )}
                </ul>
                <div className="min-w-0 flex-1" aria-live="polite">
                  <b className="block truncate text-[13px] font-extrabold leading-[18px] text-text-primary">{title}</b>
                  <span className="block truncate text-[11px] leading-[15px] text-text-muted">{sub}</span>
                </div>
                {count >= 2 ? (
                  <Link
                    to={compareHref(state)}
                    data-compare-tray-go
                    className="lv-button lv-button-primary lv-button-sm shrink-0 rounded-xl !px-3.5 font-extrabold"
                  >
                    {loc('قارن', 'Compare', 'بەراورد')}
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="lv-button lv-button-primary lv-button-sm shrink-0 rounded-xl !px-3.5 font-extrabold opacity-40"
                  >
                    {loc('قارن', 'Compare', 'بەراورد')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={clear}
                  data-compare-tray-clear
                  // OWNER: Sorani to be written by hand.
                  aria-label={loc('إفراغ المقارنة', 'Clear comparison')}
                  title={loc('إفراغ المقارنة', 'Clear comparison')}
                  className="lv-hit relative grid size-8 shrink-0 place-items-center rounded-full text-text-secondary transition-colors hover:bg-surface-selected hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X aria-hidden="true" className="size-[18px]" />
                </button>
              </section>
            )}
          </div>
        </>
      )}
    </>
  );
}

/** A product's photograph, cropped to the machine (the band under the lettered name). */
function Thumb({ item, size }: { item: TrayItem; size: 'sm' | 'md' }) {
  const box = size === 'md' ? 'size-10 rounded-[10px]' : 'size-8 rounded-full ring-2 ring-surface-raised';
  return (
    <span className={`relative block shrink-0 overflow-hidden bg-charcoal ${box}`} title={size === 'md' ? item.name : undefined}>
      {item.image ? (
        <img
          src={item.image}
          alt={size === 'md' ? item.name : ''}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full scale-[1.3] object-cover object-[50%_56%]"
        />
      ) : (
        <span className="sr-only">{item.name}</span>
      )}
    </span>
  );
}
