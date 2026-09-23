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
import { api } from '../../lib/api';
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

/** GET /api/community/access — public, never cached, answers while it is shut. */
export async function fetchCommunityAccess(): Promise<CommunityAccess> {
  const access = communityAccessOf(await api.get<unknown>('/api/community/access'));
  if (!access) throw new Error('community access: unreadable body');
  return access;
}

/** The in-flight or settled answer for one viewer. Cleared when the viewer changes. */
let cache: { key: string; promise: Promise<CommunityAccess> } | null = null;

/** Drop the cached answer — used after an admin flips the switch. */
export function resetCommunityAccessCache() {
  cache = null;
}

function accessFor(key: string): Promise<CommunityAccess> {
  if (cache && cache.key === key) return cache.promise;
  const promise = fetchCommunityAccess().catch((e: unknown) => {
    // A failed answer must not be remembered: the next component to ask would
    // inherit a stale failure instead of retrying.
    if (cache && cache.key === key) cache = null;
    throw e;
  });
  cache = { key, promise };
  return promise;
}

/**
 * Reads the switch once per viewer. `error` is kept rather than swallowed: a
 * component that could not ask must not claim the community is shut, and must
 * not show it either — the caller decides which of those two it is.
 */
export function useCommunityAccess(): { access: CommunityAccess | null; error: unknown; reload: () => void } {
  const { user, isLoaded } = useAuth();
  const key = isLoaded ? user?.id ?? 'guest' : '';
  const [access, setAccess] = useState<CommunityAccess | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => {
    resetCommunityAccessCache();
    setAccess(null);
    setError(null);
    setNonce((n) => n + 1);
  }, []);
  useEffect(() => {
    // Nothing is asked until the session is known. Asking as a guest and then
    // again as the user would show the maintenance card to an allow-listed
    // member for as long as the first answer took to arrive.
    if (key === '') return;
    let alive = true;
    setAccess(null);
    setError(null);
    accessFor(key)
      .then((a) => {
        if (alive) setAccess(a);
      })
      .catch((e: unknown) => {
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [key, nonce]);
  return { access, error, reload };
}

/**
 * «تحت الصيانة» — what a refused visitor sees instead of a blank page or a
 * wall of failed requests. The words are the owner's own in Arabic; the
 * Sorani is assembled from wording that already exists in this repo (see the
 * file header).
 */
export function CommunityClosedCard() {
  const { loc, t } = useLanguage();
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4" data-community-closed>
      <div className="max-w-sm w-full rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 text-center space-y-3">
        <Wrench className="w-8 h-8 text-gold mx-auto" aria-hidden="true" />
        <h1 className="text-[15px] font-bold text-white">
          {loc('ليفو كوميونيتي تحت الصيانة', 'Levo Community is under maintenance', `${t('community')} — ${t('maintenanceMain')}`)}
        </h1>
        <p className="text-[13px] text-zinc-400">{t('comingSoon')}</p>
      </div>
    </div>
  );
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
export function CommunityGate({ children, fallback }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  const { access, error, reload } = useCommunityAccess();
  if (error !== null) return <ErrorState error={error} onRetry={reload} />;
  if (!access) return <>{fallback ?? null}</>;
  if (!access.may_enter) return <CommunityClosedCard />;
  return <>{children}</>;
}
