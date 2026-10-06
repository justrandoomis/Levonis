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
import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { Globe } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import type { Language } from '../translations';
import type { LangThemePanelProps } from './LangThemePanel';
import { toast } from '../lib/toastStore';
import { CENTER_REVEAL_MS, setThemePreference, useTheme, type ThemePreference } from '../lib/theme';

/** If the exit never reports (a hidden tab does not animate), act anyway. */
const EXIT_FALLBACK_MS = 900;

type PanelComponent = ComponentType<LangThemePanelProps>;
let loadedPanel: PanelComponent | null = null;
let panelLoad: Promise<PanelComponent> | null = null;

/** Share one download across header globes; a failed request can be retried. */
function loadPanel(): Promise<PanelComponent> {
  if (loadedPanel) return Promise.resolve(loadedPanel);
  panelLoad ??= import('./LangThemePanel').then((module) => {
    loadedPanel = module.default;
    return loadedPanel;
  }).catch((error: unknown) => {
    panelLoad = null;
    throw error;
  });
  return panelLoad;
}

function prewarmPanel(): void {
  void loadPanel().catch(() => { /* The next click retries a failed intent preload. */ });
}

export interface LangThemeButtonProps {
  /**
   * `home`: the 44px square the home header's controls share.
   * `dash`: the dashboard topbar's quieter icon, with the language code beside
   * it from `sm` up.
   */
  variant?: 'home' | 'dash';
  className?: string;
}

/** The header's globe, and the «اللغة والمظهر» sheet it opens. */
export default function LangThemeButton({ variant = 'home', className = '' }: LangThemeButtonProps) {
  const { lang, setLang, loc, dir } = useLanguage();
  const { preference } = useTheme();
  const titleId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [Panel, setPanel] = useState<PanelComponent | null>(() => loadedPanel);
  const mounted = useRef(true);
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

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.clearTimeout(fallback.current); };
  }, []);

  const openSheet = () => {
    // Touch browsers need an explicit opener while the sheet chunk arrives;
    // the shared focus trap can then return here when the sheet closes.
    buttonRef.current?.focus({ preventScroll: true });
    setLangPick(lang);
    setThemePick(preference);
    setOpen(true);
    if (loadedPanel) { setPanel(() => loadedPanel); return; }
    void loadPanel().then((component) => {
      if (mounted.current) setPanel(() => component);
    }).catch(() => {
      if (!mounted.current) return;
      setOpen(false);
      toast.error(loc('تعذّر فتح اللغة والمظهر. اضغط للمحاولة مجددًا.', 'Could not open language and appearance. Tap to retry.'));
    });
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
        onPointerEnter={prewarmPanel}
        onPointerDown={prewarmPanel}
        onFocus={prewarmPanel}
        onClick={() => (open ? closeThen(null) : openSheet())}
        onKeyDown={(event) => {
          if (open && !Panel && event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            closeThen(null);
          }
        }}
        aria-label={title}
        aria-expanded={open}
        aria-busy={open && !Panel}
        aria-haspopup="dialog"
        className={buttonClass}
      >
        {open && !Panel ? <span aria-hidden="true" className="h-5 w-5 rounded-full border-2 border-current border-t-transparent animate-spin motion-reduce:animate-none" /> : <Globe className="w-5 h-5" strokeWidth={2} aria-hidden="true" />}
        {variant === 'dash' && <span className="text-xs font-bold uppercase hidden sm:block">{lang}</span>}
      </button>

      {Panel && <Panel
        open={open}
        onClose={() => closeThen(null)}
        onExited={flush}
        titleId={titleId}
        title={title}
        langLabel={langLabel}
        themeLabel={themeLabel}
        dir={dir}
        langPick={langPick}
        themePick={themePick}
        chooseLang={chooseLang}
        chooseTheme={chooseTheme}
        onRowKeyDownCapture={onRowKeyDownCapture}
        onRowPointerDownCapture={onRowPointerDownCapture}
      />}
    </div>
  );
}
