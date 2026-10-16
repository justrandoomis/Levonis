/**
 * IS LEVO COMMUNITY OPEN TO ME? — the client half of the maintenance gate.
 *
 * The SERVER decides (worker/lib/communityGate.ts): while
 * `admin_settings.communityGate` does not say `{"open": true}`, every gated
 * /api/community route answers 503 COMMUNITY_CLOSED to a visitor and lets a
 * platform admin — and anyone whose id the owner put in `allowed_user_ids` —
 * through. GET /api/community/access is the one route that always answers, so
 * the app can ask the question instead of guessing, which is what lets the
 * owner open the community, or add one member, with a settings write and no
 * deploy.
 *
 * NOTHING HERE IS A SECURITY BOUNDARY. A hidden tab and a maintenance card
 * are presentation: they keep a customer out of a page whose every call would
 * be refused, and they say why in the customer's own language. The refusal
 * that actually protects the community's rows is the server's.
 *
 * ONE REQUEST PER VIEWER, NOT PER COMPONENT. The bottom bar, the services
 * grid, the dashboard header and the route guard all ask the same question on
 * the same page load, so the answer is cached in this module against the
 * signed-in user's id. Keying it on the id is what makes signing in correct
 * rather than merely fast: a guest's «تحت الصيانة» must not survive into the
 * session of the allow-listed member who just signed in, and it does not,
 * because that is a different key.
 *
 * NO NEW SORANI IS WRITTEN IN THIS FILE. The card's ckb words are the ones
 * already hand-written in this repo — «کۆمەڵگە» (src/translations.ts) and
 * «چاککردنەوە» (the same file's `maintenanceMain`) — set beside each other,
 * with «بەم زووانە» underneath from `comingSoon`. Sorani is never generated
 * here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { COMMUNITY_ACCESS_PATH, primedSessionEpoch, takePrimedJson } from '../../lib/bootFetch';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { ErrorState } from '../../components/ui/AsyncStates';

export interface CommunityAccess {
  /** The server's switch: true while the community is under maintenance. */
  closed: boolean;
  /** True when the viewer is a platform admin — the door that stays open. */
  admin: boolean;
  /** True when THIS viewer may enter: anyone while it is open, an admin always, an allow-listed member. */
  may_enter: boolean;
}

/**
 * The three booleans, or null. A body missing any of them is NOT read as an
 * open community: an answer nobody can understand is not permission.
 */
export function communityAccessOf(body: unknown): CommunityAccess | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.closed !== 'boolean' || typeof b.may_enter !== 'boolean') return null;
  return { closed: b.closed, admin: b.admin === true, may_enter: b.may_enter };
}

/**
 * GET /api/community/access — public, answers while it is shut; a guest's
 * answer is edge-cached, a member's never. On a gated page the request left
 * with the entry (src/lib/bootFetch.ts `COMMUNITY_ACCESS_PATH`) and is taken
 * here once.
 */
export async function fetchCommunityAccess(): Promise<CommunityAccess> {
  const primed = takePrimedJson<unknown>(COMMUNITY_ACCESS_PATH);
  const access = communityAccessOf(await (primed ?? api.get<unknown>(COMMUNITY_ACCESS_PATH)));
  if (!access) throw new Error('community access: unreadable body');
  return access;
}

/**
 * THE KEY OF AN ANSWER ASKED BEFORE /api/auth/me HAS SAID WHOSE SESSION THIS
 * IS (speed audit 2026-10-16). The question used to wait for the session —
 * /me, then this read, then the page, one round trip after another on a
 * phone. But the server answers it from the cookie the request carries, the
 * same cookie /me reads, so an answer asked under this key IS the answer for
 * whoever /me then names: it is adopted under that viewer's key instead of
 * asked again — unless a sign-in or sign-out happened in between
 * (`primedSessionEpoch`, bumped by every one of them), when it is dropped and
 * the viewer's own question is asked as before. The maintenance card of a
 * guest therefore cannot survive into the session of a member who signs in.
 */
export const COMMUNITY_SESSION_KEY = '\u0000session';
const SESSION_KEY = COMMUNITY_SESSION_KEY;

/** The in-flight or settled answer for one viewer. Cleared when the viewer changes. */
let cache: { key: string; epoch: number; promise: Promise<CommunityAccess> } | null = null;

/**
 * How long a FAILED answer is still shared by the components of one page
 * load. A failure used to be forgotten the instant it arrived, so the next
 * component to mount — the services grid ~700 ms after the bottom bar, on a
 * throttled phone — asked the server again and failed again: measured ×2 per
 * home load while the API was down (P2a). Inside this window the burst shares
 * one refusal; after it, or on `reload`, the next asker retries as before.
 */
