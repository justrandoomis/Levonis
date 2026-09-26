/**
 * «اللغة والمظهر» — THE GLOBE OPENS ONE SHEET FOR BOTH.
 *
 * The owner: «في اختيار اللغة ادمج بهذه الأيقونة اللغة والمظهر يعني يظهر نافذة
 * منبثقة مثل الإشعارات من الأسفل … بسطرين السطر الأول اللغة والسطر الثاني
 * المظهر». The globe in the header used to open a three-line language dropdown;
 * it now opens a bottom sheet in the notifications sheet's clothes (the same
 * `Sheet` from ui/Overlay: grabber, rounded top, scrim, swipe-down, Escape,
 * focus trap, safe area) with two rows — the language, then the appearance.
 *
 * THE SHEET LEAVES FIRST, THEN THE CHANGE. A choice closes the sheet at once;
 * only when it has fully slid away (`onExited`) is the change made, so the
 * motion reads as one calm sequence and never as two things fighting:
 *   - a theme: the new theme opens as a spot in the MIDDLE of the screen and
 *     widens into a circle until it fills it (src/lib/theme.ts,
 *     `{ origin: 'center' }`);
 *   - a language: the page fades out drifting toward the side it read from and
 *     the new language fades in from its own side (src/lib/langSwap.ts).
 * Choosing what is already chosen — or «حسب الجهاز» when the device is already
 * in that theme — only closes the sheet.
 *
 * EVERY WIDTH IS A BOTTOM SHEET (`docked`). The notifications panel becomes a
 * dropdown from `sm` up, but the owner photographed this on an iPad and asked
 * for a window «من الأسفل» that is lowered away before the theme changes — a
 * dropdown cannot be lowered. At iPad width it is the same sheet, capped at
 * `max-w-md` and centred on the bottom edge.
 *
 * KEYBOARD. The rows are `Segmented` radio groups. Arrow keys MOVE the choice
 * without committing it (a radio group that closed its window on the first
 * arrow press would make «English» unreachable from «العربية»); Enter, Space
 * or a click commits.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Globe, Moon, Sun, SunMoon } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import type { Language } from '../translations';
import { Sheet } from './ui/Overlay';
import { Segmented } from './ui/Segmented';
import { CENTER_REVEAL_MS, setThemePreference, useTheme, type ThemePreference } from '../lib/theme';

/** If the exit never reports (a hidden tab does not animate), act anyway. */
const EXIT_FALLBACK_MS = 900;

const LANGS: ReadonlyArray<readonly [Language, string]> = [
  ['ar', 'العربية'],
  ['en', 'English'],
  ['ckb', 'کوردی'],
];

export interface LangThemeButtonProps {
  /**
   * `home`: the 44px square the home header's controls share.
   * `dash`: the dashboard topbar's quieter icon, with the language code beside
   * it from `sm` up.
   */
  variant?: 'home' | 'dash';
  className?: string;
}

function ThemeLabel({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <span className="flex flex-col items-center gap-1 py-1.5">
      {icon}
      <span>{text}</span>
    </span>
  );
}

