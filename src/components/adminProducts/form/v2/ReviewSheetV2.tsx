/**
 * «راجع الأسعار التي ستتغيّر» — THE ONE REVIEW SHEET (implementation spec §5.2
 * `ReviewSheetV2.tsx`, §4.3, §5.6; docs/PRICING-V2.md §2.6, P6; row 196).
 *
 * Opened by the save's 409 (PRICING_PREVIEW_REQUIRED / _STALE /
 * _LARGE_CHANGE_CONFIRM) with the server's preview:
 *   - ONLY the rows whose price changes, old → new (a product's first V2
 *     publication: every row is new — no old dinar price is ever shown);
 *   - no subscriber-price lines (P6);
 *   - a change above 15% needs the tick (and a fresh sign-in); a drop above 30%
 *     is flagged on its row;
 *   - the confirm button UNDER the table; cancel closes the sheet and keeps
 *     every typed value.
 * Nothing is computed: the rows are the server's `changes`.
 */
import { useState } from 'react';
import { Modal } from '../../ui';
import { btnGhost, btnPrimary } from '../formUi';
import { iqdText, nameIn, type V2Answer, type V2Change } from './v2Model';
import { channelName, useV2Lang, useV2Strings } from './v2Ui';

/** The rows the sheet lists: ONLY the prices that change (the server's `changes`). */
export const reviewRowsOf = (preview: V2Answer): V2Change[] => (preview.changes ?? []).filter((c) => c.old_iqd !== c.new_iqd);

/** A change above 15% (a drop above 30% is one) needs the owner's tick and a fresh sign-in. */
export const needsTickOf = (preview: V2Answer): boolean =>
  !!preview.large_change || !!preview.drop_flag || reviewRowsOf(preview).some((c) => c.large || c.drop_flag);

export default function ReviewSheetV2({
  preview,
  busy,
  error,
  progress = null,
  reauth,
  onConfirm,
  onCancel,
  onSignIn,
}: {
  preview: V2Answer;
  busy: boolean;
  error: string;
  /** While the confirmed save is still on its way (src/components/adminProducts/saveOutcome.ts): said, not an error. */
  progress?: string | null;
  reauth: boolean;
  onConfirm: (confirmLarge: boolean) => void;
  onCancel: () => void;
  onSignIn: () => void;
}) {
  const s = useV2Strings();
  const lang = useV2Lang();
  const [ticked, setTicked] = useState(false);
  const changes = reviewRowsOf(preview);
  const large = needsTickOf(preview);
  const first = changes.length > 0 && changes.every((c) => c.old_iqd === null);
  const canConfirm = !busy && !!preview.review_hash && (!large || ticked);
  return (
    <Modal
      titleAr={s.reviewTitle}
      titleEn=""
      onClose={() => {
        if (!busy) onCancel();
      }}
      wide
      footer={
        <div className="flex flex-wrap items-center gap-2" data-v2-review-actions>
          <button type="button" className={btnPrimary} disabled={!canConfirm} onClick={() => onConfirm(large && ticked)} data-v2-review-confirm>
            {s.confirm}
          </button>
          <button type="button" className={btnGhost} disabled={busy} onClick={onCancel} data-v2-review-cancel>
            {s.cancel}
          </button>
        </div>
      }
    >
      <div className="grid min-w-0 gap-3" data-v2-review>
        <p className="text-[13px] text-text-secondary">{first ? s.firstPublishNote : s.reviewIntro}</p>
        {changes.length ? (
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-0 text-[12px]">
              <thead>
                <tr className="text-text-muted">
                  <th className="py-1.5 pe-2 text-start font-bold">{s.modelColour}</th>
                  <th className="py-1.5 px-2 text-start font-bold">{s.channel}</th>
                  <th className="py-1.5 px-2 text-end font-bold">{s.oldPrice}</th>
                  <th className="py-1.5 px-2 text-end font-bold">{s.newPrice}</th>
                  <th className="py-1.5 ps-2 text-end font-bold">{s.changePercent}</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={`${c.combo_key}@${c.channel}`} className="border-t border-border-subtle" data-v2-change={`${c.combo_key}@${c.channel}`}>
                    <td className="max-w-[12rem] truncate py-1.5 pe-2 text-text-primary" dir="auto">
                      {nameIn(c.names, lang) || '—'}
                    </td>
                    <td className="py-1.5 px-2 text-text-secondary">{channelName(c.channel, lang)}</td>
                    <td className="py-1.5 px-2 text-end tabular-nums text-text-secondary" dir="ltr">
                      {c.old_iqd === null ? s.newRow : iqdText(c.old_iqd)}
                    </td>
                    <td className="py-1.5 px-2 text-end font-bold tabular-nums text-text-primary" dir="ltr">
                      {c.new_iqd === null ? s.noPriceYet : iqdText(c.new_iqd)}
                    </td>
                    <td className={`py-1.5 ps-2 text-end tabular-nums ${c.drop_flag ? 'text-red-400' : c.large ? 'text-amber-300' : 'text-text-secondary'}`} dir="ltr">
                      {c.change_percent === null ? '—' : `${c.change_percent}%`}
                      {c.drop_flag ? <span className="ms-1 text-[10px] font-bold">{s.dropFlag}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[13px] text-text-muted">{s.noChanges}</p>
        )}
        {large ? (
          <div className="lv-alert lv-alert-warning grid gap-1 px-3 py-2.5">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[13px] text-text-primary">
              <input type="checkbox" className="h-5 w-5 shrink-0" checked={ticked} disabled={busy} onChange={(e) => setTicked(e.target.checked)} data-v2-review-large />
              {s.largeTick}
            </label>
            <span className="text-[12px] text-text-secondary">{s.largeNote}</span>
          </div>
        ) : null}
        {progress && !error ? (
          <p role="status" className="text-[13px] text-amber-300" data-v2-review-progress>
            {progress}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[13px] text-red-400" data-v2-review-error>
            {error}
          </p>
        ) : null}
        {reauth ? (
          <button type="button" className={`${btnGhost} justify-self-start`} onClick={onSignIn} data-v2-sign-in>
            {s.signInAgain}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
