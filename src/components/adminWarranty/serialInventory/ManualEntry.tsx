/**
 * «إدخال يدوي» — one serial, or a pasted list, under one filing.
 *
 *  - ONE SERIAL: type it (with its box SN and EAN when at hand) and add. It
 *    goes through the camera's own door (POST /scan, recorded as `manual`):
 *    with no product chosen, the EAN or the model name typed files it under
 *    its product, and the answer is sounded like a scan — the success chime
 *    for a new printer, the error tone and buzz for one already held.
 *  - A LIST: paste one per line or CSV; «معاينة» asks the server what each
 *    line would do (new, already there, repeated, invalid — and why), and
 *    only then «حفظ» commits. The server re-checks everything on commit; the
 *    preview is advice, never trusted.
 */
import React, { useState } from 'react';
import { ClipboardList, Hash, Plus, Save } from 'lucide-react';
import * as T from '../../adminProducts/theme';
import { useLanguage } from '../../../LanguageContext';
import { Segmented } from '../../ui/Segmented';
import { serialProblem } from '../../../../packages/catalog/src/deviceSerials';
import { scanFeedback } from '../../scanner/feedback';
import FilingFields, { EMPTY_FILING, type FilingState } from './FilingFields';
import { inventoryApi, problemText, refusalText, type InventoryStrings, type PreviewOutcome, type PreviewResponse } from './model';

type Mode = 'single' | 'bulk';

const TEXTAREA =
  'w-full min-h-[160px] rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] border border-[var(--ap-border)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--ap-text-1)] placeholder:text-[var(--ap-text-3)] transition-colors hover:border-[var(--ap-border-hover)] focus:outline-none focus:border-[var(--ap-accent)] focus:shadow-[0_0_0_3px_var(--ap-accent-soft)]';

export const OUTCOME_TONE: Record<PreviewOutcome | 'checking' | 'error', string> = {
  new: 'text-[var(--ap-success)] bg-[var(--ap-success-bg)] border-[var(--ap-success-border)]',
  new_assigned: 'text-[var(--ap-info)] bg-[var(--ap-info-bg)] border-[var(--ap-info-border)]',
  exists: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]',
  duplicate_in_batch: 'text-[var(--ap-warning)] bg-[var(--ap-warning-bg)] border-[var(--ap-warning-border)]',
  invalid: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]',
  checking: 'text-[var(--ap-text-3)] bg-[var(--ap-surface-2)] border-[var(--ap-border)]',
  error: 'text-[var(--ap-danger)] bg-[var(--ap-danger-bg)] border-[var(--ap-danger-border)]',
};