/** The header's globe, and the «اللغة والمظهر» sheet it opens. */
export default function LangThemeButton({ variant = 'home', className = '' }: LangThemeButtonProps) {
  const { lang, setLang, loc, dir } = useLanguage();
  const { preference } = useTheme();
  const titleId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // What the rows show as chosen while the sheet is up: the tap's answer at
  // once, before the change itself (which waits for the sheet to leave).
  const [langPick, setLangPick] = useState<Language>(lang);
  const [themePick, setThemePick] = useState<ThemePreference>(preference);
  const pending = useRef<null | (() => void)>(null);
  const fallback = useRef<number | undefined>(undefined);
  // Set by an arrow/Home/End key inside a row: that change only moves the pick.
  const navigating = useRef(false);

  const flush = useCallback(() => {
    window.clearTimeout(fallback.current);
    const run = pending.current;
    pending.current = null;
    run?.();
  }, []);

  useEffect(() => () => window.clearTimeout(fallback.current), []);

  const openSheet = () => {
    setLangPick(lang);
    setThemePick(preference);
    setOpen(true);
  };

  /** Close, and make `change` once the sheet is gone. */
  const closeThen = (change: (() => void) | null) => {
    pending.current = change;
    setOpen(false);
    window.clearTimeout(fallback.current);
    if (change) fallback.current = window.setTimeout(flush, EXIT_FALLBACK_MS);
  };

  const chooseLang = (id: string) => {
    const next = id as Language;
    setLangPick(next);
    if (navigating.current) {
      navigating.current = false;
      return;
    }
    closeThen(next === lang ? null : () => setLang(next));
  };

  const chooseTheme = (id: string) => {
    const next = id as ThemePreference;
    setThemePick(next);
    if (navigating.current) {
      navigating.current = false;
      return;
    }
    // A choice that paints the same theme is stored and nothing moves
    // (setThemePreference decides that, against what is on screen).
    closeThen(next === preference ? null : () => setThemePreference(next, { origin: 'center', duration: CENTER_REVEAL_MS }));
  };

  const onRowKeyDownCapture = (e: KeyboardEvent) => {
    navigating.current = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key);
  };
  const onRowPointerDownCapture = () => {
    navigating.current = false;
  };

  // OWNER: Sorani to be written by hand. (The title below falls back to
  // Arabic in Sorani; «زمان» is the Settings page's own Sorani word.)
  const title = loc('اللغة والمظهر', 'Language & appearance');
  const langLabel = loc('اللغة', 'Language', 'زمان');
  // OWNER: Sorani to be written by hand (the four appearance strings below).
  const themeLabel = loc('المظهر', 'Appearance');

  const buttonClass =
    variant === 'home'
      ? 'flex h-11 w-11 items-center justify-center rounded-xl bg-surface/95 text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus'
      : 'hover:text-gilt transition-colors flex items-center gap-1.5 min-h-11 min-w-11 justify-center px-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

  return (
    <div className={className}>
      <button
        ref={buttonRef}
        type="button"
        data-lang-theme-trigger={variant}
        onClick={() => (open ? closeThen(null) : openSheet())}
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={buttonClass}
      >
        <Globe className="w-5 h-5" strokeWidth={2} aria-hidden="true" />
        {variant === 'dash' && <span className="text-xs font-bold uppercase hidden sm:block">{lang}</span>}
      </button>

      <Sheet
        open={open}
        onClose={() => closeThen(null)}
        onExited={flush}
        docked
        label={title}
        labelledBy={titleId}
        z={220}
        testId="lang-theme-sheet"
        panelClassName="w-full max-w-md"
      >
        <div dir={dir} data-lang-theme="panel" className="flex flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5">
            <h2 id={titleId} className="text-[13px] font-bold text-white">
              {title}
            </h2>
          </div>

          <div className="flex flex-col gap-4 px-4 pt-4 pb-5">
            <div onKeyDownCapture={onRowKeyDownCapture} onPointerDownCapture={onRowPointerDownCapture} data-lang-theme-row="language">
              <p className="mb-2 flex items-center gap-2 text-[12px] font-bold text-zinc-400">
                <Globe className="h-4 w-4" aria-hidden="true" />
                {langLabel}
              </p>
              <Segmented
                group="sheet-language"
                label={langLabel}
                value={langPick}
                onChange={chooseLang}
                dataAttr="data-lang-choice"
                items={LANGS.map(([code, name]) => ({
                  id: code,
                  label: <span lang={code}>{name}</span>,
                }))}
              />
            </div>

            <div onKeyDownCapture={onRowKeyDownCapture} onPointerDownCapture={onRowPointerDownCapture} data-lang-theme-row="appearance">
              <p className="mb-2 flex items-center gap-2 text-[12px] font-bold text-zinc-400">
                <SunMoon className="h-4 w-4" aria-hidden="true" />
                {themeLabel}
              </p>
              <Segmented
                group="sheet-appearance"
                label={themeLabel}
                value={themePick}
                onChange={chooseTheme}
                dataAttr="data-theme-choice"
                // The icon sits ABOVE the word: «حسب الجهاز» beside an icon
                // does not fit a third of a 390px phone.
                items={[
                  { id: 'light', label: <ThemeLabel icon={<Sun aria-hidden="true" className="h-4 w-4" />} text={loc('فاتح', 'Light')} /> },
                  { id: 'dark', label: <ThemeLabel icon={<Moon aria-hidden="true" className="h-4 w-4" />} text={loc('داكن', 'Dark')} /> },
                  { id: 'system', label: <ThemeLabel icon={<SunMoon aria-hidden="true" className="h-4 w-4" />} text={loc('حسب الجهاز', 'Device')} /> },
                ]}
              />
            </div>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
