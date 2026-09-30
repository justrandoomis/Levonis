/**
 * ONE DECISION, ASKED ONCE — the desk's form for every write it makes
 * (docs/COMMUNITY_ECOSYSTEM.md §9.6): a ladder step on an account, hiding or
 * showing a post or a comment, deciding a report, answering an appeal.
 *
 * WHAT IT ASKS. The consequence in one sentence above the field (what will
 * happen, not how), the REASON — required wherever the person will be told
 * why (≥ 3 characters, the server's own bound; optional for a restore, a
 * report note, an appeal's answer) — and, for a restriction or a suspension,
 * when it ENDS: none, a day, a week, a month, or a date (the server refuses a
 * past date or one more than five years out: MODERATION_UNTIL_INVALID).
 *
 * A SANCTION IS CONFIRMED. A ladder step passes through `ConfirmDialog` after
 * the form — the title names the account («حظر حساب سارة؟»), the button is the
 * verb itself, drawn destructive for a suspension or a ban, focus on cancel.
 * The sheet does not act on its own: `onSubmit` is the caller's request, and a
 * refusal it throws (worded by src/lib/refusalStrings.ts) stays in the sheet
 * with the typed reason kept.
 */
import { useEffect, useId, useState } from 'react';
import { Button } from '../../ui/Button';
import { useConfirm, type ConfirmOptions } from '../../ui/ConfirmDialog';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Sheet } from '../../ui/Sheet';
import { MODERATION_REASON_MAX } from './api';
import { useDeskStrings, type DeskStrings } from './strings';

export type UntilPreset = 'none' | 'd1' | 'd7' | 'd30' | 'custom';
/** The ends the desk offers, in the order the pop-up lists them. */
export const UNTIL_PRESETS: readonly UntilPreset[] = ['none', 'd1', 'd7', 'd30', 'custom'];

export interface DecisionRequest {
  /** The sheet's title: what is being decided, about whom. */
  title: string;
  /** What will happen, in one sentence. */
  consequence: string;
  /** The verb on the button. */
  confirmLabel: string;
  destructive?: boolean;
  /** `required`: the person is told why (≥ 3 characters); `optional`: a note. */
  reason: 'required' | 'optional';
  reasonLabel?: string;
  maxLength?: number;
  /** A restriction or a suspension may end. */
  until?: boolean;
  /** A sanction: asked once more, in a ConfirmDialog, after the form. */
  confirm?: { title: string; consequence: string };
  onSubmit: (input: { reason: string; until: string | null }) => Promise<void>;
}

const DAY_MS = 86_400_000;

/** The end a preset (or a picked day, at its last minute, local time) names — ISO 8601, or null for none. */
export function untilFrom(preset: UntilPreset, date: string, now = Date.now()): string | null {
  if (preset === 'none') return null;
  if (preset === 'custom') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const at = new Date(`${date}T23:59:00`);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  }
  const days = preset === 'd1' ? 1 : preset === 'd7' ? 7 : 30;
  return new Date(now + days * DAY_MS).toISOString();
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type DecisionOutcome =
  | { kind: 'invalid'; field: 'reason' | 'until'; error: string }
  | { kind: 'cancelled' }
  | { kind: 'done' }
  | { kind: 'refused'; error: string };

/**
 * THE ORDER OF A DECISION, as one testable step: the reason checked first
 * (nothing is asked of a form the server would refuse), then — for a
 * sanction — the ConfirmDialog, and only on «yes» the caller's request; a
 * refusal it throws comes back as the sentence to show in the sheet.
 */
export async function runDecision(
  request: DecisionRequest,
  form: { reason: string; preset: UntilPreset; date: string },
  ask: (options: ConfirmOptions) => Promise<boolean>,
  s: Pick<DeskStrings, 'reasonRequired' | 'untilRequired' | 'failed'>,
  start: () => void = () => {},
  now = Date.now()
): Promise<DecisionOutcome> {
  const text = form.reason.trim();
  if (request.reason === 'required' && text.length < 3) return { kind: 'invalid', field: 'reason', error: s.reasonRequired };
  const until = request.until ? untilFrom(form.preset, form.date, now) : null;
  // «تاريخ» with no day picked is a question unanswered — never a sanction without an end.
  if (request.until && form.preset === 'custom' && !until) return { kind: 'invalid', field: 'until', error: s.untilRequired };
  if (request.confirm) {
    const ok = await ask({
      title: request.confirm.title,
      consequence: request.confirm.consequence,
      confirmLabel: request.confirmLabel,
      destructive: !!request.destructive,
    });
    if (!ok) return { kind: 'cancelled' };
  }
  start();
  try {
    await request.onSubmit({ reason: text, until });
    return { kind: 'done' };
  } catch (e) {
    return { kind: 'refused', error: e instanceof Error && e.message ? e.message : s.failed };
  }
}

