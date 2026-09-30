/**
 * «إبلاغ» — one sheet for every target (a post, a comment, a person, a store,
 * a product, a request): pick a reason, say more if you like, send.
 *
 * The server keeps ONE report per (reporter, target) and answers a second
 * send with `replayed: true`; the sheet says «سبق أن أبلغت» instead of
 * pretending a new one went through. A guest is sent to sign in first.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '../../../AuthContext';
import { useLanguage } from '../../../LanguageContext';
import { useSignInPrompt } from '../../../lib/guest';
import { apiRefusal } from '../../../lib/refusalStrings';
import { Button } from '../../ui/Button';
import { Field, Textarea } from '../../ui/Field';
import { Sheet } from '../../ui/Sheet';
import { toast } from '../../ui/Toast';
import { REPORT_REASONS, socialApi, type ReportReason, type ReportTarget } from './api';
import { socialLang, useSocialStrings } from './strings';

export interface ReportSheetProps {
  open: boolean;
  onClose: () => void;
  target: { type: ReportTarget; id: string };
}

export default function ReportSheet({ open, onClose, target }: ReportSheetProps) {
  const s = useSocialStrings();
  const { lang } = useLanguage();
  const { isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Every opening is a fresh form.
  useEffect(() => {
    if (open) {
      setReason(null);
      setDetails('');
      setError(null);
    }
  }, [open, target.id]);

  const send = async () => {
    if (!isAuthenticated) return signIn();
    if (!reason) return;
    setError(null);
    try {
      const r = await socialApi.report({ target_type: target.type, target_id: target.id, reason, details: details.trim() || undefined });
      if (r.replayed) toast.info(s.reportedBefore);
      else toast.success(s.reportSent);
      onClose();
    } catch (e) {
      setError(apiRefusal(e, socialLang(lang), s.actionFailed));
    }
  };

  const dirty = !!reason || details.trim().length > 0;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={s.reportTitle}
      detents={['medium', 'large']}
      dragHandle
      dirty={dirty}
      testId="report-sheet"
      header={
        <h2 className="px-4 pb-2 pt-1 text-[16px] font-bold text-text-primary" data-report-title>
          {s.reportTitle}
        </h2>
      }
      footer={
        <Button variant="primary" block onClick={send} disabled={!reason} data-report-send>
          {s.send}
        </Button>
      }
    >
      <div className="flex flex-col gap-4 px-4 pb-4">
        <fieldset className="min-w-0">
          <legend id="report-why" className="mb-2 text-[13px] font-semibold text-text-secondary">
            {s.reportWhy}
          </legend>
          {/* ONE reason: a radio group, not seven independent toggles — picking
              one silently unpresses the others, which `aria-pressed` cannot
              say. `.lv-choice` already styles `[aria-checked='true']`. Roving
              tabindex: the chosen chip (or the first) is the group's tab stop,
              the arrows move within it. */}
          <div
            role="radiogroup"
            aria-labelledby="report-why"
            className="flex flex-wrap gap-2"
            onKeyDown={(e) => {
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const at = reason ? REPORT_REASONS.indexOf(reason) : -1;
              const next = REPORT_REASONS[(at + step + REPORT_REASONS.length) % REPORT_REASONS.length];
              setReason(next);
              (e.currentTarget.querySelector(`[data-report-reason="${next}"]`) as HTMLElement | null)?.focus();
            }}
          >
            {REPORT_REASONS.map((r, i) => (
              <button
                key={r}
                type="button"
                role="radio"
                onClick={() => setReason(r)}
                aria-checked={reason === r}
                tabIndex={reason === r || (!reason && i === 0) ? 0 : -1}
                data-report-reason={r}
                className="lv-choice inline-flex items-center px-3.5 text-[13px] font-medium"
              >
                {s.reportReasons[r]}
              </button>
            ))}
          </div>
        </fieldset>
        <Field label={s.reportDetails} optional error={error}>
          <Textarea value={details} rows={3} maxLength={1000} placeholder={s.reportDetailsPh} onChange={(e) => setDetails(e.target.value)} dir="auto" />
        </Field>
      </div>
    </Sheet>
  );
}
