/**
 * «الاعتراض على القرار» — ONE APPEAL PER DECISION (docs/COMMUNITY_ECOSYSTEM.md
 * §9.6; `POST /api/moderation/appeals`, worker/routes/adminModeration.ts).
 *
 * The sheet names the decision it contests (what was decided, the reason the
 * desk wrote, the day), asks for the person's words (3 to 1000 characters,
 * counted as they type), and sends them once. The server keeps one appeal per
 * decision per person — a second is 409 APPEAL_EXISTS, said in the refusal
 * table's words, and the page is told so it can show the appeal already on
 * file. A decision that already carries an appeal opens on its STATE instead
 * of the form: «قيد المراجعة», «قُبل», «رُفض», with the desk's answer.
 *
 * A banned account keeps this door (worker/lib/userStatus.ts
 * `bannedMayWrite`). Sheet v2: the grabber and the header drag, the body
 * scrolls, the send button stays above the home indicator.
 */
import { useEffect, useId, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { Button } from '../../ui/Button';
import { Field, Textarea } from '../../ui/Field';
import { Sheet } from '../../ui/Sheet';
import { StatusChip } from '../../ui/Badge';
import { toast } from '../../ui/Toast';
import { APPEAL_BODY_MAX, moderationApi, type Appeal, type ModerationDecision } from './api';
import { appealTone, modDate, modLang, moderationStrings, type ModLang } from './strings';

export interface AppealSheetProps {
  open: boolean;
  onClose: () => void;
  decision: ModerationDecision | null;
  /** The appeal the server filed — the page shows its state in place of the door. */
  onFiled: (decisionId: string, appeal: Appeal) => void;
  /** The server already holds an appeal on this decision (APPEAL_EXISTS): read the page again. */
  onStale?: () => void;
}

export const APPEAL_MIN = 3;

/** What the sheet says about the decision it contests. */
export function DecisionSummary({ decision, lang }: { decision: ModerationDecision; lang: ModLang }) {
  const s = moderationStrings(lang);
  const date = modDate(decision.created_at, lang);
  const until = modDate(decision.until, lang);
  return (
    <div className="rounded-xl bg-surface-raised px-3.5 py-3" data-appeal-decision={decision.id}>
      <p className="text-[11.5px] font-semibold text-text-muted">{s.sheet.about}</p>
      <p className="mt-0.5 text-[13.5px] font-bold leading-snug text-text-primary" dir="auto">
        {s.decision(decision.action, decision.target_type, decision.target_label)}
      </p>
      {decision.reason && (
        <p className="mt-1 text-[12.5px] leading-relaxed text-text-secondary" dir="auto">
          {s.reason(decision.reason)}
        </p>
      )}
      <p className="mt-1 text-[11.5px] text-text-muted">
        {date && s.on(date)}
        {until && ` · ${s.until(until)}`}
      </p>
    </div>
  );
}

export default function AppealSheet({ open, onClose, decision, onFiled, onStale }: AppealSheetProps) {
  const { lang } = useLanguage();
  const l = modLang(lang);
  const s = moderationStrings(l);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  // Every opening is a fresh form.
  useEffect(() => {
    if (open) {
      setBody('');
      setError(null);
      setBusy(false);
    }
  }, [open, decision?.id]);

  const send = async () => {
    if (!decision || busy) return;
    const text = body.trim();
    if (text.length < APPEAL_MIN) {
      setError(s.sheet.tooShort);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const appeal = await moderationApi.appeal(decision.id, text);
      toast.success(s.sheet.sent);
      onFiled(decision.id, appeal);
      onClose();
    } catch (e) {
      // The refusal sentences load on the first refusal, as on every page that has few.
      const { apiRefusal } = await import('../../../lib/refusalStrings');
      setError(apiRefusal(e, l, s.sheet.failed));
      if (e instanceof ApiError && e.code === 'APPEAL_EXISTS') onStale?.();
    } finally {
      setBusy(false);
    }
  };

  const filed = decision?.appeal ?? null;
  return (
    <Sheet
      open={open && !!decision}
      onClose={() => !busy && onClose()}
      labelledBy={titleId}
      detents={['medium', 'large']}
      defaultDetent="large"
      dragHandle
      dirty={!filed && body.trim().length > 0}
      testId="appeal-sheet"
      header={
        <h2 id={titleId} className="px-4 pb-2 pt-1 text-[16px] font-bold text-text-primary">
          {s.sheet.title}
        </h2>
      }
      footer={
        filed ? undefined : (
          <Button variant="primary" block onClick={send} loading={busy} disabled={busy} data-appeal-send>
            {s.sheet.send}
          </Button>
        )
      }
    >
      {decision && (
        <div className="flex flex-col gap-4 px-4 pb-4">
          <DecisionSummary decision={decision} lang={l} />
          {filed ? (
            <div data-appeal-state={filed.state}>
              <StatusChip tone={appealTone(filed.state)}>{s.appealState[filed.state]}</StatusChip>
              {filed.decision && (
                <p className="mt-2 text-[13px] leading-relaxed text-text-secondary" dir="auto">
                  <span className="font-semibold text-text-primary">{s.deskAnswer}</span> {filed.decision}
                </p>
              )}
            </div>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed text-text-secondary">{s.sheet.intro}</p>
              <Field label={s.sheet.label} error={error} hint={s.sheet.counter(body.length, APPEAL_BODY_MAX)}>
                <Textarea
                  value={body}
                  rows={5}
                  maxLength={APPEAL_BODY_MAX}
                  placeholder={s.sheet.placeholder}
                  onChange={(e) => {
                    setBody(e.target.value);
                    if (error) setError(null);
                  }}
                  dir="auto"
                  data-appeal-body
                />
              </Field>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
