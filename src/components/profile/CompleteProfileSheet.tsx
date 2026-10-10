import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X, UserRound } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Overlay';
import { onboardingStrings, missingLabel } from '../onboarding/strings';
import { isQuietRoute, setProfileStep } from '../../lib/firstRun';

/**
 * "Complete your profile" — ONCE, right after the account is created.
 *
 * The owner: «اجعل اكمال الملف الشخصي تظهر بعد انشاء الحساب لمره واحده (سواء
 * كان عبر كوكل او رقم او تلي او اي وسيله)». It used to be a reminder on a
 * widening schedule that skipped every account still in the signup wizard —
 * and only some signups ever reached the wizard, so a phone, Telegram or
 * sign-in-view Google account was never asked at all. Now:
 *
 *   1. EVERY SIGNUP LANDS HERE. Auth no longer sends a new account to
 *      /welcome; whatever the method, the account arrives as
 *      `onboarding === 'new'` and this sheet is what greets it. «أكمل الآن»
 *      opens the /welcome wizard, which is still the place the fields are
 *      filled in.
 *   2. WHETHER TO ASK IS DECIDED BY THE SERVER, from the user row
 *      (`shouldPromptCompletion`), so it holds on every device and survives
 *      clearing site data.
 *   3. IT IS STAMPED THE MOMENT IT IS SHOWN (POST /completion/seen), not when
 *      it is answered — a sheet the person walked away from does not come
 *      back. Closing it moves the account to 'skipped' (POST
 *      /completion/dismiss); the wizard's own finish moves it to 'done'.
 *   4. It never shows on a route where an interruption costs something
 *      (checkout, the cart, the wizard itself); it waits for the next page.
 *
 * WHAT COMES NEXT. Closing it, either way, hands over to the theme sheet
 * (src/components/profile/ThemeIntroSheet.tsx) through src/lib/firstRun.ts,
 * which owns the order: the theme sheet never opens before this one has had
 * its turn.
 */

interface CompletionResponse {
  percent: number;
  complete: boolean;
  missing: string[];
  shouldPrompt: boolean;
}

