import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Check } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Overlay';
import {
  hasStoredThemePreference,
  setThemePreference,
  useTheme,
  type Theme,
  type ThemePreference,
} from '../../lib/theme';
import {
  isQuietRoute,
  readThemeIntro,
  shouldShowThemeIntro,
  useProfileStep,
  writeThemeIntro,
  type ThemeIntroRecord,
} from '../../lib/firstRun';

/**
 * «اختر المظهر» — the first-run theme picker, once per account.
 *
 * The owner: «يتم عرض له لمرة واحدة فقط ليختار الثيم ويحفظ … ويظهر اختيار الثيم
 * بعد اغلاق نافذه اكمال الملف الشخصي (سواء تم اغلاقه او تم اكماله) بنافذه منبثقه
 * من الاسفل ايضا apple design». When it opens, and for whom, is decided by
 * src/lib/firstRun.ts; this file is the window.
 *
 * THE CHOICE IS THE PREVIEW. A tap on a card applies that theme at once — the
 * page behind the sheet turns with the circular reveal from src/lib/theme.ts —
 * and stores it; there is no separate "save". «تم» only closes. Closing it any
 * other way (the scrim, Escape, a throw downwards) is the same answer: whatever
 * is on screen is kept, and it is written down so this browser has a choice.
 *
 * THE THREE CARDS each draw a tiny page IN THEIR OWN THEME: the preview sets
 * `data-theme` on itself, and the theme tokens (src/index.css) are attribute
 * selectors, so the same classes paint ivory in one card and black in the
 * next whatever the page is in. «حسب الجهاز» is both, split on the diagonal.
 */

/** Lets the profile sheet finish leaving before this one arrives. */
const HANDOVER_MS = 380;

function MiniPage({ theme }: { theme: Theme }) {
  return (
    <span data-theme={theme} className="absolute inset-0 flex flex-col gap-1.5 bg-black p-2">
      <span className="flex items-center justify-between">
        <span className="h-1.5 w-7 rounded-full bg-white/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-zinc-800" />
      </span>
      <span className="flex h-7 items-end rounded-md bg-surface-raised p-1.5 ring-1 ring-white/[0.06]">
        <span className="h-1.5 w-8 rounded-full bg-gold" />
      </span>
      <span className="grid grid-cols-2 gap-1">
        <span className="h-6 rounded-md bg-surface ring-1 ring-white/[0.06]" />
        <span className="h-6 rounded-md bg-surface ring-1 ring-white/[0.06]" />
      </span>
      <span className="h-1 w-3/4 rounded-full bg-zinc-700" />
      <span className="h-1 w-1/2 rounded-full bg-zinc-700" />
      <span className="mt-auto flex h-3 items-center justify-center gap-1.5 self-center rounded-full bg-surface-raised px-2 ring-1 ring-white/[0.06]">
        <span className="h-1 w-1 rounded-full bg-gold" />
        <span className="h-1 w-1 rounded-full bg-zinc-600" />
        <span className="h-1 w-1 rounded-full bg-zinc-600" />
      </span>
    </span>
  );
}

function Preview({ choice }: { choice: ThemePreference }) {
  return (
    <span aria-hidden className="relative block aspect-[4/5] w-full overflow-hidden rounded-[14px]">
      {choice === 'system' ? (
        <>
          <MiniPage theme="light" />
          <span className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
            <MiniPage theme="dark" />
          </span>
        </>
      ) : (
        <MiniPage theme={choice} />
      )}
    </span>
  );
}

