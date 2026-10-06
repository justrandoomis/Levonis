import type { KeyboardEvent, ReactNode } from 'react';
import { Globe, Moon, Sun, SunMoon } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import type { Language } from '../translations';
import type { ThemePreference } from '../lib/theme';
import { Sheet } from './ui/Overlay';
import { Segmented } from './ui/Segmented';

export interface LangThemePanelProps {
  open: boolean;
  onClose: () => void;
  onExited: () => void;
  titleId: string;
  title: string;
  langLabel: string;
  themeLabel: string;
  dir: 'rtl' | 'ltr';
  langPick: Language;
  themePick: ThemePreference;
  chooseLang: (id: string) => void;
  chooseTheme: (id: string) => void;
  onRowKeyDownCapture: (event: KeyboardEvent) => void;
  onRowPointerDownCapture: () => void;
}

const LANGS: ReadonlyArray<readonly [Language, string]> = [
  ['ar', 'العربية'],
  ['en', 'English'],
  ['ckb', 'کوردی'],
];

function ThemeLabel({ icon, text }: { icon: ReactNode; text: string }) {
  return <span className="flex flex-col items-center gap-1 py-1.5">{icon}<span>{text}</span></span>;
}

/** Loaded on globe intent; the shared sheet keeps focus, keyboard and exit behavior. */
export default function LangThemePanel({
  open, onClose, onExited, titleId, title, langLabel, themeLabel, dir,
  langPick, themePick, chooseLang, chooseTheme,
  onRowKeyDownCapture, onRowPointerDownCapture,
}: LangThemePanelProps) {
  const { loc } = useLanguage();
  return (
      <Sheet
        open={open}
        onClose={onClose}
        onExited={onExited}
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
  );
}
