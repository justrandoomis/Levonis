import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Coins, Globe, Moon, Sun, SunMoon } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import type { Language } from '../translations';
import type { ThemePreference } from '../lib/theme';
import { useOptionalMoney, type DisplayCurrency } from '../CurrencyContext';
import { wholeRateText } from '../lib/rateText';
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
  /** The display-currency row: the home header only — the dashboard has no such row. */
  withCurrency: boolean;
  dir: 'rtl' | 'ltr';
  langPick: Language;
  themePick: ThemePreference;
  chooseLang: (id: string) => void;
  chooseTheme: (id: string) => void;
  /** Close the sheet, then make the change (null: only close); an arrow key only moves the pick. */
  commit: (change: (() => void) | null) => void;
  onRowKeyDownCapture: (event: KeyboardEvent) => void;
  onRowPointerDownCapture: () => void;
}

const LANGS: ReadonlyArray<readonly [Language, string]> = [
  ['ar', 'العربية'],
  ['en', 'English'],
  ['ckb', 'کوردی'],
];

/** IQWealth's own site — the attribution its free plan asks for (plan §14.4 risk 3). */
export const IQWEALTH_URL = 'https://iraqsm.com';

/** The two display currencies: the code, then its name in the reader's language. */
export const CURRENCY_NAMES: Readonly<Record<DisplayCurrency, Readonly<Record<Language, string>>>> = {
  IQD: { ar: 'الدينار العراقي', en: 'Iraqi dinar', ckb: 'دیناری عێراقی' },
  USD: { ar: 'الدولار الأمريكي', en: 'US dollar', ckb: 'دۆلاری ئەمریکی' },
};

/** The full label, as the plan writes it: «IQD — الدينار العراقي». */
export const currencyChoiceLabel = (code: DisplayCurrency, lang: Language) => `${code} — ${CURRENCY_NAMES[code][lang]}`;

function ThemeLabel({ icon, text }: { icon: ReactNode; text: string }) {
  return <span className="flex flex-col items-center gap-1 py-1.5">{icon}<span>{text}</span></span>;
}

/**
 * The code above its name. «IQD — الدينار العراقي» on one line does not fit
 * half of a 390px phone; stacked, it reads as the same two facts. The screen
 * reader hears the whole label.
 */
function CurrencyLabel({ code, lang }: { code: DisplayCurrency; lang: Language }) {
  return (
    <span className="flex flex-col items-center gap-0.5 py-1.5">
      <span className="sr-only">{currencyChoiceLabel(code, lang)}</span>
      <span aria-hidden="true" dir="ltr" className="tabular-nums">{code}</span>
      <span aria-hidden="true" className="text-[11.5px] font-semibold opacity-80">{CURRENCY_NAMES[code][lang]}</span>
    </span>
  );
}

/** A row's heading: a quiet label with its icon. */
function RowLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="mb-2 flex items-center gap-2 text-[12px] font-bold text-zinc-400">
      {icon}
      {children}
    </p>
  );
}

/**
 * Under the currency row: what the choice does («للعرض فقط»), and — while
 * dollars are chosen and a rate is known — the rate itself, named as THE
 * SHOP'S rate, because it includes the owner's adjustment (critique L8). The
 * IQWealth attribution is given only when the rate really is the provider's
 * figure (`displayUsdRateAttributed`); a rate the owner typed, and the shop
 * rate this device remembered from its last visit, are «a rate set by the
 * shop» (FX-1 review #10). The rate reads in whole dinars after «≈» — four
 * decimals there were false precision (UX review #15); the conversion itself
 * uses the exact text. The wallet's rate is never shown here (owner decision
 * 9): with dollars chosen and no shop rate yet, prices read in dinars and the
 * caption says the dollar reading comes once the shop's rate is approved.
 */
