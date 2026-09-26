import React, { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { copyText } from '../../lib/copyText';
import { prefersAppScheme, telegramOpenLinks } from '../../lib/telegramDeepLink';
import './authLeave.css';

/**
 * «فتح البوت في تيليغرام» — and what to do when it does not open.
 *
 * «عند الضغط على start او start boot لا يفتح ولا يضغط الزر، هذا في الايفون»
 *
 * Before: one `<a href="https://t.me/bot?start=…" target="_blank">`. On an
 * iPhone that opened t.me's web page in a new tab (or inside Instagram's
 * WebView) whose «START BOT» button is a tg:// hop the WebView swallows —
 * nothing happens. Now, from the same server link (lib/telegramDeepLink.ts):
 *  - on phones the button IS the app link, `tg://resolve?domain=…&start=…`,
 *    a plain anchor in the same tab (a direct user gesture, no window.open,
 *    no await in between), so iOS hands it straight to Telegram;
 *  - a visible «افتح عبر t.me» fallback for when tg:// is refused;
 *  - the `/start <code>` command, copyable, for a chat that shows no START
 *    button — the bot accepts it pasted as a message (worker handleText).
 * On desktop the https link stays primary (Telegram Desktop may be absent).
 */

const AR = {
  open: 'فتح البوت في تيليغرام',
  notOpened: 'لم يفتح تيليغرام؟',
  openWeb: 'افتح عبر t.me',
  openApp: 'افتح في تطبيق تيليغرام',
  noStart: 'إن لم يظهر زر «ابدأ» (Start) في المحادثة، انسخ هذا الأمر وأرسله إلى البوت كرسالة:',
  copy: 'نسخ',
  copied: 'تم النسخ',
  copyFailed: 'انسخ الأمر يدويًا من الحقل',
  commandLabel: 'أمر البدء لإرساله إلى البوت',
};
const EN: typeof AR = {
  open: 'Open the bot in Telegram',
  notOpened: "Telegram didn't open?",
  openWeb: 'Open via t.me',
  openApp: 'Open in the Telegram app',
  noStart: "If the chat shows no Start button, copy this command and send it to the bot as a message:",
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Copy the command from the field by hand',
  commandLabel: 'Start command to send to the bot',
};

export default function TelegramOpen({ deepLink, children }: { deepLink: string; children?: React.ReactNode }) {
  const { lang } = useLanguage();
  // OWNER: Sorani to be written by hand. (ckb reads the Arabic until then.)
  const s = lang === 'en' ? EN : AR;
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');
  const links = telegramOpenLinks(deepLink);
  const mobile =
    typeof navigator !== 'undefined' && prefersAppScheme(navigator.userAgent, navigator.maxTouchPoints || 0);

  if (!links) {
    // A link this page cannot parse is still the server's link — offer it as is.
    return (
      <div className="lv-tgopen">
        <a href={deepLink} className="lv-btn-quiet">
          <ExternalLink aria-hidden /> {s.open}
        </a>
        {children}
      </div>
    );
  }

  const onCopy = async () => {
    const ok = await copyText(links.command);
    setCopyState(ok ? 'done' : 'failed');
    if (ok) window.setTimeout(() => setCopyState('idle'), 2500);
  };

  // Same tab on phones: a custom scheme never unloads the page, and an https
  // universal link that falls through to t.me comes back with the Back button
  // (pageshow re-polls). New tab on desktop so the flow stays on screen.
  const webTarget = mobile ? undefined : '_blank';

  return (
    <div className="lv-tgopen">
      <a
        href={mobile ? links.app : links.web}
        target={webTarget}
        rel={webTarget ? 'noopener noreferrer' : undefined}
        className="lv-btn-quiet"
        data-testid="tg-open"
      >
        <ExternalLink aria-hidden /> {s.open}
      </a>

      {/* What to do next and the live status sit right under the button; the
          fallbacks come after — they are for when the first way did not work. */}
      {children}

      <div className="lv-tgopen__fallback">
        <p className="lv-tgopen__label">{s.notOpened}</p>
        <div className="lv-tgopen__links">
          <a href={mobile ? links.web : links.app} data-testid="tg-open-alt">
            {mobile ? s.openWeb : s.openApp}
          </a>
        </div>
        <p className="lv-tgopen__label" style={{ marginTop: 8 }}>
          {s.noStart}
        </p>
        <div className="lv-copyrow">
          <input
            className="lv-copyrow__value"
            readOnly
            value={links.command}
            aria-label={s.commandLabel}
            onFocus={(e) => e.currentTarget.select()}
            translate="no"
            data-testid="tg-command"
          />
          <button type="button" className={`lv-copyrow__btn${copyState === 'done' ? ' is-done' : ''}`} onClick={onCopy}>
            {copyState === 'done' ? <Check aria-hidden /> : <Copy aria-hidden />}
            <span>{copyState === 'done' ? s.copied : s.copy}</span>
          </button>
        </div>
        <div className="lv-tgopen__links">
          <a href={links.chat} target={webTarget} rel="noopener noreferrer" dir="ltr" translate="no">
            @{links.bot}
          </a>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {copyState === 'done' ? s.copied : copyState === 'failed' ? s.copyFailed : ''}
        </p>
      </div>
    </div>
  );
}