export default function CompleteProfileSheet() {
  const { user, refreshUser } = useAuth();
  const { lang } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const s = onboardingStrings(lang);

  const [data, setData] = useState<CompletionResponse | null>(null);
  const [open, setOpen] = useState(false);
  /** The account this tab already asked the server about. */
  const askedFor = useRef<string | null>(null);
  const stamped = useRef(false);

  const userId = user?.id ?? null;
  const firstRun = user?.onboarding === 'new';

  useEffect(() => {
    if (!userId || askedFor.current === userId) return;
    askedFor.current = userId;
    // An account past its first run never pays for the request.
    if (!firstRun) {
      setProfileStep(userId, 'none');
      return;
    }
    // No cancel-on-cleanup: the guard above means a re-run (StrictMode, a
    // refreshed user object) does not ask again, so the one answer must land.
    // It is dropped only if the account changed while it was in flight.
    api
      .get<{ success: true } & CompletionResponse>('/api/profile/completion')
      .then((r) => {
        if (askedFor.current !== userId) return;
        setData(r);
        if (r.shouldPrompt && !r.complete) {
          setOpen(true);
          setProfileStep(userId, 'open');
        } else {
          setProfileStep(userId, 'none');
        }
      })
      .catch(() => {
        // A prompt that cannot load is not shown — and the step stays
        // 'pending', so the theme sheet does not jump the queue either.
        if (askedFor.current === userId) askedFor.current = null;
      });
  }, [userId, firstRun]);

  const suppressed = isQuietRoute(location.pathname);
  const visible = open && !!data && !suppressed;

  // Stamped on SCREEN, once: from here on the server never asks again.
  useEffect(() => {
    if (!visible || stamped.current) return;
    stamped.current = true;
    api.post('/api/profile/completion/seen', {}).catch(() => {
      /* the close below stamps it too */
    });
  }, [visible]);

  const close = () => {
    setOpen(false);
    if (userId) setProfileStep(userId, 'closed');
  };

  const dismiss = async () => {
    close();
    try {
      await api.post('/api/profile/completion/dismiss', {});
      await refreshUser();
    } catch {
      // Already stamped as seen on arrival; the server will not ask again.
    }
  };

  const complete = () => {
    close();
    // The wizard is the fill-in-the-fields flow for a new account; it carries
    // the person back to the page they were on when they finish or skip it.
    const here = `${location.pathname}${location.search}`;
    navigate(`/welcome?next=${encodeURIComponent(here)}`);
  };

  // At most four lines. A list of seven things to do reads as a chore.
  const items = (data?.missing ?? []).slice(0, 4);

  /* ------------------------------------------------------------- the window
     A SHEET, NOT A DIALOG, and it always was one — by name, by placement
     (`items-end` on a phone, centred only from `sm:`) and by intent. This is
     the app asking a favour, not a task the person came here to do, so the
     right way to answer it is to push it back down off the bottom edge with a
     thumb. `Sheet` gives it exactly that: the panel tracks the finger 1:1
     downward, resists progressively upward, and decides on release by
     PROJECTED momentum rather than by where the finger stopped — a flick
     throws it away even from near the top, and a slow drag that was
     decelerating springs back. A drag-away lands on `dismiss`, the same call
     the X and "later" already made, so throwing it off the screen tells the
     server "not now" exactly as tapping the words does. That matters for THIS
     window more than for most: the whole design above is about the prompt not
     being a nag, and a gesture that closed it without recording the answer
     would bring it straight back on the next page.

     WHAT IT USED TO BE. Its own `fixed inset-0` with a hand-rolled
     `AnimatePresence` and two tweens — a 0.15s fade on the backdrop and a
     0.2s/24px lift on the panel. Tweens run for a duration fixed in advance
     from a value captured at the start, so this window could not be caught:
     dismiss it 80ms into its arrival and the exit began from the top of the
     travel rather than from where the panel actually was. The spring behind
     the primitive animates from its live presentation value, which is what
     makes the arrival interruptible, and enter and exit are now literally the
     same object so they cannot drift apart.

     MODAL (the primitive's default) is right, and it is a preservation: the
     old backdrop was a 2px-blurred `bg-black/70`, so this window already
     dimmed and pushed the page back. `dismissOnScrim` stays at its default
     TRUE because that backdrop was a real `<button>` wired to `dismiss` —
     tapping outside has always closed this, and removing it would be as much
     of a behaviour change as adding it. Escape is new; there was no key
     listener here to delete, and the primitive owns that key now.

     BOTH `label` AND `labelledBy` are passed on purpose. `labelledBy` carries
     across the old `aria-labelledby="complete-profile-title"` verbatim, so the
     window is still named by the heading a sighted person reads. `label` is
     not used for the panel when `labelledBy` is set — it names the SCRIM
     button, which the old markup gave `aria-label={s.close}`; without it the
     scrim would fall back to the primitive's generic Arabic default and this
     window would quietly lose a translated string it had. */
  return (
    <Sheet
      open={visible}
      onClose={dismiss}
      label={s.close}
      labelledBy="complete-profile-title"
      z={60}
      testId="complete-profile-sheet"
      // Geometry only — the material, the border and the rounding (rounded top
      // on a phone, all four corners from `sm:`) are the primitive's, and they
      // are the same shape the hand-rolled panel drew for itself.
      panelClassName="w-full max-w-sm"
    >
      {/* The padding that used to sit on the panel itself lives here now,
          including the safe-area floor: on a phone this sheet sits against the
          bottom edge, so the last button has to clear the home indicator. */}
      <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5">
        <button
          type="button"
          onClick={dismiss}
          aria-label={s.close}
          className="absolute end-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text-primary hover:bg-white/[0.06] active:bg-[var(--clay-well-bg)] active:shadow-press"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>

        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border-subtle bg-surface-raised text-gold">
            {user?.avatar_key ? (
              <img src={`/files/${user.avatar_key}`} alt="" className="h-full w-full object-cover" />
            ) : (
              <UserRound className="h-5 w-5" aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <h2 id="complete-profile-title" className="text-[16px] font-bold text-text-primary">
              {s.completeTitle}
            </h2>
            <p className="text-[12px] text-text-secondary">
              {s.completePercent.replace('{p}', String(data?.percent ?? 0))}
            </p>
          </div>
        </div>

        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full lv-well">
          <div
            className="h-full rounded-full bg-gold transition-[width] duration-300"
            style={{ width: `${data?.percent ?? 0}%` }}
          />
        </div>

        <ul className="mt-4 space-y-2">
          {items.map((field) => (
            <li key={field} className="flex items-center gap-2 text-[13px] text-text-secondary">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-gold/70" />
              {missingLabel(s, field)}
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={complete}
            className="lv-button lv-button-primary min-h-12"
          >
            {s.completeNow}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="lv-button lv-button-ghost text-[13px] font-medium"
          >
            {s.later}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
