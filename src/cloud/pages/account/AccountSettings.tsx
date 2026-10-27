/**
 * /account/settings — HOW PRINT CLOUD READS AND LOOKS, and the way to the
 * Levonis account itself.
 *
 * The language and the appearance are the house's own (LanguageContext,
 * src/lib/theme.ts — the header's globe sets the same two). Each choice is a
 * pressed button, not a radio group: an arrow key in a radio group would
 * switch the whole page's language (and its direction) under the reader's
 * fingers. The name, the photo, the password and the notifications belong to
 * the Levonis account and are changed on Levonis.
 */
import { Button } from '../../../components/ui/Button';
import { useLanguage } from '../../../LanguageContext';
import { CENTER_REVEAL_MS, setThemePreference, useTheme, type ThemePreference } from '../../../lib/theme';
import type { Language } from '../../../translations';
import { useCloud } from '../../CloudContext';
import { account, settingsText } from '../../strings/account';
import { useCloudText } from '../../text';
import type { Tri } from '../../types';
import { ExternalLink, User } from '../../ui';
import { SubPageHeader } from './shared';

/** Each language in its own name — the way a reader finds theirs in any language. */
const LANGUAGES: ReadonlyArray<readonly [Language, string]> = [
  ['ar', 'العربية'],
  ['en', 'English'],
  ['ckb', 'کوردی'],
];

const THEMES: ReadonlyArray<readonly [ThemePreference, Tri]> = [
  ['light', settingsText.themeLight],
  ['dark', settingsText.themeDark],
  ['system', settingsText.themeSystem],
];

function Choices<T extends string>({ label, value, options, onChoose }: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChoose: (next: T) => void }) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-3 gap-2">
      {options.map(([id, text]) => (
        <Button key={id} variant={id === value ? 'primary' : 'secondary'} aria-pressed={id === value} onClick={() => (id === value ? undefined : onChoose(id))}>
          {text}
        </Button>
      ))}
    </div>
  );
}

export default function AccountSettings() {
  const { t } = useCloudText();
  const { lang, setLang } = useLanguage();
  const { preference } = useTheme();
  const { mainSite } = useCloud();
  return (
    <div className="space-y-5">
      <SubPageHeader title={t(settingsText.title)} subtitle={t(settingsText.subtitle)} />
      <section aria-labelledby="cloud-settings-language" className="lv-surface space-y-3 p-4">
        <h2 id="cloud-settings-language" className="text-[17px] font-bold text-text-primary">
          {t(settingsText.language)}
        </h2>
        <Choices label={t(settingsText.language)} value={lang} options={LANGUAGES} onChoose={(next) => setLang(next)} />
      </section>
      <section aria-labelledby="cloud-settings-appearance" className="lv-surface space-y-3 p-4">
        <h2 id="cloud-settings-appearance" className="text-[17px] font-bold text-text-primary">
          {t(settingsText.appearance)}
        </h2>
        <Choices
          label={t(settingsText.appearance)}
          value={preference}
          options={THEMES.map(([id, word]) => [id, t(word)] as const)}
          onChoose={(next) => setThemePreference(next, { origin: 'center', duration: CENTER_REVEAL_MS })}
        />
      </section>
      <section aria-labelledby="cloud-settings-account" className="lv-surface space-y-3 p-4">
        <h2 id="cloud-settings-account" className="flex items-center gap-2 text-[17px] font-bold text-text-primary">
          <User aria-hidden="true" className="h-5 w-5 text-text-secondary" />
          {t(settingsText.account)}
        </h2>
        <p className="text-[13px] leading-relaxed text-text-muted">{t(settingsText.accountBody)}</p>
        {mainSite ? (
          <div className="flex flex-wrap gap-2">
            <a href={`${mainSite}/edit-profile`} className="lv-button lv-button-secondary lv-button-sm">
              {t(account.editProfile)}
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
            </a>
            <a href={`${mainSite}/settings`} className="lv-button lv-button-secondary lv-button-sm">
              {t(settingsText.openSettings)}
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
            </a>
          </div>
        ) : null}
      </section>
    </div>
  );
}
