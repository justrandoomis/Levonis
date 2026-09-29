/**
 * «متابعة» A STORE FROM A RAIL — the directory's optimistic toggle
 * (src/pages/Community.tsx StoresPanel, docs/DECISIONS.md row 89) for cards
 * that do not live in a `useCommunityFeed` list: the answer shows at once and
 * is put back if the server says no; a guest is sent to sign in and brought
 * back; the session graph (SocialContext) and the directory's remembered
 * pages are told, so every other card of the same shop agrees.
 */
import { useState } from 'react';
import { useAuth } from '../../../AuthContext';
import { useSignInPrompt } from '../../../lib/guest';
import { ApiError } from '../../../lib/api';
import { toast } from '../../ui/Toast';
import { useSocial } from '../social/SocialContext';
import { communityHubApi, type CommunityStore } from './api';
import { forgetCommunityFeed } from './feedCache';
import { useHubStrings } from './strings';

export function useStoreFollow() {
  const { user, isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const social = useSocial();
  const s = useHubStrings();
  const [busy, setBusy] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, { following: boolean; followers: number }>>({});

  /** The card as the viewer should see it now: a press just made, else the session graph, else the server's flag. */
  const view = (m: CommunityStore): CommunityStore => {
    const l = local[m.id];
    const following = l ? l.following : social.loaded ? social.followingStores.has(m.id) : !!m.following;
    return { ...m, following, followers: l ? l.followers : m.followers };
  };

  const toggle = async (raw: CommunityStore) => {
    if (!isAuthenticated) {
      signIn();
      return;
    }
    if (busy) return;
    const m = view(raw);
    const was = !!m.following;
    const set = (following: boolean, followers: number) => setLocal((prev) => ({ ...prev, [m.id]: { following, followers } }));
    setBusy(m.id);
    set(!was, Math.max(0, (m.followers ?? 0) + (was ? -1 : 1)));
    social.setFollowingStore(m.id, !was);
    try {
      await (was ? communityHubApi.unfollow(m.id) : communityHubApi.follow(m.id));
      forgetCommunityFeed('merchants');
      // «أتابعهم» carries the owners of followed stores too (GET /feed?scope=following).
      forgetCommunityFeed('feed:following');
    } catch (e) {
      set(was, m.followers ?? 0);
      social.setFollowingStore(m.id, was);
      if (e instanceof ApiError && e.status === 401) signIn();
      else toast.error(s.followFailed);
    } finally {
      setBusy(null);
    }
  };

  const canFollow = (m: CommunityStore) => m.user_id !== user?.id;

  return { view, toggle, busy, canFollow };
}