export default function DecisionSheet({ request, onClose }: { request: DecisionRequest | null; onClose: () => void }) {
  const s = useDeskStrings();
  const [confirm, confirmDialog] = useConfirm();
  const [reason, setReason] = useState('');
  const [preset, setPreset] = useState<UntilPreset>('none');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  // A new question starts empty.
  useEffect(() => {
    setReason('');
    setPreset('none');
    setDate('');
    setError(null);
    setDateError(null);
    setBusy(false);
  }, [request]);

  const submit = async () => {
    if (!request || busy) return;
    const out = await runDecision(request, { reason, preset, date }, confirm, s, () => {
      // The request is on its way: nothing in the sheet can be pressed twice.
      setBusy(true);
      setError(null);
    });
    if (out.kind === 'invalid') (out.field === 'until' ? setDateError : setError)(out.error);
    else if (out.kind === 'done') onClose();
    else if (out.kind === 'refused') {
      setError(out.error);
      setBusy(false);
    }
  };

  const max = request?.maxLength ?? MODERATION_REASON_MAX;
  return (
    <>
      <Sheet
        open={!!request}
        onClose={() => !busy && onClose()}
        labelledBy={titleId}
        detents={['medium', 'large']}
        defaultDetent="large"
        dragHandle
        dirty={reason.trim().length > 0}
        testId="moderation-decision"
        header={
          <h2 id={titleId} className="px-4 pb-2 pt-1 text-[16px] font-bold leading-snug text-text-primary">
            {request?.title}
          </h2>
        }
        footer={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy} className="flex-1">
              {s.cancel}
            </Button>
            <Button
              variant={request?.destructive && !request?.confirm ? 'danger' : 'primary'}
              onClick={submit}
              loading={busy}
              className="flex-1"
              data-decision-submit
            >
              {request?.confirm ? s.continue : request?.confirmLabel}
            </Button>
          </div>
        }
      >
        {request && (
          <div className="flex flex-col gap-4 px-4 pb-4" data-decision-form>
            <p className="text-[13px] leading-relaxed text-text-secondary">{request.consequence}</p>
            <Field
              label={request.reasonLabel ?? (request.reason === 'required' ? s.reasonLabel : s.noteLabel)}
              optional={request.reason === 'optional'}
              required={request.reason === 'required'}
              error={error}
            >
              <Textarea
                value={reason}
                rows={3}
                maxLength={max}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (error) setError(null);
                }}
                dir="auto"
                data-decision-reason
              />
            </Field>
            {request.until && (
              <div className="flex flex-col gap-3" data-decision-until>
                {/* A pop-up, not a segmented row: five choices whose names run
                    long in English and Sorani are never cut, and a phone
                    answers with its own picker. */}
                <Field label={s.untilLabel}>
                  <Select
                    value={preset}
                    onChange={(e) => {
                      setPreset(e.target.value as UntilPreset);
                      setDateError(null);
                    }}
                    data-until-preset
                  >
                    {UNTIL_PRESETS.map((id) => (
                      <option key={id} value={id}>
                        {s.untilPresets[id]}
                      </option>
                    ))}
                  </Select>
                </Field>
                {preset === 'custom' && (
                  <Field label={s.untilDate} error={dateError}>
                    <Input
                      ltr
                      type="date"
                      value={date}
                      min={isoDay(Date.now() + DAY_MS)}
                      max={isoDay(Date.now() + 5 * 365 * DAY_MS)}
                      onChange={(e) => {
                        setDate(e.target.value);
                        setDateError(null);
                      }}
                      data-decision-date
                    />
                  </Field>
                )}
              </div>
            )}
          </div>
        )}
      </Sheet>
      {confirmDialog}
    </>
  );
}
