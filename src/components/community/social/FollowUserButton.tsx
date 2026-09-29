/**
 * «متابعة» A CREATOR — the sage pill the store directory already speaks
 * (hub/StoreCard.tsx), for a person instead of a shop.
 *
 * Its state comes from three places in order: the viewer's own graph once it
 * has loaded (SocialContext), else what the server put on the card, else off.
 * A follow is written optimistically and the graph is told, so every other
 * card of the same person flips with it; a refusal flips it back. The label
 * cross-fades between the two words and the pill's width follows on the
 * `quick` spring. Hidden for the viewer's own account — following yourself is
 * not a thing — and never rendered disabled. A follow that landed forgets the
 * remembered «أتابعهم» and the makers' directory (hub/feedCache.ts), so the
 * tab does not keep showing «لا تتابع أحدًا بعد» for two minutes.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check } from 'lucide-react';
import { useAuth } from '../../../AuthContext';
import { useSignInPrompt } from '../../../lib/guest';
import { useMotion } from '../../../lib/motion';
import { apiRefusal } from '../../../lib/refusalStrings';
import { useLanguage } from '../../../LanguageContext';
import { toast } from '../../ui/Toast';
import { forgetAfterFollow } from '../hub/feedCache';
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
  onChange?: (following: boolean, followers: number) => void;
  className?: string;
}

export default function FollowUserButton({ userId, following: followingProp = false, followers, size = 'md', onChange, className = '' }: FollowUserButtonProps) {
  const s = useSocialStrings();
  const { lang } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const social = useSocial();
  const m = useMotion();
  const [local, setLocal] = useState<boolean | null>(null);
  const busy = useRef(false);

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
      });
  };

  const label = following ? s.following : s.follow;
  return (
    <motion.button
      type="button"
      layout={!m.reduced}
      transition={m.spring('quick')}
      onClick={press}
      aria-pressed={following}
      data-social="follow"
      data-on={following ? 'true' : 'false'}
      className={`relative z-10 inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        size === 'sm' ? 'px-3 text-[12.5px]' : 'px-4 text-[13px]'
      } ${following ? 'border-border-subtle bg-surface text-text-secondary hover:text-text-primary' : 'border-sage/40 bg-sage/10 text-sage hover:bg-sage/20'} ${className}`}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={following ? 'on' : 'off'}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={m.spring('quick')}
          className="inline-flex items-center gap-1 whitespace-nowrap"
        >
          {following && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
          {label}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