export function CurrencyCaptions({ pick }: { pick: DisplayCurrency }) {
  const { lang, loc } = useLanguage();
  const money = useOptionalMoney();
  const rate = pick === 'USD' ? money?.rate ?? null : null;
  const unit = lang === 'en' ? 'IQD' : lang === 'ckb' ? 'دینار' : 'د.ع';
  const figure = rate ? (
    <bdi dir="ltr" className="whitespace-nowrap tabular-nums">1 $ ≈ {wholeRateText(rate.text)} {unit}</bdi>
  ) : null;
  return (
    <div className="mt-2 space-y-1 text-[12px] leading-relaxed text-zinc-400" data-currency-captions>
      <p>
        {loc(
          'للعرض فقط — الدفع والفواتير بالدينار',
          'Display only — you pay and are billed in dinars',
          'تەنها بۆ پیشاندانە — پارەدان و پسوولە بە دینارە'
        )}
      </p>
      {figure && rate?.source === 'shop' && rate.attributed !== false && (
        <p data-currency-rate="shop">
          {figure}
          {' — '}
          {loc('سعر المتجر، بناءً على بيانات', "the shop's rate, based on", 'نرخی فرۆشگا، لەسەر بنەمای زانیاریی')}{' '}
          <a
            href={IQWEALTH_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-iqwealth-attribution
            className="rounded-sm font-semibold text-zinc-300 underline decoration-zinc-500 underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {lang === 'en' ? 'IQWealth data' : 'IQWealth'}
            <span aria-hidden="true">↗</span>
          </a>
        </p>
      )}
      {figure && rate && (rate.source !== 'shop' || rate.attributed === false) && (
        <p data-currency-rate="fixed">
          {figure}
          {' — '}
          {loc('سعر يحدده المتجر', 'a rate set by the shop', 'نرخێک کە فرۆشگا دایناوە')}
        </p>
      )}
      {pick === 'USD' && !rate && (
        <p data-currency-usd-pending>
          {loc(
            'القراءة بالدولار متاحة بعد اعتماد سعر المتجر؛ الأسعار تُعرض بالدينار الآن.',
            "The dollar reading is available once the shop's rate is approved; prices show in dinars for now.",
            'خوێندنەوە بە دۆلار دوای پەسەندکردنی نرخی فرۆشگاکە بەردەست دەبێت؛ ئێستا نرخەکان بە دینار پیشان دەدرێن.'
          )}
        </p>
      )}
    </div>
  );
}

/** Loaded on globe intent; the shared sheet keeps focus, keyboard and exit behavior. */
export default function LangThemePanel({
  open, onClose, onExited, titleId, title, langLabel, themeLabel, withCurrency, dir,
  langPick, themePick, chooseLang, chooseTheme, commit,
  onRowKeyDownCapture, onRowPointerDownCapture,
}: LangThemePanelProps) {
  const { lang, loc } = useLanguage();
  // THE DISPLAY CURRENCY. Outside a CurrencyProvider the row is not offered.
  const money = useOptionalMoney();
  const currency = money?.currency ?? 'IQD';
  const [currencyPick, setCurrencyPick] = useState<DisplayCurrency>(currency);
  // Each opening starts from the currency in use, as the other rows do.
  useEffect(() => {
    if (open) setCurrencyPick(currency);
  }, [open, currency]);
  const currencyLabel = withCurrency && money ? loc('عملة العرض', 'Display currency', 'دراوی پیشاندان') : null;
  const chooseCurrency = (id: string) => {
    const next: DisplayCurrency = id === 'USD' ? 'USD' : 'IQD';
    setCurrencyPick(next);
    // The same path as the other two rows: the sheet leaves, then the prices
    // re-render from memory (setCurrency is synchronous). No request is made.
    commit(next === currency || !money ? null : () => money.setCurrency(next));
  };
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
            {/* 1 — the appearance. */}
            <div onKeyDownCapture={onRowKeyDownCapture} onPointerDownCapture={onRowPointerDownCapture} data-lang-theme-row="appearance">
              <RowLabel icon={<SunMoon className="h-4 w-4" aria-hidden="true" />}>{themeLabel}</RowLabel>
              <Segmented
                group="sheet-appearance"
                label={themeLabel}
                value={themePick}
                onChange={chooseTheme}
                dataAttr="data-theme-choice"
                // The icon sits ABOVE the word: «حسب الجهاز» beside an icon
                // does not fit a third of a 390px phone.
                items={[
                  { id: 'light', label: <ThemeLabel icon={<Sun aria-hidden="true" className="h-4 w-4" />} text={loc('فاتح', 'Light', 'ڕووناک')} /> },
                  { id: 'dark', label: <ThemeLabel icon={<Moon aria-hidden="true" className="h-4 w-4" />} text={loc('داكن', 'Dark', 'تاریک')} /> },
                  { id: 'system', label: <ThemeLabel icon={<SunMoon aria-hidden="true" className="h-4 w-4" />} text={loc('حسب الجهاز', 'System', 'بەپێی ئامێر')} /> },
                ]}
              />
            </div>

            {/* 2 — the language. */}
            <div onKeyDownCapture={onRowKeyDownCapture} onPointerDownCapture={onRowPointerDownCapture} data-lang-theme-row="language">
              <RowLabel icon={<Globe className="h-4 w-4" aria-hidden="true" />}>{langLabel}</RowLabel>
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

            {/* 3 — the display currency (home only). */}
            {currencyLabel !== null && (
              <div onKeyDownCapture={onRowKeyDownCapture} onPointerDownCapture={onRowPointerDownCapture} data-lang-theme-row="currency">
                <RowLabel icon={<Coins className="h-4 w-4" aria-hidden="true" />}>{currencyLabel}</RowLabel>
                <Segmented
                  group="sheet-currency"
                  label={currencyLabel}
                  value={currencyPick}
                  onChange={chooseCurrency}
                  dataAttr="data-currency-choice"
                  items={(['IQD', 'USD'] as const).map((code) => ({
                    id: code,
                    label: <CurrencyLabel code={code} lang={lang} />,
                  }))}
                />
                <CurrencyCaptions pick={currencyPick} />
              </div>
            )}
          </div>
        </div>
      </Sheet>
  );
}
