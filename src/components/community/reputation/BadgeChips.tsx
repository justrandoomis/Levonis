/**
 * UP TO THREE EARNED BADGES, EACH ONE ANSWERING «لماذا؟» — the store hero,
 * the directory card and the creator page (docs/COMMUNITY_ECOSYSTEM.md §9.6,
 * Reputation V2).
 *
 * WHAT IT DRAWS. The badges a store card carries (`badges: [{key, since}]`,
 * worker/lib/reputation.ts `publicBadges`) — known keys only, in the
 * catalogue's order, at most three (`visibleBadges`): a key this build cannot
 * explain is skipped, never drawn as its key. A card without one draws
 * NOTHING, not an empty row.
 *
 * ONE MARK FOR «VERIFIED». Every surface that mounts the chips already draws
 * the store's verification (the hero's check and «متجر موثّق», the directory
 * card's check, the creator page's «تاجر موثّق»), so `verified_merchant` is
 * not drawn a second time here (`chipBadges`): the chips carry what only
 * Reputation V2 can say. The page and the merchant's own card explain all five.
 *
 * EVERY CHIP IS A QUESTION. A tap opens «لماذا؟»: the badge's rule as a
 * sentence built from the numbers the server publishes (`GET
 * /api/community/badges`, asked once per page the first time a chip opens;
 * until it answers, the numbers published when this build was written), the
 * day the store has held it since, and the page that explains all five
 * (/community/badges#<key>). The evidence — how many conversations, which
 * orders — is the merchant's alone and never reaches this component.
 *
 * TWO TONES, ONE COMPONENT.
 *   `app`    the community's own surfaces: theme tokens, and the popover is
 *            the shared `Anchored` (it grows out of the chip, sits on the
 *            overlay stack, Escape closes it and gives focus back).
 *   `store`  the storefront's dark island (src/components/storefront): the
 *            quiet white/zinc ink the hero's other chips wear, and the
 *            popover is drawn INSIDE the island on `sf-menu` — a portal to
 *            <body> would leave the store's theme behind. On a store's own
 *            host the page link goes to the platform's origin.
 * The storefront loads this module lazily (blocks/Hero.tsx), and only for a
 * store that has a badge to show.
 */
import { useCallback, useEffect, useId, useRef, useState, type ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, CheckCheck, ShieldCheck, Wrench, Zap } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useStore } from '../../../StoreContext';
import { Anchored } from '../../ui/Overlay';
import { badgeCatalogue, visibleBadges, type BadgeKey, type BadgeRuleParams, type PublicBadge } from './api';
import { repDate, repLang, reputationStrings, ruleSentence, type RepLang } from './strings';

export type BadgeTone = 'app' | 'store';

export const BADGE_ICONS: Record<BadgeKey, ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  verified_merchant: BadgeCheck,
  fast_response: Zap,
  reliable_seller: ShieldCheck,
  custom_specialist: Wrench,
  high_completion: CheckCheck,
};

/** Where a badge is explained — on the platform's origin when this page is a store's own host. */
export function badgeHref(key: BadgeKey, origin = ''): string {
  return `${origin}/community/badges#${key}`;
}

/** The badges the chips draw: the known ones but the verification every host already shows, at most `max`. */
export function chipBadges(badges: BadgeChipsProps['badges'], max = 3): PublicBadge[] {
  return visibleBadges(Array.isArray(badges) ? badges.filter((b) => b?.key !== 'verified_merchant') : badges, max);
}

// ------------------------------------------------------------ the catalogue, once per page

let catalogue: Map<BadgeKey, BadgeRuleParams> | null = null;
let asking: Promise<Map<BadgeKey, BadgeRuleParams> | null> | null = null;

/** The published rules, asked once per page; null when they cannot be had (a store host, the community closed). */
export function loadRules(): Promise<Map<BadgeKey, BadgeRuleParams> | null> {
  if (catalogue) return Promise.resolve(catalogue);
  asking ??= badgeCatalogue({ mascot: 'silent' })
    .then((rows) => {
      catalogue = new Map(rows.map((r) => [r.key, r.rule_params]));
      return catalogue;
    })
    .catch(() => {
      asking = null;
      return null;
    });
  return asking;
}

/** For tests: forget the page's catalogue. */
export function resetBadgeRules(): void {
  catalogue = null;
  asking = null;
}

function useRules(wanted: boolean): Map<BadgeKey, BadgeRuleParams> | null {
  const [rules, setRules] = useState(catalogue);
  useEffect(() => {
    if (!wanted || rules) return;
    let alive = true;
    void loadRules().then((r) => {
      if (alive && r) setRules(r);
    });
    return () => {
      alive = false;
    };
  }, [wanted, rules]);
  return rules;
}

// ------------------------------------------------------------ the answer

export interface WhyPanelProps {
  badge: PublicBadge;
  tone: BadgeTone;
  lang: RepLang;
  params?: BadgeRuleParams | null;
  /** The platform's origin on a store host; '' elsewhere. */
  origin?: string;
}

