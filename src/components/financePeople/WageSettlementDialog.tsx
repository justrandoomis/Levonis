/**
 * «تسوية الأجور» — THE OWNER'S WAGE SETTLEMENT (DECISIONS row 306).
 *
 * One agreed amount still owed for every order an employee earned on before a
 * day: the owner chooses the day the new period starts (today at most, after
 * any earlier settlement), the agreed amount and a reason; previews what moves
 * (earned / paid / owed before → agreed, the change, each order's wage, and the
 * investors whose goods those orders sold — a cut raises their profit); then
 * applies it with the preview's `owed_before_iqd` and one operation id. Each
 * refusal the server gives by code is said here in the reader's language, with
 * what to do (wageSettlement.ts, WageSettlementView.tsx).
 */
import { useRef, useState } from 'react';
import { NumberInput } from '../ui/NumberInput';
import { Button, Dialog, Feedback, Field, Input, Money, useLanguage, useMutation } from './shared';
import { personFinanceStrings, type SettleRefusalKey } from '../../lib/personFinanceStrings';
import { applySettlement, baghdadToday, dayText, lastSettledDay, previewSettlement, settlementDays, settlementProblem, settlementRefusal, type LastSettlement, type SettlementDone, type SettlementPreview } from './wageSettlement';
import { SettlementPreviewView, SettlementRefusalBox } from './WageSettlementView';

export default function WageSettlementDialog({ staff, last, onClose, onDone }: { staff: { id: string; name: string }; last: LastSettlement | null; onClose: () => void; onDone: (done: SettlementDone) => void }) {
  const { lang } = useLanguage(), s = personFinanceStrings(lang), t = s.settle, op = useMutation();
  const [today] = useState(baghdadToday);
  const days = settlementDays(today, last);
  const [day, setDay] = useState(days.open ? today : '');
  const [owed, setOwed] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [refusal, setRefusal] = useState<SettleRefusalKey | null>(null);
  // One id per preview: a retried apply of THIS preview (a timeout after the write) returns the settlement it made.
  const operation = useRef('');
  const problem = days.open ? settlementProblem({ through_day: day, owed_iqd: owed, reason }, days) : 'settled';
  const edited = () => { setRefusal(null); op.clear(); };
  /** A coded refusal is said in the reader's language; anything else keeps the server's words (op.error). */
  const refused = (error: unknown) => { const kind = settlementRefusal(error); if (!kind) throw error; setRefusal(kind); };
  const inspect = () => op.run(async () => {
    if (problem || owed === null) return;
    setRefusal(null);
    try {
      const next = await previewSettlement(staff.id, { through_day: day, owed_iqd: owed, reason });
      operation.current = crypto.randomUUID();
      setPreview(next);
    } catch (error) { setPreview(null); refused(error); }
  });
  const apply = () => op.run(async () => {
    if (!preview) return;
    setRefusal(null);
    try { onDone(await applySettlement(staff.id, preview, reason, operation.current)); } catch (error) { refused(error); }
  });
  const back = () => { setPreview(null); edited(); };
  const dayError = problem === 'future' ? t.refusalAction.future : problem === 'settled' && days.open ? t.refusalAction.settled : undefined;
  // The day the new period starts is exclusive: name the last day it settles, so it is not read one day off.
  const dayOk = !problem || problem === 'amount' || problem === 'reason';
  return <Dialog open title={t.title} onClose={onClose} dirty={owed !== null || !!reason.trim()} busy={op.busy}>
    <p className="fp-muted">{staff.name}</p>
    <ol className="fp-steps">{[t.stepAgree, t.stepReview].map((label, i) => <li key={label} aria-current={(preview ? 1 : 0) === i ? 'step' : undefined} data-done={!!preview && i === 0}>{i + 1}. {label}</li>)}</ol>
    {preview ? <SettlementPreviewView preview={preview} s={s} lang={lang} /> : <div className="fp-stack">
      {days.open && <p className="fp-note">{t.intro}</p>}
      {last && <p className="fp-row-meta">{s.settledThrough} {dayText(lastSettledDay(last.through_day), lang)} · {s.agreedOwed} <Money value={last.owed_iqd} /></p>}
      {!days.open ? <p className="fp-note" role="status">{t.settledToday}</p> : <>
        <Field label={t.dayLabel} required error={dayError} hint={<>{dayOk && <strong>{t.ordersThrough} {dayText(lastSettledDay(day), lang)}. </strong>}{t.dayHint}</>}>
          <Input type="date" value={day} min={days.min ?? undefined} max={days.max} dir="ltr" onChange={(event) => { setDay(event.target.value); edited(); }} />
        </Field>
        <Field label={t.owedLabel} required hint={t.owedHint}><NumberInput kind="money" value={owed} min={0} onValueChange={(n, valid) => { setOwed(valid ? n : null); edited(); }} /></Field>
        <Field label={t.reasonLabel} required error={reason.trim() && problem === 'reason' ? t.reasonShort : undefined}>
          <Input value={reason} maxLength={300} placeholder={t.reasonPlaceholder} onChange={(event) => { setReason(event.target.value); edited(); }} />
        </Field>
      </>}
    </div>}
    {refusal && <div className="fp-stack mt-3"><SettlementRefusalBox kind={refusal} s={s} lang={lang} last={last} />
      {preview && <div className="fp-row-actions"><Button size="sm" loading={op.busy} onClick={inspect}>{t.again}</Button></div>}</div>}
    <Feedback error={op.error} />
    <footer className="fp-footer">
      <Button variant="ghost" disabled={op.busy} onClick={preview ? back : onClose}>{preview ? t.back : t.cancel}</Button>
      {preview ? <Button variant="primary" loading={op.busy} disabled={!!refusal} onClick={apply}>{t.apply}</Button>
        : days.open && <Button variant="primary" loading={op.busy} disabled={!!problem} onClick={inspect}>{t.preview}</Button>}
    </footer>
  </Dialog>;
}