const FAILURE_SHARED_MS = 4000;

/** Drop the cached answer — used after an admin flips the switch. */
export function resetCommunityAccessCache() {
  cache = null;
}

/** The shared answer for `key` (a viewer's id, 'guest', or COMMUNITY_SESSION_KEY). Exported for the tests. */
export function communityAccessFor(key: string): Promise<CommunityAccess> {
  return accessFor(key);
}

function accessFor(key: string): Promise<CommunityAccess> {
  if (cache && cache.key === key) return cache.promise;
  if (cache && cache.key === SESSION_KEY && key !== SESSION_KEY && cache.epoch === primedSessionEpoch()) {
    // The cookie's own answer, asked before /me named the viewer: theirs.
    cache = { ...cache, key };
    return cache.promise;
  }
  const promise = fetchCommunityAccess().catch((e: unknown) => {
    // A failed answer must not be remembered for long: a component that asks
    // later must retry rather than inherit a stale failure. It IS remembered
    // for the rest of this page load's burst (see FAILURE_SHARED_MS) — under
    // whichever viewer's key it was adopted by meanwhile.
    setTimeout(() => {
      if (cache && cache.promise === promise) cache = null;
    }, FAILURE_SHARED_MS);
    throw e;
  });
  cache = { key, epoch: primedSessionEpoch(), promise };
  return promise;
}

/**
 * Reads the switch once per viewer. `error` is kept rather than swallowed: a
 * component that could not ask must not claim the community is shut, and must
 * not show it either — the caller decides which of those two it is.
 */
export function useCommunityAccess(): { access: CommunityAccess | null; error: unknown; reload: () => void } {
  const { user, isLoaded } = useAuth();
  // Asked at once — never as a GUEST before the session is known (that would
  // show the maintenance card to an allow-listed member for as long as the
  // first answer took), but as the cookie's own question (SESSION_KEY), which
  // the viewer's key then adopts.
  const key = isLoaded ? user?.id ?? 'guest' : SESSION_KEY;
  const [answer, setAnswer] = useState<{ promise: Promise<CommunityAccess> | null; access: CommunityAccess | null; error: unknown }>(
    { promise: null, access: null, error: null }
  );
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => {
    resetCommunityAccessCache();
    setAnswer({ promise: null, access: null, error: null });
    setNonce((n) => n + 1);
  }, []);
  useEffect(() => {
    let alive = true;
    const promise = accessFor(key);
    // An adopted answer is the SAME promise: what it already said stays on
    // screen (no blank frame between the cookie's key and the viewer's).
    setAnswer((current) => (current.promise === promise ? current : { promise, access: null, error: null }));
    promise
      .then((a) => {
        if (alive) setAnswer((current) => (current.promise === promise ? { promise, access: a, error: null } : current));
      })
      .catch((e: unknown) => {
        if (alive) setAnswer((current) => (current.promise === promise ? { promise, access: null, error: e } : current));
      });
    return () => {
      alive = false;
    };
  }, [key, nonce]);
  return { access: answer.access, error: answer.error, reload };
}

/**
 * «تحت الصيانة» — what a refused visitor sees instead of a blank page or a
 * wall of failed requests. The words are the owner's own in Arabic; the
 * Sorani is assembled from wording that already exists in this repo (see the
 * file header).
 *
 * TWO WAYS OUT, because two kinds of refused visitor can in fact come in:
 *   * a SIGNED-OUT tester — the server matches the allow-list on `users.id`
 *     only, so a guest is refused even when their account is on it. The card
 *     offers «تسجيل الدخول» and brings them back to this same page;
 *   * a member the admin added while this app was open — the verdict is
 *     cached per viewer, so without a way to ask again they would keep this
 *     card until a full reload. «إعادة المحاولة» asks the server again.
 * Both labels are existing translation keys (`signIn`, `retry`).
 */
