/**
 * The store page's header and footer, by the layout's variant.
 *
 * `overlay` (classic): the way back on the physical top-LEFT as a bare glyph,
 * and the ⋯ menu on the top-RIGHT — fixed corners, not writing-direction ones —
 * floating over whatever the first block is (the classic cover). `bar`: the
 * same two controls in an in-flow top bar with the store's logo and name.
 * Both controls are the host's (runtime `Back` / `Menu`): they act.
 *
 * THE NOTICE LINE (storefront L6, P5) — `header.notice`, one short line with
 * an optional destination, inside an optional window (`notice_from` /
 * `notice_until`, judged against the clock the renderer is given). Under the
 * bar for `bar`; after the page's first block for `overlay` and `none` (the
 * renderer places it), so it never fights the hero's corners. A visitor may
 * hide it for this visit (sessionStorage, keyed on the notice itself — a new
 * notice shows again); that is never server state.
 *
 * THE FOOTER LINKS (L7) — `footer.links`, up to six labelled links under the
 * install card; a label without a destination is plain text.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Megaphone, Store, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import type { BlockData } from '../../../packages/storeLayout/src/data';
import type { FooterLink, FooterVariant, HeaderVariant, StoreHeader as StoreHeaderBox } from '../../../packages/storeLayout/src/schema';
import { pickText } from '../../../packages/storeLayout/src/text';
import { useStorefrontRuntime } from './runtime';
import { useStoreTheme } from './StoreTheme';
import { Column, hasLink, LinkTo, sinceLine, useText } from './parts';
import { storefrontStrings } from './strings';
import type { StorefrontStore } from './types';

export function StoreHeader({
  variant,
  store,
  notice = null,
  solid = false,
}: {
  variant: HeaderVariant;
  store: StorefrontStore;
  /** The notice line, drawn under the bar (the `bar` variant only; the renderer places it otherwise). */
  notice?: ReactNode;
  /** Over a page background: the bar takes the theme's own ground, so its name is never read off the picture. */
  solid?: boolean;
}) {
  const rt = useStorefrontRuntime();
  const { accent } = useStoreTheme();
  if (variant === 'none') return null;
  if (variant === 'bar') {
    return (
      <>
        <div className={`border-b border-white/[0.06] ${solid ? 'sf-bg' : ''}`}>
          <Column className="h-14 flex items-center gap-3">
            <div dir="ltr" className="shrink-0">
              <rt.Back />
            </div>
            <div className={`w-8 h-8 rounded-full sf-bg border ${accent.ring} overflow-hidden flex items-center justify-center shrink-0`}>
              {store.logoUrl ? (
                <img src={store.logoUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <Store className="w-4 h-4 text-gold" strokeWidth={1.5} aria-hidden="true" />
              )}
            </div>
            <span className="flex-1 min-w-0 truncate text-white text-[14px] font-bold" dir="auto">
              {store.name}
            </span>
            <rt.Menu />
          </Column>
        </div>
        {notice && <div className="my-3 empty:hidden">{notice}</div>}
      </>
    );
  }
  // overlay: two corner controls over the page top, above every block.
  return (
    <div className="absolute inset-x-0 top-0 z-20 pointer-events-none">
      <div className="absolute top-3 left-3 pointer-events-auto">
        <rt.Back />
      </div>
      <div className="absolute top-3 right-3 pointer-events-auto">
        <rt.Menu />
      </div>
    </div>
  );
}

// ------------------------------------------------------------ notice line

/** Inside its window at `nowIso`? No bound = always; an unreadable clock shows it. */
export function noticeLive(header: Pick<StoreHeaderBox, 'notice_from' | 'notice_until'>, nowIso: string): boolean {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return true;
  if (header.notice_from && Date.parse(header.notice_from) > now) return false;
  if (header.notice_until && Date.parse(header.notice_until) <= now) return false;
  return true;
}

/** A short, stable name for one notice: a changed notice is a new one, and shows again after a «hide». */
export function noticeKey(storeId: string, header: Pick<StoreHeaderBox, 'notice' | 'notice_link'>): string {
  const s = `${JSON.stringify(header.notice)}|${JSON.stringify(header.notice_link)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `lv_notice_${storeId}_${(h >>> 0).toString(36)}`;
}

export function NoticeLine({
  header,
  store,
  data,
  now,
  solid = false,
}: {
  header: StoreHeaderBox;
  store: StorefrontStore;
  data: BlockData;
  /** The instant the window is judged at (ISO). */
  now: string;
  solid?: boolean;
}) {
  const rt = useStorefrontRuntime();
  const { lang } = useLanguage();
  const { accent } = useStoreTheme();
  const key = noticeKey(store.id, header);
  // Read at the FIRST render (review 2026-09-30): read after paint, a notice the
  // visitor hid was drawn and then collapsed on every reload — a layout shift
  // the page's own speed reporter then counted against the merchant.
  const [hidden, setHidden] = useState(() => {
    if (rt.mode !== 'live') return false;
    try {
      return window.sessionStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (rt.mode !== 'live') return;
    try {
      setHidden(window.sessionStorage.getItem(key) === '1');
    } catch {
      /* a blocked storage shows the notice */
    }
  }, [key, rt.mode]);
  const text = pickText(header.notice, lang).trim();
  if (!text || hidden || !noticeLive(header, now)) return null;
  const s = storefrontStrings(lang).media;
  const linked = hasLink(header.notice_link, data);
  const hide = (e: { currentTarget: HTMLElement }) => {
    // Focus goes on to the next control after the line (review 2026-09-30), never to <body> with the removed button.
    const line = e.currentTarget.closest('[data-store-notice]');
    const next = Array.from(document.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea')).find(
      (el) => line && !line.contains(el) && line.compareDocumentPosition(el) & 4
    );
    setHidden(true);
    next?.focus();
    try {
      window.sessionStorage.setItem(key, '1');
    } catch {
      /* hidden for this view only */
    }
  };
  const body = (
    <>
      <Megaphone className={`w-3.5 h-3.5 shrink-0 ${accent.text}`} aria-hidden="true" />
      {/* Up to three lines (review 2026-09-30): cut to one, a 120-character notice
          showed its first 30 on a phone and could not be read at all. */}
      <span dir="auto" className="min-w-0 flex-1 line-clamp-3 py-1.5">
        {text}
      </span>
      {linked && <ChevronRight className="w-4 h-4 shrink-0 text-zinc-500 rtl:-scale-x-100" aria-hidden="true" />}
    </>
  );
  const line = (
    <div
      role="note"
      aria-label={s.notice}
      data-store-notice=""
      className={`${solid ? 'sf-col sf-bg border border-white/10' : 'sf-card'} sf-r-md flex items-center gap-1 min-h-11 ps-3 pe-1 text-[12.5px] text-zinc-300`}
    >
      {linked ? (
        <LinkTo
          link={header.notice_link}
          data={data}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {body}
        </LinkTo>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2">{body}</span>
      )}
      <button
        type="button"
        onClick={hide}
        aria-label={s.hideNotice}
        title={s.hideNotice}
        className="shrink-0 size-11 flex items-center justify-center rounded-full text-zinc-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
  // Over a background the line is as wide as the blocks' cards (StoreRenderer BG_GUTTER); otherwise it sits in the page's column.
  return solid ? <div className="px-2 @min-[40rem]:px-6">{line}</div> : <Column>{line}</Column>;
}

// ------------------------------------------------------------------ footer

function FooterLinks({ links, data }: { links: FooterLink[]; data: BlockData }) {
  const text = useText();
  const { lang } = useLanguage();
  const items = links.map((l) => ({ label: text(l.label), link: l.link })).filter((x) => x.label);
  if (!items.length) return null;
  const pill = 'inline-flex min-h-11 items-center';
  // A link LOOKS like one — underlined, a 44 px target however short its label
  // («FAQ» was 23 px wide) — and a label with no destination («ساعات العمل …»)
  // is plain muted text that invites no tap (review 2026-09-30).
  return (
    <nav aria-label={storefrontStrings(lang).media.footerLinks} data-store-footer-links="" className="mt-3 first:mt-0 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[12px] text-zinc-400">
      {items.map((it, i) =>
        hasLink(it.link, data) ? (
          <LinkTo
            key={i}
            link={it.link}
            data={data}
            className={`${pill} min-w-11 justify-center rounded-md underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
          >
            <span dir="auto">{it.label}</span>
          </LinkTo>
        ) : (
          <span key={i} className={`${pill} text-zinc-500`} dir="auto" data-store-footer-label="">
            {it.label}
          </span>
        )
      )}
    </nav>
  );
}