export default function ThemeIntroSheet() {
  const { user } = useAuth();
  const { loc } = useLanguage();
  const location = useLocation();
  const { preference, theme } = useTheme();

  const userId = user?.id ?? null;
  const profileStep = useProfileStep(userId);
  const quiet = isQuietRoute(location.pathname);

  const [record, setRecord] = useState<ThemeIntroRecord>(null);
  const [open, setOpen] = useState(false);

  // Re-read on every step change: a close of the profile sheet writes 'owed'.
  useEffect(() => {
    setRecord(userId ? readThemeIntro(userId) : null);
  }, [userId, profileStep]);

  const due =
    !open &&
    shouldShowThemeIntro({
      userId,
      profileStep,
      record,
      hasStoredPreference: hasStoredThemePreference(),
      quiet,
    });

  useEffect(() => {
    if (!due || !userId) return;
    const t = window.setTimeout(() => {
      // Stamped on screen: whatever happens next, it is not shown again.
      writeThemeIntro(userId, 'seen');
      setRecord('seen');
      setOpen(true);
    }, HANDOVER_MS);
    return () => window.clearTimeout(t);
  }, [due, userId]);

  // Signed out while it was open: it goes with the account.
  useEffect(() => {
    if (!userId) setOpen(false);
  }, [userId]);

  const close = () => {
    setOpen(false);
    // Kept as chosen — or, untouched, as it is on screen — so this browser
    // now holds an answer. Same theme, so nothing repaints.
    if (!hasStoredThemePreference()) setThemePreference(preference, null);
  };

  const pick = (choice: ThemePreference, e: React.MouseEvent<HTMLButtonElement>) => {
    // A keyboard "click" has no position (detail 0): the reveal then grows
    // from the focused card, which theme.ts finds on its own.
    const origin = e.detail > 0 ? { x: e.clientX, y: e.clientY } : undefined;
    setThemePreference(choice, origin);
  };

  // OWNER: Sorani to be written by hand (every string in this sheet).
  const OPTIONS: Array<{ id: ThemePreference; label: string; hint: string }> = [
    { id: 'light', label: loc('فاتح', 'Light'), hint: loc('عاجي دافئ', 'Warm ivory') },
    { id: 'dark', label: loc('داكن', 'Dark'), hint: loc('أسود هادئ', 'Quiet black') },
    {
      id: 'system',
      label: loc('حسب الجهاز', 'Device'),
      hint: theme === 'dark' ? loc('داكن الآن', 'Dark right now') : loc('فاتح الآن', 'Light right now'),
    },
  ];

  return (
    <Sheet
      open={open && !quiet}
      onClose={close}
      labelledBy="theme-intro-title"
      describedBy="theme-intro-note"
      z={61}
      testId="theme-intro-sheet"
      panelClassName="w-full sm:max-w-md"
    >
      <div className="px-5 pt-2 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-5 sm:pb-6">
        <h2 id="theme-intro-title" className="text-center text-[19px] font-bold text-white">
          {loc('اختر المظهر', 'Choose your look')}
        </h2>
        <p className="mx-auto mt-1 max-w-[18rem] text-center text-[13px] leading-relaxed text-zinc-400">
          {loc('فاتح أو داكن، أو دعه يتبع إعداد جهازك.', 'Light or dark — or let it follow your device.')}
        </p>

        <div role="group" aria-labelledby="theme-intro-title" className="mt-5 grid grid-cols-3 gap-2.5 sm:gap-3">
          {OPTIONS.map((o) => {
            const on = preference === o.id;
            return (
              <button
                key={o.id}
                type="button"
                aria-pressed={on}
                data-theme-intro-choice={o.id}
                onClick={(e) => pick(o.id, e)}
                className={`group flex min-h-[44px] flex-col items-stretch gap-2 rounded-[18px] p-1.5 text-center transition-[box-shadow,background-color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                  on ? 'bg-surface-selected ring-2 ring-gold' : 'bg-surface ring-1 ring-white/10 hover:ring-white/25'
                }`}
              >
                <span className="relative block">
                  <Preview choice={o.id} />
                  <span
                    aria-hidden
                    className={`absolute top-1.5 end-1.5 flex h-5 w-5 items-center justify-center rounded-full transition-[opacity,transform] duration-200 ${
                      on ? 'scale-100 bg-gold text-accent-contrast opacity-100' : 'scale-75 opacity-0'
                    }`}
                  >
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </span>
                </span>
                <span className="px-0.5 pb-1">
                  <span className={`block text-[13px] font-bold ${on ? 'text-white' : 'text-zinc-300'}`}>{o.label}</span>
                  <span className="block text-[11px] text-zinc-500">{o.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        <p id="theme-intro-note" className="mt-4 text-center text-[12px] leading-relaxed text-zinc-500">
          {loc('يمكنك تغييره لاحقًا من الإعدادات ← المظهر.', 'You can change it any time in Settings → Appearance.')}
        </p>

        <button
          type="button"
          onClick={close}
          className="mt-4 min-h-[48px] w-full rounded-xl bg-gold px-5 text-[15px] font-bold text-accent-contrast transition-opacity duration-200 hover:opacity-90"
        >
          {loc('تم', 'Done')}
        </button>
      </div>
    </Sheet>
  );
}