export function CommunityClosedCard({ onRecheck }: { onRecheck?: () => void } = {}) {
  const { loc, t } = useLanguage();
  const { user, isLoaded } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const next = `${location.pathname}${location.search}`;
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4" data-community-closed>
      <div className="lv-surface max-w-sm w-full p-6 text-center space-y-3">
        <Wrench className="w-8 h-8 text-gold mx-auto" aria-hidden="true" />
        <h1 className="text-[15px] font-bold text-text-primary">
          {loc('ليفو كوميونيتي تحت الصيانة', 'Levo Community is under maintenance', `${t('community')} — ${t('maintenanceMain')}`)}
        </h1>
        <p className="text-[13px] text-text-secondary">{t('comingSoon')}</p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {isLoaded && !user && (
            <button
              type="button"
              onClick={() => navigate(`/auth?next=${encodeURIComponent(next)}`)}
              className="lv-button lv-button-primary px-5"
              data-community-closed-signin
            >
              {t('signIn')}
            </button>
          )}
          {onRecheck && (
            <button
              type="button"
              onClick={onRecheck}
              className="lv-button lv-button-secondary px-5"
              data-community-closed-recheck
            >
              {t('retry')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A community read that failed: the maintenance card when the community has
 * just been closed to this viewer (503 COMMUNITY_CLOSED — it used to read as
 * «server error», or as an empty list), otherwise the usual failure with a
 * retry. Never an empty state: nothing was learned about what is there.
 */
export function CommunityLoadError({ error, onRetry, compact = false }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  if (error instanceof ApiError && error.code === 'COMMUNITY_CLOSED') return <CommunityClosedCard onRecheck={onRetry} />;
  return <ErrorState error={error} onRetry={onRetry} compact={compact} />;
}

/**
 * Wraps a community route. While the community is shut a refused visitor gets
 * the maintenance card — not a redirect, because there is nowhere better to
 * send them and a bounce out of a typed URL or a shared link explains nothing.
 *
 * A status that could not be read is NOT a refusal and is not permission
 * either. We do not know the community is open, so we do not show it; the
 * question is asked again here, where the visitor is, instead of inventing an
 * answer.
 */
export function CommunityGate({
  children,
  fallback,
  closedExtra,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  /**
   * What a refused visitor still needs BELOW the card — trade already running
   * behind the wall (the /requests route passes the customer's escrowed
   * orders, whose routes stay open so they can finish).
   */
  closedExtra?: React.ReactNode;
}) {
  const { isLoaded } = useAuth();
  const { access, error, reload } = useCommunityAccess();
  // The verdict can arrive before the session does (both leave with the
  // entry): the page still waits for the session, so what is drawn — the
  // card's sign-in button, the page's own reads — knows who is looking from
  // its first frame, and nothing moves when /me lands.
  if (!isLoaded) return <>{fallback ?? null}</>;
  if (error !== null) return <ErrorState error={error} onRetry={reload} />;
  if (!access) return <>{fallback ?? null}</>;
  if (!access.may_enter) {
    return (
      <>
        <CommunityClosedCard onRecheck={reload} />
        {closedExtra ?? null}
      </>
    );
  }
  return <>{children}</>;
}

/**
 * WHERE A «زيارة المتجر» LINK MAY GO. While this viewer may enter, the in-site
 * page `/community/store/:id` as before. While the community is shut to them,
 * that page is only the maintenance card — so the link goes to the store's OWN
 * address instead (its subdomain storefront is deliberately outside the wall),
 * resolved from `/api/storefront/by-id/:id`, which accepts a merchant id or a
 * store id. A merchant with no storefront of its own has nowhere to send the
 * visitor: the answer is null and the caller hides the link. An unknown
 * verdict (still loading, or failed) keeps the old link — only an explicit
 * `may_enter === false` changes it, as everywhere else.
 */
export function useCommunityStoreHref(merchantOrStoreId: string | null | undefined): string | null {
  const { access } = useCommunityAccess();
  const shut = access?.may_enter === false;
  const [storeUrl, setStoreUrl] = useState<string | null>(null);
  useEffect(() => {
    setStoreUrl(null);
    if (!shut || !merchantOrStoreId) return;
    let alive = true;
    api
      .get<{ store?: { url?: unknown } }>(`/api/storefront/by-id/${encodeURIComponent(merchantOrStoreId)}`)
      .then((d) => {
        const url = typeof d?.store?.url === 'string' ? d.store.url : '';
        if (alive && /^https?:\/\//.test(url)) setStoreUrl(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [shut, merchantOrStoreId]);
  if (!merchantOrStoreId) return null;
  if (!shut) return `/community/store/${merchantOrStoreId}`;
  return storeUrl;
}

/** Follow an href from `useCommunityStoreHref`: a full navigation for another host, the router for ours. */
export function followStoreHref(href: string, navigate: (to: string) => void) {
  if (/^https?:\/\//.test(href)) window.location.assign(href);
  else navigate(href);
}

/**
 * A «زيارة المتجر» link that stays true while the community is shut: the
 * in-site page, the store's own site, or — when there is neither — nothing.
 */
export function CommunityStoreLink({
  id,
  className,
  children,
}: {
  id: string | null | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  const href = useCommunityStoreHref(id);
  if (!href) return null;
  if (/^https?:\/\//.test(href)) {
    return (
      <a href={href} className={className} data-community-store-link="external">
        {children}
      </a>
    );
  }
  return (
    <Link to={href} className={className} data-community-store-link="in-site">
      {children}
    </Link>
  );
}