export function StoreFooter({
  variant,
  store,
  links = [],
  data,
  solid = false,
}: {
  variant: FooterVariant;
  store: StorefrontStore;
  /** `footer.links` (L7): shown with the `minimal` and `standard` variants. */
  links?: FooterLink[];
  data?: BlockData;
  /** Over a page background: the footer sits on the theme's own ground. */
  solid?: boolean;
}) {
  const rt = useStorefrontRuntime();
  const { loc, lang } = useLanguage();
  if (variant === 'none') return null;
  const inner = (
    <>
      <rt.InstallCard />
      {data && links.length > 0 && <FooterLinks links={links} data={data} />}
      {variant === 'standard' && (
        <div className="mt-6 pt-4 border-t border-white/[0.06] text-center">
          <p className="text-zinc-300 text-[12.5px] font-semibold" dir="auto">
            {store.name}
          </p>
          {store.created_at && <p className="text-zinc-600 text-[11px] mt-0.5">{sinceLine(store.created_at, loc, lang)}</p>}
        </div>
      )}
    </>
  );
  // Over a background the footer is a card of the page's column, like every block's (StoreRenderer BG_GUTTER / BG_CARD).
  if (solid) {
    return (
      <div className="mt-6 px-2 @min-[40rem]:px-6">
        <div className="sf-col sf-bg sf-r-lg border border-white/10 px-4 py-4 empty:hidden">{inner}</div>
      </div>
    );
  }
  return <Column className="mt-6">{inner}</Column>;
}