export default function ManualEntry({
  t,
  onSaved,
  onDirty,
  toast,
}: {
  t: InventoryStrings;
  onSaved: () => void;
  /** Unsaved work in the list — the sheet asks before discarding it. */
  onDirty: (dirty: boolean) => void;
  toast: { success: (m: string) => void };
}) {
  const { lang } = useLanguage();
  const [mode, setMode] = useState<Mode>('single');
  const [filing, setFiling] = useState<FilingState>(EMPTY_FILING);

  // ---- one serial
  const [one, setOne] = useState({ serial: '', box_sn: '', ean: '' });
  const [oneBusy, setOneBusy] = useState(false);
  const [oneError, setOneError] = useState<string | null>(null);

  // ---- list
  const [text, setTextRaw] = useState('');
  const setText = (v: string) => {
    setTextRaw(v);
    onDirty(!!v.trim());
  };
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewFor, setPreviewFor] = useState('');
  const [bulkBusy, setBulkBusy] = useState<'preview' | 'commit' | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const addOne = async (e: React.FormEvent) => {
    e.preventDefault();
    if (oneBusy) return;
    const problem = serialProblem(one.serial);
    if (problem) {
      setOneError(problemText(t, lang, problem) ?? t.genericError);
      scanFeedback('invalid');
      return;
    }
    setOneBusy(true);
    setOneError(null);
    try {
      // The camera's door: with no product chosen, the typed EAN or model
      // name files it («A1 Combo» → its one catalogue product), never «بلا منتج»
      // when the label says what it is.
      const res = await inventoryApi.scan({ ...one, model_code: filing.model_code, model_name: filing.model_name }, filing, 'manual');
      if (res.outcome === 'added' || res.outcome === 'added_assigned') {
        scanFeedback('added');
        const p = res.row?.product;
        toast.success(p ? t.addedUnder((lang === 'en' ? p.name || p.name_ar : p.name_ar || p.name) || p.id) : t.addedNoProduct);
        setOne({ serial: '', box_sn: '', ean: '' });
        onSaved();
      } else if (res.outcome === 'exists') {
        scanFeedback('exists');
        const at = res.row ? ` — ${t.alreadyAt(res.row.created_at.slice(0, 10), res.row.created_by.email ?? res.row.created_by.username ?? '')}` : '';
        setOneError(`${t.alreadyRegistered}${at}`);
      } else {
        scanFeedback('invalid');
        setOneError((res.problem && problemText(t, lang, res.problem)) || t.notASerial);
      }
    } catch (err) {
      setOneError(refusalText(err, t, lang));
    } finally {
      setOneBusy(false);
    }
  };

  const runPreview = async () => {
    if (!text.trim() || bulkBusy) return;
    setBulkBusy('preview');
    setBulkError(null);
    try {
      const res = await inventoryApi.previewText(text, filing);
      setPreview(res);
      setPreviewFor(text);
    } catch (err) {
      setBulkError(refusalText(err, t, lang));
      setPreview(null);
    } finally {
      setBulkBusy(null);
    }
  };

  const commitList = async () => {
    if (!preview || bulkBusy) return;
    setBulkBusy('commit');
    setBulkError(null);
    try {
      const res = await inventoryApi.commitText(previewFor, filing);
      scanFeedback(res.inserted > 0 ? 'added' : 'exists');
      toast.success(res.skipped_concurrent ? t.committedSome(res.inserted, res.skipped_concurrent) : t.committed(res.inserted));
      setText('');
      setPreview(null);
      setPreviewFor('');
      onSaved();
    } catch (err) {
      setBulkError(refusalText(err, t, lang));
    } finally {
      setBulkBusy(null);
    }
  };

  const toAdd = preview ? preview.counts.new + preview.counts.new_assigned : 0;
  const stale = !!preview && previewFor !== text;

  return (
    <div className="space-y-4" data-serial-manual>
      <Segmented
        group="serial-manual-mode"
        label={t.manualTitle}
        value={mode}
        onChange={(id) => setMode(id as Mode)}
        dataAttr="data-serial-manual-mode"
        items={[
          { id: 'single', label: t.modeSingle, icon: <Hash className="h-4 w-4" aria-hidden /> },
          { id: 'bulk', label: t.modeBulk, icon: <ClipboardList className="h-4 w-4" aria-hidden /> },
        ]}
      />
      <FilingFields t={t} value={filing} onChange={setFiling} disabled={oneBusy || bulkBusy === 'commit'} />

      {mode === 'single' && (
        <form onSubmit={addOne} className="grid gap-3 sm:grid-cols-2 items-end" data-serial-single>
          <label className="block min-w-0 sm:col-span-2">
            <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">{t.serial}</span>
            <input
              className={`${T.input} w-full font-mono min-h-[44px]`}
              dir="ltr"
              value={one.serial}
              onChange={(e) => setOne({ ...one, serial: e.target.value })}
              placeholder={t.serialPh}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={80}
              aria-invalid={!!oneError}
              aria-describedby={oneError ? 'serial-one-error' : undefined}
            />
          </label>
          <label className="block min-w-0">
            <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">
              {t.boxSn} <span className="text-[var(--ap-text-3)] font-normal">({t.optional})</span>
            </span>
            <input className={`${T.input} w-full font-mono min-h-[44px]`} dir="ltr" value={one.box_sn} onChange={(e) => setOne({ ...one, box_sn: e.target.value })} placeholder={t.boxPh} maxLength={60} spellCheck={false} />
          </label>
          <label className="block min-w-0">
            <span className="block mb-1 text-[12px] font-medium text-[var(--ap-text-2)]">
              {t.ean} <span className="text-[var(--ap-text-3)] font-normal">({t.optional})</span>
            </span>
            <input className={`${T.input} w-full font-mono min-h-[44px]`} dir="ltr" inputMode="numeric" value={one.ean} onChange={(e) => setOne({ ...one, ean: e.target.value })} placeholder={t.eanPh} maxLength={14} />
          </label>
          {oneError && (
            <p id="serial-one-error" role="alert" className="sm:col-span-2 text-[12.5px] font-semibold text-[var(--ap-danger)]">
              {oneError}
            </p>
          )}
          <button type="submit" className={`${T.btnPrimary} sm:col-span-2 min-h-[46px] w-full`} disabled={oneBusy || !one.serial.trim()}>
            <Plus className="w-4 h-4" aria-hidden />
            {oneBusy ? t.committing : t.addOne}
          </button>
        </form>
      )}

      {mode === 'bulk' && (
        <div className="space-y-3" data-serial-bulk>
          <label className="block">
            <span className="block mb-1 text-[12.5px] font-semibold text-[var(--ap-text-1)]">{t.pasteLabel}</span>
            <textarea
              className={`${TEXTAREA} font-mono`}
              dir="ltr"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t.pastePh}
              spellCheck={false}
              aria-describedby="serial-bulk-hint"
              data-serial-paste
            />
            <span id="serial-bulk-hint" className="block mt-1 text-[11.5px] text-[var(--ap-text-3)]">
              {t.pasteHint}
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={`${T.btnSecondary} min-h-[44px]`} disabled={!text.trim() || !!bulkBusy} onClick={() => void runPreview()} data-serial-preview>
              {bulkBusy === 'preview' ? t.previewing : t.previewBtn}
            </button>
            {preview && !stale && (
              <button type="button" className={`${T.btnPrimary} min-h-[44px]`} disabled={!toAdd || !!bulkBusy} onClick={() => void commitList()} data-serial-commit>
                <Save className="w-4 h-4" aria-hidden />
                {bulkBusy === 'commit' ? t.committing : t.commitN(toAdd)}
              </button>
            )}
          </div>
          {bulkError && (
            <p role="alert" className="text-[12.5px] text-[var(--ap-danger)]">
              {bulkError}
            </p>
          )}
          {preview && (
            <div className={`space-y-2 ${stale ? 'opacity-50' : ''}`} data-serial-preview-table>
              <p className="text-[12.5px] text-[var(--ap-text-2)]" role="status">
                {t.summary(preview.counts)}
              </p>
              {preview.product?.serialized === false && <p className="text-[12px] text-[var(--ap-danger)]">{t.notSerialized}</p>}
              <div className={`${T.surface} overflow-auto max-h-[46vh]`}>
                <table className="w-full border-collapse min-w-[520px]">
                  <thead className={`${T.tableHead} sticky top-0 bg-[var(--ap-surface-2)]`}>
                    <tr>
                      {[t.line, t.serial, t.model, t.outcome].map((h) => (
                        <th key={h} scope="col" className="px-3 py-2 text-start font-semibold text-[11.5px] whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ap-hairline)]">
                    {preview.rows.map((r) => (
                      <tr key={r.line} data-preview-outcome={r.outcome}>
                        <td className="px-3 py-2 text-[12px] text-[var(--ap-text-3)] tabular-nums">{r.line}</td>
                        <td className="px-3 py-2 font-mono text-[12.5px] text-[var(--ap-text-1)]" dir="ltr">
                          {r.serial_raw || '—'}
                        </td>
                        <td className="px-3 py-2 text-[12px] text-[var(--ap-text-2)]" dir="ltr">
                          {[r.model_name, r.model_code].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`${T.badgeBase} ${OUTCOME_TONE[r.outcome]}`}>{t.outcomes[r.outcome]}</span>
                          {(r.problem || r.duplicate_of) && (
                            <span className="ms-2 text-[11.5px] text-[var(--ap-text-3)]">
                              {r.problem ? problemText(t, lang, r.problem) ?? r.problem : t.duplicateOf(r.duplicate_of as number)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
