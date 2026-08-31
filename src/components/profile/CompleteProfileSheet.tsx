import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X, UserRound } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { api } from '../../lib/api';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { onboardingStrings, missingLabel } from '../onboarding/strings';

/**
 * "Complete your profile" — once, then progressively less often.
 *
 * THE FAILURE MODE THIS IS DESIGNED AGAINST is the one everybody has seen: a
 * prompt that reappears on every page load until it is filled in. Three
 * things prevent it here.
 *
 *   1. WHETHER TO ASK IS DECIDED BY THE SERVER. `shouldPrompt` comes from a
 *      timestamp on the user row, so dismissing on a phone also dismisses on
 *      a laptop, and clearing site data does not restart the nagging. A
 *      localStorage flag would have been per-device and per-browser.
 *   2. THE INTERVAL WIDENS. Three days, then a week, then a month, then
 *      ninety days. Somebody who has said "later" four times has answered.
 *   3. IT ASKS ONCE PER SESSION AT MOST, and never during checkout — a modal
 *      over a payment step is how a sale is lost.
 *
 * It is also never shown to somebody still in the signup wizard: that is
 * already asking the same questions.
 */

/** Routes where an interruption costs the person something. */
const NEVER_ON = ['/auth', '/welcome', '/checkout', '/cart', '/edit-profile'];

interface CompletionResponse {
  percent: number;
  complete: boolean;
  missing: string[];
  shouldPrompt: boolean;
}

export default function CompleteProfileSheet() {
  const { user } = useAuth();
  const { lang, dir } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const s = onboardingStrings(lang);

  const [data, setData] = useState<CompletionResponse | null>(null);
  const [open, setOpen] = useState(false);
  /** Asked already in THIS tab — independent of the server's schedule. */
  const [askedThisSession, setAskedThisSession] = useState(false);

  useEffect(() => {
    if (!user || askedThisSession) return;
    if (user.onboarding === 'new') return; // the wizard is asking
    let alive = true;
    api
      .get<{ success: true } & CompletionResponse>('/api/profile/completion')
      .then((r) => {
        if (!alive) return;
        setData(r);
        // Marked ASKED whether or not it opened: the question was put to the
        // server once for this tab, and asking again on every user-object
        // change would be a request per navigation for an answer that only
        // moves on a timescale of days.
        setAskedThisSession(true);
        if (r.shouldPrompt && !r.complete) setOpen(true);
      })
      .catch(() => {
        /* A prompt that cannot load is a prompt that is not shown. */
      });
    return () => {
      alive = false;
    };
  }, [user, askedThisSession]);

  const suppressed = NEVER_ON.some((p) => location.pathname === p || location.pathname.startsWith(`${p}/`));
  const visible = open && !!data && !suppressed;

  const dismiss = async () => {
    setOpen(false);
    try {
      await api.post('/api/profile/completion/dismiss', {});
    } catch {
      // The next load simply asks again — better than blocking the close.
    }
  };

  const complete = () => {
    setOpen(false);
    navigate('/edit-profile');
  };

  // At most four lines. A list of seven things to do reads as a chore.
  const items = (data?.missing ?? []).slice(0, 4);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
        >
          <button
            type="button"
            aria-label={s.close}
            onClick={dismiss}
            className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
          />
          <motion.div
            dir={dir}
            role="dialog"
            aria-modal="true"
            aria-labelledby="complete-profile-title"
            initial={{ opacity: 0, y: reduceMotion ? 0 : 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : 24 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="relative w-full max-w-sm rounded-t-3xl border border-zinc-800 bg-zinc-900 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl sm:pb-5"
          >
            <button
              type="button"
              onClick={dismiss}
              aria-label={s.close}
              className="absolute end-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-zinc-500 transition-colors hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>

            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-zinc-700 bg-zinc-800 text-gold">
                {user?.avatar_key ? (
                  <img src={`/files/${user.avatar_key}`} alt="" className="h-full w-full object-cover" />
                ) : (
                  <UserRound className="h-5 w-5" aria-hidden />
                )}
              </span>
              <div className="min-w-0">
                <h2 id="complete-profile-title" className="text-[16px] font-bold text-white">
                  {s.completeTitle}
                </h2>
                <p className="text-[12px] text-zinc-400">
                  {s.completePercent.replace('{p}', String(data?.percent ?? 0))}
                </p>
              </div>
            </div>

            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-gold transition-[width] duration-300"
                style={{ width: `${data?.percent ?? 0}%` }}
              />
            </div>

            <ul className="mt-4 space-y-2">
              {items.map((field) => (
                <li key={field} className="flex items-center gap-2 text-[13px] text-zinc-300">
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-gold/70" />
                  {missingLabel(s, field)}
                </li>
              ))}
            </ul>

            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                onClick={complete}
                className="min-h-[48px] rounded-xl bg-gold px-5 text-[14px] font-bold text-black transition-opacity duration-200 hover:opacity-90"
              >
                {s.completeNow}
              </button>
              <button
                type="button"
                onClick={dismiss}
                className="min-h-[44px] rounded-xl px-5 text-[13px] font-medium text-zinc-400 transition-colors duration-200 hover:text-white"
              >
                {s.later}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
