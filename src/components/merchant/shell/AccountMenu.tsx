/**
 * THE ACCOUNT MENU — the person behind the store, not the store: the language
 * the workspace speaks, their account, help, and signing out. The workspace
 * is full-screen (outside the site header that carries the language sheet),
 * so without this a merchant had no way to change language or sign out short
 * of leaving the workspace.
 *
 * TWO PLACES, ONE SET OF ACTIONS (`useAccountActions`): on a wider screen a
 * round button at the end of the top bar opens the shared `Menu`; on a phone,
 * where the top bar has no room, the same choices close the «More» sheet
 * (`AccountPanel`). Its own lazy chunk — the frame carries only the place it
 * sits in (tests/bundleBudget.test.ts).
 *
 * THE LANGUAGE applies at once (`setLang`, kept by this browser), and
 * `setLang` itself writes it to the profile for a signed-in person, quietly
 * and best effort (`persistLocale`), so the next sign-in on another device
 * opens in it — one write per choice, never a second one from here. On the
 * phone the three languages are plain buttons, not a radiogroup: a
 * radiogroup selects as the arrows move, and each step here would switch the
 * whole workspace's language and direction (and so which way the next arrow
 * goes). Account and help are platform pages: from a store's own address
 * they are another site, so `resolveLink` decides between a route and a page
 * load.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, CircleUserRound, LifeBuoy, LogOut, UserRound } from 'lucide-react';
import { useOptionalAuth } from '../../../AuthContext';
import { useLanguage } from '../../../LanguageContext';
import type { Language } from '../../../translations';
import { IconButton } from '../../ui/Button';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { useWorkspace } from './context';
import { say } from './strings';
import { ACCOUNT_WORDS as W } from './accountWords';

/** Each language in its own name — what a reader scans a list of languages for. */
export const LANGUAGES: ReadonlyArray<readonly [Language, string]> = [
  ['ar', 'العربية'],
  ['en', 'English'],
  ['ckb', 'کوردی'],
];

/** The platform's own pages this menu opens. */
export const ACCOUNT_PATH = '/settings';
export const HELP_PATH = '/support';
/** Where signing out lands — the sign-in page, as Settings and the admin shell do. */
export const SIGNED_OUT_PATH = '/auth';

export function useAccountActions() {
  const { lang, setLang } = useLanguage();
  const auth = useOptionalAuth();
  const { go, resolveLink } = useWorkspace();
  const chooseLanguage = (next: Language) => {
    if (next === lang) return;
    setLang(next);
  };
  const signOut = async () => {
    try {
      await auth?.logout();
    } catch {
      // `logout` drops the session on this device whatever the server said.
    }
    go(SIGNED_OUT_PATH);
  };
  return { lang, chooseLanguage, signOut, go, resolveLink };
}

/** The top bar's account button and its menu (sm and up). */
export default function AccountMenu() {
  const { loc } = useLanguage();
  const a = useAccountActions();
  const page = (path: string) => {
    const t = a.resolveLink(path);
    // A route is a real link (new tab works); another site is a page load.
    return t.internal ? { href: t.to } : { onSelect: () => a.go(path) };
  };
  const icon = 'h-4 w-4';
  const items: MenuEntry[] = [
    ...LANGUAGES.map(
      ([code, name]): MenuEntry => ({
        id: `lang-${code}`,
        label: name,
        icon: code === a.lang ? <Check className={icon} /> : <span className={`block ${icon}`} />,
        hint: code === a.lang ? say(loc, W.currentLanguage) : undefined,
        onSelect: () => a.chooseLanguage(code),
      })
    ),
    { id: 'sep-language', separator: true },
    { id: 'account', label: say(loc, W.account), icon: <UserRound className={icon} />, ...page(ACCOUNT_PATH) },
    { id: 'help', label: say(loc, W.help), icon: <LifeBuoy className={icon} />, ...page(HELP_PATH) },
    { id: 'sep-out', separator: true },
    { id: 'sign-out', label: say(loc, W.signOut), icon: <LogOut className={`${icon} rtl:-scale-x-100`} />, destructive: true, onSelect: () => void a.signOut() },
  ];
  return (
    <Menu
      label={say(loc, W.you)}
      items={items}
      align="end"
      trigger={(props) => <IconButton {...props} label={say(loc, W.you)} icon={<CircleUserRound className="h-5 w-5" />} data-account-menu />}
    />
  );
}

const ROW =
  'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-start text-[14.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

/** The same choices at the foot of the phone's «More» sheet. `onDone` closes the sheet. */
export function AccountPanel({ onDone }: { onDone: () => void }) {
  const { loc } = useLanguage();
  const a = useAccountActions();
  const title = say(loc, W.you);
  const pageRow = (path: string, label: string, glyph: ReactNode) => {
    const t = a.resolveLink(path);
    const body = (
      <>
        {glyph}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </>
    );
    return t.internal ? (
      <Link to={t.to} onClick={onDone} className={`${ROW} text-text-secondary`}>
        {body}
      </Link>
    ) : (
      <a href={t.to} onClick={onDone} className={`${ROW} text-text-secondary`}>
        {body}
      </a>
    );
  };
  const glyph = 'h-5 w-5 shrink-0 text-text-muted';
  return (
    <section aria-label={title} className="border-t border-border-subtle px-2 pb-4 pt-2" data-account-panel>
      <p className="px-3 pb-2 pt-2 text-[12px] font-medium text-text-muted">{title}</p>
      <div role="group" aria-label={say(loc, W.language)} className="mx-3 mb-2 grid grid-cols-3 gap-1 rounded-full border border-border-subtle p-1 lv-well">
        {LANGUAGES.map(([code, name]) => {
          const on = code === a.lang;
          return (
            <button
              key={code}
              type="button"
              lang={code}
              aria-pressed={on}
              onClick={() => a.chooseLanguage(code)}
              data-ws-language={code}
              className={`min-h-11 min-w-0 truncate rounded-full px-2 text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                on ? 'border border-border-subtle bg-surface-raised text-text-primary shadow-1' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {name}
            </button>
          );
        })}
      </div>
      <ul>
        <li>{pageRow(ACCOUNT_PATH, say(loc, W.account), <UserRound aria-hidden="true" className={glyph} />)}</li>
        <li>{pageRow(HELP_PATH, say(loc, W.help), <LifeBuoy aria-hidden="true" className={glyph} />)}</li>
        <li>
          <button
            type="button"
            onClick={() => {
              onDone();
              void a.signOut();
            }}
            className={`${ROW} text-danger`}
            data-sign-out
          >
            <LogOut aria-hidden="true" className="h-5 w-5 shrink-0 rtl:-scale-x-100" />
            <span className="min-w-0 flex-1 truncate">{say(loc, W.signOut)}</span>
          </button>
        </li>
      </ul>
    </section>
  );
}
