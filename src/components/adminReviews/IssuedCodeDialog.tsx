/**
 * THE ONE-TIME GIFT CODE (brief §4, docs/REVIEWS_GIFTS.md §8 C2).
 *
 * The issue and re-issue answers are the only place the raw six digits ever
 * exist, and this window is the only place they are shown:
 *
 *  - it cannot be dismissed by accident: no Escape, no scrim — only its own
 *    button closes it, and closing before «نسخ الكود» asks first;
 *  - «نسخ الكود» copies exactly the six digits (`copyText`, with the WebView
 *    fallback); when the clipboard refuses, the digits are SELECTED so the
 *    admin can copy them by hand, and no success tick is drawn;
 *  - the code lives in the caller's state only while the window is open. The
 *    caller clears it on close, and no API ever returns it again — the row then
 *    offers only «إلغاء وإصدار كود جديد». It is never logged, toasted, put in a
 *    URL, an attribute or storage.
 */
import React, { useId, useRef, useState } from 'react';
import { Check, CheckCircle2, Copy, KeyRound } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { Overlay } from '../ui/Overlay';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { copyText } from '../../lib/copyText';
import { formatDateTime } from '../orders/format';
import { codeHalves, fill } from './model';
import { adminStrings } from './strings';

export interface IssuedCode {
  code: string;
  customer: string;
  level: number | null;
  issuedAt: string | null;
  issuedBy: string;
}

export type CopyState = 'idle' | 'copied' | 'failed';

/**
 * The window's content — rendered on its own by the tests (the Overlay
 * portals, which a static render cannot follow).
 */
export function IssuedCodeBody({
  issued,
  lang,
  titleId,
  descId,
  initialCopy = 'idle',
  onDone,
}: {
  issued: IssuedCode;
  lang: string;
  titleId: string;
  descId: string;
  initialCopy?: CopyState;
  /** Called with whether the code was copied; the caller asks before losing an uncopied code. */
  onDone: (copied: boolean) => void;
}) {
  const S = adminStrings(lang);
  const [copy, setCopy] = useState<CopyState>(initialCopy);
  const digitsRef = useRef<HTMLParagraphElement | null>(null);
  const [first, second] = codeHalves(issued.code);

  const doCopy = async () => {
    const ok = await copyText(issued.code);
    if (ok) {
      setCopy('copied');
      return;
    }
    // Select the digits so they can be taken by hand; never claim a copy.
    const el = digitsRef.current;
    if (el && typeof window !== 'undefined' && window.getSelection) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    setCopy('failed');
  };

  return (
    <div className="p-5" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }} data-issued-code-body>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle2 className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 id={titleId} className="text-[17px] font-bold leading-snug text-text-primary">
            {S.code.title}
          </h2>
          <p className="mt-0.5 text-[13px] text-text-secondary">
            {fill(S.code.facts, { customer: issued.customer || '—', level: issued.level ?? '—' })}
          </p>
        </div>
      </div>

      <p id={descId} className="lv-alert lv-alert-warning mt-4 text-[13px] leading-relaxed text-text-primary">
        {S.code.once}
      </p>

      <div className="mt-4 rounded-2xl border border-border-subtle bg-surface px-3 py-4 text-center">
        <p className="mb-1 flex items-center justify-center gap-1.5 text-[12px] font-semibold text-text-muted">
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
          {S.code.label}
        </p>
        <p
          ref={digitsRef}
          dir="ltr"
          className="font-mono text-4xl font-black tabular-nums tracking-[0.3em] select-all text-text-primary"
          data-gift-code-digits
        >
          <span>{first}</span>
          <span style={{ marginInlineStart: '0.45em' }}>{second}</span>
        </p>
      </div>

      <div className="mt-4" aria-live="polite">
        <Button
          variant={copy === 'copied' ? 'secondary' : 'primary'}
          block
          icon={copy === 'copied' ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          onClick={doCopy}
          data-copy-code
        >
          {copy === 'copied' ? S.code.copied : S.code.copy}
        </Button>
        {copy === 'failed' && (
          <p role="alert" className="mt-2 text-[13px] leading-relaxed text-danger">
            {S.code.copyFailed}
          </p>
        )}
      </div>

      {(issued.issuedAt || issued.issuedBy) && (
        <p className="mt-3 text-[12px] text-text-muted">
          {fill(S.entitlement.issuedAt, { date: formatDateTime(issued.issuedAt, lang) || '—', who: issued.issuedBy || '—' })}
        </p>
      )}
      <p className="mt-1 text-[12px] text-text-muted">{S.entitlement.codeHidden}</p>

      <div className="mt-4">
        <Button variant="secondary" block onClick={() => onDone(copy === 'copied')} data-code-done>
          {S.code.done}
        </Button>
      </div>
    </div>
  );
}

export default function IssuedCodeDialog({ issued, onClose }: { issued: IssuedCode | null; onClose: () => void }) {
  const { lang } = useLanguage();
  const S = adminStrings(lang);
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const [confirm, confirmDialog] = useConfirm();

  const done = async (copied: boolean) => {
    if (!copied) {
      const ok = await confirm({
        title: S.code.closeTitle,
        consequence: S.code.closeBody,
        confirmLabel: S.code.closeAnyway,
        cancelLabel: S.back,
        destructive: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  return (
    <>
      <Overlay
        open={!!issued}
        // Only the window's own button closes it (see `done`).
        onClose={() => undefined}
        alert
        labelledBy={titleId}
        describedBy={descId}
        placement="bottom"
        dismissOnEscape={false}
        dismissOnScrim={false}
        panelClassName="w-full sm:max-w-md"
        testId="issued-code-dialog"
      >
        {() =>
          issued ? (
            <IssuedCodeBody key={issued.code + (issued.issuedAt ?? '')} issued={issued} lang={lang} titleId={titleId} descId={descId} onDone={done} />
          ) : null
        }
      </Overlay>
      {confirmDialog}
    </>
  );
}