/** «لماذا؟» — the badge, its rule in the reader's language, since when, and the page. */
export function WhyPanel({ badge, tone, lang, params, origin = '' }: WhyPanelProps) {
  const s = reputationStrings(lang);
  const store = tone === 'store';
  const since = repDate(badge.since, lang);
  const muted = store ? 'text-zinc-400' : 'text-text-muted';
  const linkClass = `inline-flex min-h-11 items-center text-[12.5px] font-semibold underline underline-offset-4 ${
    store ? 'text-zinc-100 decoration-zinc-500' : 'text-text-primary decoration-border-subtle'
  } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`;
  const href = badgeHref(badge.key, origin);
  return (
    <div className="w-72 p-3.5 text-start" data-badge-why={badge.key}>
      <p className={`text-[13.5px] font-bold ${store ? 'text-zinc-100' : 'text-text-primary'}`}>{s.names[badge.key]}</p>
      <p className={`mt-2 text-[11.5px] font-semibold ${muted}`}>{s.why}</p>
      <p className={`mt-0.5 text-[12.5px] leading-relaxed ${store ? 'text-zinc-200' : 'text-text-secondary'}`} data-badge-rule>
        {ruleSentence(badge.key, params, lang)}
      </p>
      {since && <p className={`mt-2 text-[11.5px] ${muted}`}>{s.since(since)}</p>}
      {/* On a store's own host the page lives on the platform's origin — a real
          navigation; everywhere else it is a route of this app. */}
      {origin ? (
        <a href={href} className={linkClass} data-badge-about>
          {s.aboutBadges}
        </a>
      ) : (
        <Link to={href} className={linkClass} data-badge-about>
          {s.aboutBadges}
        </Link>
      )}
    </div>
  );
}

// ------------------------------------------------------------ the chips

export interface BadgeChipsProps {
  badges: ReadonlyArray<{ key: unknown; since?: unknown }> | null | undefined;
  tone?: BadgeTone;
  /** At most this many (three on every surface §9.6 names). */
  max?: number;
  className?: string;
}

export default function BadgeChips({ badges, tone = 'app', max = 3, className = '' }: BadgeChipsProps) {
  const { lang } = useLanguage();
  const l = repLang(lang);
  const s = reputationStrings(l);
  const host = useStore();
  const origin = host.store && host.mainSite ? host.mainSite : '';
  const shown = chipBadges(badges, max);
  const [open, setOpen] = useState<BadgeKey | null>(null);
  const rules = useRules(open !== null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const store = tone === 'store';

  const close = useCallback(() => setOpen(null), []);

  // THE STORE'S POPOVER lives inside the island, so it closes itself: Escape
  // (focus back to its chip) and a press anywhere outside the row.
  useEffect(() => {
    if (!store || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(null);
      anchor.current?.focus({ preventScroll: true });
    };
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [store, open]);

  // THE APP'S POPOVER is portalled: once it is placed, focus goes to its link,
  // so a keyboard reaches «عن الشارات» and Escape brings it back to the chip.
  useEffect(() => {
    if (store || !open) return;
    const frame = requestAnimationFrame(() => {
      (document.getElementById(panelId)?.querySelector('a') as HTMLElement | null)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [store, open, panelId]);

  if (!shown.length) return null;
  const current = shown.find((b) => b.key === open) ?? null;
  const chip = store
    ? 'relative lv-hit inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full border border-white/10 px-2.5 text-[11.5px] font-medium text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus'
    : 'relative lv-hit inline-flex h-7 max-w-full items-center gap-1 whitespace-nowrap rounded-full border border-border-subtle bg-surface px-2.5 text-[11.5px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

  return (
    <div ref={wrap} className={`relative ${className}`} data-badge-chips={tone}>
      {/* The store's row is ONE line of the hero's chip height, sideways on a
          narrow phone (the workshop facts' row, blocks/workshopFacts.tsx), so
          the frame the hero holds for it is exact. The scroller is 44 px tall
          and gives the 16 back (`-my-2`), so each chip's 44 px target
          (`lv-hit`) is not clipped by it; the popover is the row's sibling, so
          the scroller never clips it either. */}
      <ul aria-label={s.badgesLabel} className={store ? '-mx-4 -my-2 flex h-11 items-center gap-1.5 overflow-x-auto px-4 hide-scrollbar' : 'flex flex-wrap items-center gap-1.5'}>
        {shown.map((b) => {
          const Icon = BADGE_ICONS[b.key];
          const expanded = open === b.key;
          return (
            // A chip is ONE line at its 28 px height, never a name wrapped inside
            // the pill: the store's row scrolls sideways; in an app card a name
            // wider than the card ends in an ellipsis (the popover says it whole).
            <li key={b.key} className={store ? undefined : 'min-w-0 max-w-full'}>
              <button
                type="button"
                onClick={(e) => {
                  anchor.current = e.currentTarget;
                  setOpen(expanded ? null : b.key);
                }}
                aria-expanded={expanded}
                aria-haspopup="dialog"
                aria-controls={expanded ? panelId : undefined}
                title={s.why}
                data-badge-chip={b.key}
                className={chip}
              >
                <Icon aria-hidden className={`h-3.5 w-3.5 shrink-0 ${store ? 'text-zinc-400' : 'text-gold'}`} />
                <span className="truncate">{s.names[b.key]}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {store
        ? current && (
            <div id={panelId} role="dialog" aria-label={s.names[current.key]} className="absolute start-0 top-full z-30 mt-2 rounded-xl border border-white/10 sf-menu shadow-2xl">
              <WhyPanel badge={current} tone="store" lang={l} params={rules?.get(current.key)} origin={origin} />
            </div>
          )
        : (
            <Anchored open={!!current} onClose={close} anchor={anchor} id={panelId} role="dialog" label={current ? s.names[current.key] : s.why} align="start" testId="badge-why">
              {current && <WhyPanel badge={current} tone="app" lang={l} params={rules?.get(current.key)} origin={origin} />}
            </Anchored>
          )}
    </div>
  );
}
