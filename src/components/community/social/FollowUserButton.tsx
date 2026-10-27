/**
 * «متابعة» A CREATOR. The look is the shared follow button of the community
 * kit (kit/FollowButton.tsx, community UI plan B2), the one a store card
 * wears too; this file is the behaviour.
 *
 * Its state comes from three places in order: the viewer's own graph once it
 * has loaded (SocialContext), else what the server put on the card, else off.
 * A follow is written optimistically and the graph is told, so every other
 * card of the same person flips with it; a refusal flips it back. While the
 * write is in flight the button is held (`busy`) and a second press is
 * dropped. Hidden for the account of the viewer (following yourself is not a
 * thing) and never rendered disabled. A follow that landed forgets the
 * remembered «أتابعهم» and the makers' directory (hub/feedCache.ts), so the
 * section does not keep showing «لا تتابع أحدًا بعد» for two minutes.
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../../AuthContext';
import { useSignInPrompt } from '../../../lib/guest';
import { apiRefusal } from '../../../lib/refusalStrings';
import { useLanguage } from '../../../LanguageContext';
import { toast } from '../../ui/Toast';
import { forgetAfterFollow } from '../hub/feedCache';
import FollowButton from '../kit/FollowButton';
import { socialApi } from './api';
import { useSocial } from './SocialContext';
import { socialLang, useSocialStrings } from './strings';

export interface FollowUserButtonProps {
  userId: string;
  /** The server's flag on the card; the session graph wins once loaded. */
  following?: boolean;
  /** The current follower count, when the caller shows it and wants it moved. */
  followers?: number;
  size?: 'sm' | 'md';
  /** The rest look (kit/FollowButton.tsx): raised clay, or the sand-gold gradient a directory card may use. */
  tone?: 'clay' | 'gold';
  /** The person, so the button name is unique on a page of makers. */
  name?: string;
  onChange?: (following: boolean, followers: number) => void;
  className?: string;
}

export default function FollowUserButton({ userId, following: followingProp = false, followers, size = 'md', tone, name, onChange, className = '' }: FollowUserButtonProps) {
  const s = useSocialStrings();
  const { lang } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const social = useSocial();
  const [local, setLocal] = useState<boolean | null>(null);
  const busy = useRef(false);
  const [held, setHeld] = useState(false);

  // A new person or a fresh card flag starts over; the graph arriving does
  // not — the press that set `local` is newer than the snapshot it carries.
  useEffect(() => setLocal(null), [userId, followingProp]);

  if (user && user.id === userId) return null;
  if (social.blocked.has(userId)) return null;

  const following = local ?? (social.loaded ? social.followingUsers.has(userId) : followingProp);

  const press = () => {
    if (!isAuthenticated) return signIn();
    if (busy.current) return;
    busy.current = true;
    setHeld(true);
    const next = !following;
    setLocal(next);
    social.setFollowing(userId, next);
    (next ? socialApi.follow(userId) : socialApi.unfollow(userId))
      .then((r) => {
        setLocal(!!r.following);
        social.setFollowing(userId, !!r.following);
        forgetAfterFollow();
        onChange?.(!!r.following, Number(r.followers ?? Math.max(0, (followers ?? 0) + (r.following ? 1 : -1))));
      })
      .catch((e: unknown) => {
        setLocal(!next);
        social.setFollowing(userId, !next);
        toast.error(apiRefusal(e, socialLang(lang), s.actionFailed));
      })
      .finally(() => {
        busy.current = false;
        setHeld(false);
      });
  };

  return (
    <FollowButton
      following={following}
      onToggle={press}
      busy={held}
      size={size}
      tone={tone}
      name={name}
      className={className}
      data-social="follow"
    />
  );
}
