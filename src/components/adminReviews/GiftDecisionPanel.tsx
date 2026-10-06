/**
 * THE GIFT DECISION (brief §3, §4, §11; docs/REVIEWS_GIFTS.md §6.2, §8 C2).
 *
 *   level 1–5 ........ the admin's judgement of the review. NOTHING is
 *                      preselected and nothing is predicted: the radios start
 *                      empty, and the advisory quality score never sets one.
 *   mode ............. «استخدام هدايا المستوى» (the level's active products,
 *                      the customer picks one after redeeming) or «اختيار هدية
 *                      يدويًا» (one product, sale type, option and colour fixed
 *                      by the admin in the configurator, shown with its image
 *                      and words before anything is issued).
 *   «تأكيد وإصدار الكود» asks first (useConfirm), then sends ONE request with a
 *                      requestId made once per attempt: a double press, a
 *                      retry after a lost answer or a second tab all reach the
 *                      server with the same key, and the server makes one
 *                      entitlement and one code. The raw code goes straight to
 *                      the caller's IssuedCodeDialog and nowhere else.
 *
 * Reject and «طلب تعديل» keep their behaviour (a reason, shown to the
 * customer); a rejected gift never unpublishes the review.
 */
import React, { useId, useMemo, useRef, useState } from 'react';
import { Ban, Gift, KeyRound, PackageCheck, PencilLine, RotateCcw, ShieldOff, ShoppingCart } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api, formatIqd } from '../../lib/api';
import { toast } from '../../lib/toastStore';
import { useConfirm } from '../ui/ConfirmDialog';
import { usePrompt } from '../ui/PromptDialog';
import { formatDateTime, statusLabel } from '../orders/format';
import {
  GIFT_LEVELS,
  activeCount,
  canCancel,
  canConvert,
  canFulfil,
  canReissue,
  canRevoke,
  fill,
  isLocked,
  issueBlock,
  itemsOfLevel,
  nameIn,
  newRequestId,
  normalizeIssueResult,
  outcomeUnknown,
  personLabel,
  shownState,
  variantIn,
  type EntitlementView,
  type Lang,
  type LevelItem,
  type ManualGift,
  type QueueRow,
} from './model';
import { adminStrings } from './strings';
import { errorText } from './errorText';
import { Chip, LEVEL_SQUARE, Notice, RADIO_CHIP, RadioGroup, Thumb } from './ui';
import { OrderLink } from './ReviewFacts';
import type { IssuedCode } from './IssuedCodeDialog';

const GiftItemSheet = React.lazy(() => import('./GiftItemSheet'));

export interface ChoiceState {
  mode: 'level' | 'manual';
  level: number | null;
  manual: ManualGift | null;
  note: string;
}

/** A new decision: mode «level» (the usual path), NO level, no manual gift. */
export const freshChoice = (): ChoiceState => ({ mode: 'level', level: null, manual: null, note: '' });

/** The manual gift as the admin confirms it: picture, name, sale type, variant, colour. */
export function ManualGiftCard({ gift, lang, action }: { gift: ManualGift; lang: Lang; action?: React.ReactNode }) {
  const S = adminStrings(lang);
  const d = gift.display;
  const variant = variantIn(lang, d);
  return (
    <div className={`${T.surface} p-3 flex items-start gap-3`} data-manual-gift={gift.selection.productId}>
      <Thumb src={d.image} size="lg" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-[13.5px] font-semibold text-[var(--ap-text-1)] break-words">{nameIn(lang, d) || gift.selection.productId}</p>
        <div className="flex flex-wrap gap-1.5">
          <Chip tone="accent">{S.sheet.saleTypes[gift.selection.saleType]}</Chip>
          {gift.selection.saleType === 'pre_order' && gift.selection.transportMethod && (
            <Chip tone="neutral">{S.sheet.transports[gift.selection.transportMethod]}</Chip>
          )}
          {variant && <Chip tone="neutral">{variant}</Chip>}
          {d.color_name && (
            <Chip
              tone="neutral"
              icon={
                d.color_hex ? (
                  <span aria-hidden="true" className="inline-block w-2.5 h-2.5 rounded-full border border-[var(--ap-border-strong)]" style={{ background: d.color_hex }} />
                ) : undefined
              }
            >
              {d.color_name}
            </Chip>
          )}
        </div>
        {d.regular_iqd !== null && <p className="text-[12px] text-[var(--ap-text-3)]">{fill(S.sheet.price, { price: formatIqd(d.regular_iqd) })}</p>}
        <p className="text-[11.5px] text-[var(--ap-text-3)]">{S.decision.manualFixed}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * The level and the mode — controlled, so the tests can render it with
 * nothing chosen and the queue can keep a draft per row.
 */
export function GiftChoice({
  lang,
  dir,
  state,
  onChange,
  levels,
  onOpenManual,
  disabled,
}: {
  lang: Lang;
  dir: 'rtl' | 'ltr';
  state: ChoiceState;
  onChange: (next: ChoiceState) => void;
  /** Every level item (GET /admin/pools); null while loading. */
  levels: LevelItem[] | null;
  onOpenManual: () => void;
  disabled?: boolean;
}) {
  const S = adminStrings(lang);
  const uid = useId();
  const levelItems = state.level !== null && levels ? itemsOfLevel(levels, state.level).filter((i) => i.active && !i.legacy && i.product_id) : [];
  return (
    <div className="space-y-3" data-gift-choice>
      <div>
        <p id={`${uid}-mode`} className="mb-1.5 text-[12px] font-semibold text-[var(--ap-text-2)]">
          {S.decision.mode}
        </p>
        <RadioGroup
          labelledBy={`${uid}-mode`}
          options={[
            { value: 'level' as const, label: S.decision.modeLevel },
            { value: 'manual' as const, label: S.decision.modeManual },
          ]}
          value={state.mode}
          onChange={(mode) => onChange({ ...state, mode })}
          className="flex flex-wrap gap-2"
          itemClassName={RADIO_CHIP}
          dir={dir}
          disabled={disabled}
          dataAttr="data-gift-mode"
        />
      </div>

      <div>
        <p id={`${uid}-level`} className="mb-1.5 text-[12px] font-semibold text-[var(--ap-text-2)]">
          {S.decision.level}
        </p>
        <RadioGroup
          labelledBy={`${uid}-level`}
          options={GIFT_LEVELS.map((n) => {
            const count = levels ? activeCount(levels, n) : null;
            const word = fill(S.decision.levelN, { n });
            return {
              value: n as number,
              label: n,
              ariaLabel: count === null ? word : `${word} — ${fill(S.levels.activeCount, { n: count })}`,
              title: count === null ? word : `${word} — ${fill(S.levels.activeCount, { n: count })}`,
            };
          })}
          value={state.level}
          onChange={(level) => onChange({ ...state, level })}
          className="flex flex-wrap gap-2"
          itemClassName={LEVEL_SQUARE}
          dir={dir}
          disabled={disabled}
          dataAttr="data-gift-level"
        />
        <p className="mt-1.5 text-[11.5px] text-[var(--ap-text-3)]" data-level-state={state.level === null ? 'none' : String(state.level)}>
          {state.level === null ? S.decision.levelNone : fill(S.decision.levelN, { n: state.level })} · {S.decision.levelHint}
        </p>
      </div>

      {state.mode === 'level' && state.level !== null && (
        <div data-level-preview={state.level}>
          {levels === null ? (
            <p className="text-[12px] text-[var(--ap-text-3)]">{S.decision.levelItemsLoading}</p>
          ) : levelItems.length === 0 ? (
            <Notice tone="warning">{S.decision.blocked.levelEmpty}</Notice>
          ) : (
            <>
              <p className="mb-1.5 text-[12px] text-[var(--ap-text-2)]">{fill(S.decision.levelItems, { n: state.level, count: levelItems.length })}</p>
              <ul className="flex flex-wrap gap-1.5">
                {levelItems.map((i) => (
                  <li key={i.id}>
                    <Chip tone="neutral" icon={<Gift className="w-3 h-3" aria-hidden="true" />}>
                      {nameIn(lang, i.display) || i.product_id}
                      {variantIn(lang, i.display) ? ` · ${variantIn(lang, i.display)}` : ''}
                    </Chip>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {state.mode === 'manual' && (
        <div data-manual-slot>
          {state.manual ? (
            <ManualGiftCard
              gift={state.manual}
              lang={lang}
              action={
                <button type="button" className={`${T.btnSecondary} relative lv-hit shrink-0`} onClick={onOpenManual} disabled={disabled}>
                  {S.decision.manualChange}
                </button>
              }
            />
          ) : (
            <div className={`${T.surface} p-3 flex flex-wrap items-center justify-between gap-2`}>
              <p className="text-[12.5px] text-[var(--ap-text-3)]">{S.decision.manualNone}</p>
              <button type="button" className={`${T.btnSecondary} relative lv-hit`} onClick={onOpenManual} disabled={disabled} data-open-manual>
                <Gift className="w-4 h-4" aria-hidden="true" />
                {S.decision.manualPick}
              </button>
            </div>
          )}
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-[12px] font-semibold text-[var(--ap-text-2)]" htmlFor={`${uid}-note`}>
          {S.decision.note}
        </label>
        <textarea
          id={`${uid}-note`}
          rows={2}
          maxLength={1000}
          value={state.note}
          disabled={disabled}
          onChange={(e) => onChange({ ...state, note: e.target.value })}
          placeholder={S.decision.notePlaceholder}
          className={`${T.input} w-full h-auto py-2 leading-relaxed`}
        />
      </div>
    </div>
  );
}

/** One issue request at a time, one requestId per attempt (kept across an unknown outcome). */
function useIssueFlow(lang: Lang) {
  const S = adminStrings(lang);
  const attempt = useRef<string | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async (
    url: string,
    body: Record<string, unknown>,
    onCode: (r: ReturnType<typeof normalizeIssueResult>) => void,
    onSettled: () => void
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    attempt.current = attempt.current ?? newRequestId();
    try {
      const res = await api.post<unknown>(url, { ...body, requestId: attempt.current });
      attempt.current = null;
      const r = normalizeIssueResult(res);
      if (r.code) onCode(r);
      // A replay of the same attempt carries no code: say so, never invent one.
      else setError(S.decision.replayed);
      onSettled();
    } catch (e) {
      const unknown = outcomeUnknown(e);
      if (!unknown) attempt.current = null;
      setError(await errorText(e, lang));
      if (!unknown) onSettled();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  /** The decision changed: the next press is a new attempt. */
  const reset = () => {
    if (!inFlight.current) attempt.current = null;
  };
  return { send, busy, error, setError, reset };
}

function blockText(lang: Lang, block: ReturnType<typeof issueBlock>): string {
  if (!block) return '';
  return adminStrings(lang).decision.blocked[block];
}

/** The decision for one queue row (undecided), or what was decided (decided). */
export default function GiftDecisionPanel({
  row,
  lang,
  dir,
  levels,
  pointsValue,
  onIssued,
  onChanged,
  initialChoice,
}: {
  row: QueueRow;
  lang: Lang;
  dir: 'rtl' | 'ltr';
  levels: LevelItem[] | null;
  pointsValue: number | null;
  onIssued: (issued: IssuedCode) => void;
  onChanged: () => void;
  /** Tests only: render a given draft. */
  initialChoice?: ChoiceState;
}) {
  const S = adminStrings(lang);
  const [choice, setChoiceState] = useState<ChoiceState>(initialChoice ?? freshChoice);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetEver, setSheetEver] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const [prompt, promptDialog] = usePrompt();
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState('');
  const flow = useIssueFlow(lang);
  const customer = personLabel(row.user);
  const undecided = row.reward.state === 'submitted' || row.reward.state === 'revision_needed';

  const setChoice = (next: ChoiceState) => {
    // Any change of level, mode or gift is a new decision → a new attempt key.
    if (next.level !== choice.level || next.mode !== choice.mode || next.manual !== choice.manual) flow.reset();
    setChoiceState(next);
  };

  const block = useMemo(
    () => issueBlock(row, choice, (n) => (levels ? activeCount(levels, n) : null)),
    [row, choice, levels]
  );

  const issue = async () => {
    if (block || flow.busy || choice.level === null) return;
    const level = choice.level;
    const giftName = choice.manual ? nameIn(lang, choice.manual.display) : '';
    const ok = await confirm({
      title: fill(S.decision.confirmTitle, { n: level }),
      consequence:
        choice.mode === 'manual'
          ? fill(S.decision.confirmManualBody, { customer, gift: giftName })
          : fill(S.decision.confirmLevelBody, { customer, n: level }),
      confirmLabel: S.decision.issue,
      cancelLabel: S.cancel,
    });
    if (!ok) return;
    const body: Record<string, unknown> = { action: 'approve', level, mode: choice.mode };
    if (choice.mode === 'manual' && choice.manual) body.manual = choice.manual.selection;
    if (choice.note.trim()) body.note = choice.note.trim();
    await flow.send(
      `/api/reviews/admin/${encodeURIComponent(row.review.id)}/reward`,
      body,
      (r) => onIssued({ code: r.code as string, customer, level: r.level ?? level, issuedAt: r.issuedAt, issuedBy: r.issuedBy }),
      onChanged
    );
  };

  const decide = async (action: 'reject' | 'request_changes') => {
    if (deciding) return;
    const reason = await prompt({
      title: action === 'reject' ? S.decision.rejectTitle : S.decision.requestChangesTitle,
      description: action === 'reject' ? S.decision.rejectBody : undefined,
      label: S.moderation.reasonLabel,
      required: true,
      multiline: true,
      maxLength: 1000,
      validate: (v) => (v.length < 3 ? S.reasonMin3 : null),
      confirmLabel: action === 'reject' ? S.decision.reject : S.decision.requestChanges,
      cancelLabel: S.cancel,
      destructive: action === 'reject',
    });
    if (reason === null) return;
    setDeciding(true);
    setDecideError('');
    try {
      await api.post(`/api/reviews/admin/${encodeURIComponent(row.review.id)}/reward`, { action, reason });
      toast.success(action === 'reject' ? S.decision.rejected : S.decision.changesRequested);
      onChanged();
    } catch (e) {
      setDecideError(await errorText(e, lang));
    } finally {
      setDeciding(false);
    }
  };

  const approvePoints = async () => {
    if (deciding || pointsValue === null) return;
    const reason = await prompt({
      title: S.decision.approvePointsTitle,
      label: S.decision.reasonLabel,
      required: true,
      multiline: true,
      maxLength: 1000,
      validate: (v) => (v.length < 3 ? S.reasonMin3 : null),
      confirmLabel: fill(S.decision.approvePoints, { n: pointsValue }),
      cancelLabel: S.cancel,
    });
    if (reason === null) return;
    setDeciding(true);
    setDecideError('');
    try {
      const res = await api.post<{ points_awarded?: number }>(`/api/reviews/admin/${encodeURIComponent(row.review.id)}/reward`, { action: 'approve', reason });
      toast.success(fill(S.decision.pointsAwarded, { n: res?.points_awarded ?? pointsValue }));
      onChanged();
    } catch (e) {
      setDecideError(await errorText(e, lang));
    } finally {
      setDeciding(false);
    }
  };

  const decidedLine =
    row.reward.decided_at || row.reward.decided_by ? (
      <p className="text-[12px] text-[var(--ap-text-3)]">
        {fill(S.decision.decidedBy, { who: row.reward.decided_by || '—', date: formatDateTime(row.reward.decided_at, lang) || '—' })}
      </p>
    ) : null;

  return (
    <section className={`${T.surface} p-3 space-y-3`} data-gift-decision={row.review.id} aria-label={S.decision.title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--ap-text-1)]">
          <Gift className="w-4 h-4 text-[var(--ap-accent-text)]" aria-hidden="true" />
          {S.decision.title}
        </h4>
        <Chip tone={row.reward.state === 'approved' ? 'success' : row.reward.state === 'rejected' ? 'danger' : row.reward.state === 'revision_needed' ? 'warning' : 'info'}>
          {S.rewardKinds[row.reward.kind]} · {S.rewardStates[row.reward.state]}
        </Chip>
      </div>

      {row.reward.reason && !undecided && <p className="text-[12.5px] text-[var(--ap-text-2)] break-words">{fill(S.decision.decidedReason, { reason: row.reward.reason })}</p>}
      {row.reward.state === 'revision_needed' && row.reward.reason && (
        <Notice tone="info">{fill(S.decision.decidedReason, { reason: row.reward.reason })}</Notice>
      )}
      {!undecided && decidedLine}

      {/* ---- decided: what was granted, and the code's life after it ---- */}
      {row.reward.state === 'approved' && row.reward.kind === 'printer_gift' && row.entitlement && (
        <EntitlementBlock ent={row.entitlement} customer={customer} lang={lang} onIssued={onIssued} onChanged={onChanged} />
      )}
      {row.reward.state === 'approved' && row.reward.kind === 'points' && row.reward.points_awarded > 0 && (
        <p className="text-[13px] text-[var(--ap-text-1)]">{fill(S.decision.pointsAwarded, { n: row.reward.points_awarded })}</p>
      )}

      {/* ---- undecided ---- */}
      {undecided && row.reward.kind === 'points' && (
        <div className="space-y-2">
          {pointsValue === null ? (
            <Notice tone="warning">{S.decision.pointsUnconfigured}</Notice>
          ) : (
            <button type="button" className={`${T.btnPrimary} relative lv-hit`} disabled={deciding} onClick={() => void approvePoints()}>
              {fill(S.decision.approvePoints, { n: pointsValue })}
            </button>
          )}
        </div>
      )}

      {undecided && row.reward.kind === 'printer_gift' && (
        <>
          {row.legacy && <Notice tone="warning">{S.queue.legacy}</Notice>}
          {row.review.source === 'system' && <Notice tone="warning">{S.decision.blocked.system}</Notice>}
          <GiftChoice
            lang={lang}
            dir={dir}
            state={choice}
            onChange={setChoice}
            levels={levels}
            disabled={flow.busy}
            onOpenManual={() => {
              setSheetEver(true);
              setSheetOpen(true);
            }}
          />
          <div className="space-y-1.5" aria-live="polite">
            <button
              type="button"
              className={`${T.btnPrimary} relative lv-hit w-full`}
              disabled={!!block || flow.busy}
              aria-busy={flow.busy || undefined}
              onClick={() => void issue()}
              data-issue-code
            >
              <KeyRound className="w-4 h-4" aria-hidden="true" />
              {flow.busy ? S.decision.issuing : S.decision.issue}
            </button>
            {block && block !== 'decided' && <p className="text-[12px] text-[var(--ap-text-3)]" data-issue-block={block}>{blockText(lang, block)}</p>}
            {flow.error && <Notice tone="danger" live>{flow.error}</Notice>}
          </div>
        </>
      )}

      {undecided && (
        <div className="flex flex-wrap gap-2 border-t border-[var(--ap-hairline)] pt-3">
          <button type="button" className={`${T.btnGhost} relative lv-hit`} disabled={deciding || flow.busy} onClick={() => void decide('request_changes')} data-reward-action="request_changes">
            <PencilLine className="w-4 h-4" aria-hidden="true" />
            {S.decision.requestChanges}
          </button>
          <button type="button" className={`${T.btnDanger} relative lv-hit`} disabled={deciding || flow.busy} onClick={() => void decide('reject')} data-reward-action="reject">
            <Ban className="w-4 h-4" aria-hidden="true" />
            {S.decision.reject}
          </button>
        </div>
      )}
      {decideError && <Notice tone="danger" live>{decideError}</Notice>}

      {sheetEver && (
        <React.Suspense fallback={null}>
          <GiftItemSheet
            open={sheetOpen}
            mode="manual-gift"
            level={choice.level ?? 1}
            initialManual={choice.manual}
            onClose={() => setSheetOpen(false)}
            onChosen={(manual) => {
              setChoice({ ...choice, manual, mode: 'manual' });
              setSheetOpen(false);
            }}
          />
        </React.Suspense>
      )}
      {confirmDialog}
      {promptDialog}
    </section>
  );
}

/**
 * A granted gift and its code: the state, the code's life (issued, used,
 * revoked, locked after 5 wrong tries), who issued it and when — and the
 * actions the server allows from that state. The raw code is never here.
 */
export function EntitlementBlock({
  ent,
  customer,
  lang,
  onIssued,
  onChanged,
}: {
  ent: EntitlementView;
  customer: string;
  lang: Lang;
  onIssued: (issued: IssuedCode) => void;
  onChanged: () => void;
}) {
  const S = adminStrings(lang);
  const [prompt, promptDialog] = usePrompt();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reissueAttempt = useRef<string | null>(null);
  const state = shownState(ent);
  const locked = isLocked(ent);
  const tone = state === 'cancelled' ? 'danger' : state === 'fulfilled' ? 'success' : state === 'code_issued' ? 'info' : 'accent';
  const base = `/api/reviews/admin/gifts/${encodeURIComponent(ent.id)}`;

  const askReason = (title: string, body: string, confirmLabel: string, destructive: boolean) =>
    prompt({
      title,
      description: body,
      label: S.decision.reasonLabel,
      required: true,
      multiline: true,
      maxLength: 1000,
      validate: (v) => (v.length < 5 ? S.reasonMin5 : null),
      confirmLabel,
      cancelLabel: S.cancel,
      destructive,
    });

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(await errorText(e, lang));
    } finally {
      setBusy(false);
    }
  };

  const reissue = async () => {
    const reason = await askReason(S.entitlement.reissueTitle, S.entitlement.reissueBody, S.entitlement.reissue, true);
    if (reason === null) return;
    await run(async () => {
      reissueAttempt.current = reissueAttempt.current ?? newRequestId();
      try {
        const res = await api.post<unknown>(`${base}/reissue-code`, { reason, requestId: reissueAttempt.current });
        reissueAttempt.current = null;
        const r = normalizeIssueResult(res);
        if (r.code) onIssued({ code: r.code, customer, level: r.level ?? ent.level, issuedAt: r.issuedAt, issuedBy: r.issuedBy });
        else setError(S.decision.replayed);
        onChanged();
      } catch (e) {
        if (!outcomeUnknown(e)) reissueAttempt.current = null;
        throw e;
      }
    });
  };

  const revoke = async () => {
    const reason = await askReason(S.entitlement.revokeTitle, S.entitlement.revokeBody, S.entitlement.revoke, true);
    if (reason === null) return;
    await run(async () => {
      await api.post(`${base}/revoke-code`, { reason });
      toast.success(S.entitlement.revoked);
      onChanged();
    });
  };

  const cancel = async () => {
    const reason = await askReason(S.entitlement.cancelTitle, S.entitlement.cancelBody, S.entitlement.cancel, true);
    if (reason === null) return;
    await run(async () => {
      await api.post(`${base}/cancel`, { reason });
      toast.success(S.entitlement.cancelled);
      onChanged();
    });
  };

  const fulfil = async () => {
    await run(async () => {
      await api.post(`${base}/fulfill`);
      toast.success(S.entitlement.fulfilled);
      onChanged();
    });
  };

  return (
    <div className="space-y-2" data-entitlement={ent.id} data-entitlement-state={state}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={tone} icon={state === 'in_cart' ? <ShoppingCart className="w-3 h-3" aria-hidden="true" /> : <Gift className="w-3 h-3" aria-hidden="true" />}>
          {S.entitlement.states[state]}
        </Chip>
        {ent.level !== null && <Chip tone="neutral">{fill(S.entitlement.levelMode, { n: ent.level, mode: S.entitlement.modes[ent.grant_mode] })}</Chip>}
      </div>
      {ent.grant_mode !== 'legacy' && (
        <dl className="grid gap-x-4 gap-y-1 text-[12.5px] md:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-[11.5px] font-semibold text-[var(--ap-text-3)]">{S.entitlement.code}</dt>
            <dd className="text-[var(--ap-text-1)]">
              {S.entitlement.codeStates[ent.code_state]}
              {ent.code_state === 'issued' && ent.code_attempts > 0 && (
                <span className="text-[var(--ap-text-2)]"> · {fill(S.entitlement.attempts, { n: ent.code_attempts })}</span>
              )}
            </dd>
          </div>
          {ent.code_issued_at && (
            <div className="min-w-0">
              <dt className="sr-only">{S.entitlement.code}</dt>
              <dd className="text-[var(--ap-text-2)]">{fill(S.entitlement.issuedAt, { date: formatDateTime(ent.code_issued_at, lang), who: ent.code_issued_by || '—' })}</dd>
            </div>
          )}
          {ent.code_redeemed_at && (
            <div className="min-w-0">
              <dt className="sr-only">{S.entitlement.code}</dt>
              <dd className="text-[var(--ap-text-2)]">{fill(S.entitlement.redeemedAt, { date: formatDateTime(ent.code_redeemed_at, lang) })}</dd>
            </div>
          )}
          {ent.order && (
            <div className="min-w-0">
              <dt className="sr-only">{fill(S.entitlement.order, { id: ent.order.id })}</dt>
              <dd>
                <OrderLink id={ent.order.id} label={ent.order.status ? statusLabel(lang, ent.order.status) : S.facts.openOrder} />
              </dd>
            </div>
          )}
        </dl>
      )}
      {locked && <Notice tone="warning">{S.entitlement.locked}</Notice>}
      {ent.state === 'code_issued' && <p className="text-[11.5px] text-[var(--ap-text-3)]">{S.entitlement.codeHidden}</p>}
      {ent.state === 'ordered' && <p className="text-[12px] text-[var(--ap-text-3)]">{S.entitlement.orderedHint}</p>}

      <div className="flex flex-wrap gap-2">
        {canReissue(ent) && (
          <button type="button" className={`${T.btnSecondary} relative lv-hit`} disabled={busy} onClick={() => void reissue()} data-ent-action="reissue">
            <RotateCcw className="w-4 h-4" aria-hidden="true" />
            {S.entitlement.reissue}
          </button>
        )}
        {canRevoke(ent) && (
          <button type="button" className={`${T.btnGhost} relative lv-hit`} disabled={busy} onClick={() => void revoke()} data-ent-action="revoke">
            <ShieldOff className="w-4 h-4" aria-hidden="true" />
            {S.entitlement.revoke}
          </button>
        )}
        {canFulfil(ent) && (
          <button type="button" className={`${T.btnSecondary} relative lv-hit`} disabled={busy} onClick={() => void fulfil()} data-ent-action="fulfil">
            <PackageCheck className="w-4 h-4" aria-hidden="true" />
            {S.entitlement.fulfil}
          </button>
        )}
        {canCancel(ent) && (
          <button type="button" className={`${T.btnDanger} relative lv-hit`} disabled={busy} onClick={() => void cancel()} data-ent-action="cancel">
            <Ban className="w-4 h-4" aria-hidden="true" />
            {S.entitlement.cancel}
          </button>
        )}
      </div>
      {error && <Notice tone="danger" live>{error}</Notice>}
      {promptDialog}
    </div>
  );
}

/**
 * A LEGACY `available` gift becomes a code (POST /admin/gifts/:id/issue): the
 * same choice and the same guarded issue as a new decision.
 */
export function ConvertGiftPanel({
  ent,
  customer,
  lang,
  dir,
  levels,
  onIssued,
  onChanged,
}: {
  ent: EntitlementView;
  customer: string;
  lang: Lang;
  dir: 'rtl' | 'ltr';
  levels: LevelItem[] | null;
  onIssued: (issued: IssuedCode) => void;
  onChanged: () => void;
}) {
  const S = adminStrings(lang);
  const [choice, setChoiceState] = useState<ChoiceState>(freshChoice);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetEver, setSheetEver] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const flow = useIssueFlow(lang);
  const setChoice = (next: ChoiceState) => {
    if (next.level !== choice.level || next.mode !== choice.mode || next.manual !== choice.manual) flow.reset();
    setChoiceState(next);
  };
  const pseudoRow = {
    reward: { state: 'submitted' as const },
    review: { source: 'user' as const },
    legacy: false,
    eligibility: { live: null },
  } as unknown as QueueRow;
  const block = issueBlock(pseudoRow, choice, (n) => (levels ? activeCount(levels, n) : null));
  if (!canConvert(ent)) return null;

  const issue = async () => {
    if (block || flow.busy || choice.level === null) return;
    const level = choice.level;
    const ok = await confirm({
      title: fill(S.decision.confirmTitle, { n: level }),
      consequence:
        choice.mode === 'manual' && choice.manual
          ? fill(S.decision.confirmManualBody, { customer, gift: nameIn(lang, choice.manual.display) })
          : fill(S.decision.confirmLevelBody, { customer, n: level }),
      confirmLabel: S.decision.issue,
      cancelLabel: S.cancel,
    });
    if (!ok) return;
    const body: Record<string, unknown> = { action: 'approve', level, mode: choice.mode };
    if (choice.mode === 'manual' && choice.manual) body.manual = choice.manual.selection;
    if (choice.note.trim()) body.note = choice.note.trim();
    await flow.send(
      `/api/reviews/admin/gifts/${encodeURIComponent(ent.id)}/issue`,
      body,
      (r) => onIssued({ code: r.code as string, customer, level: r.level ?? level, issuedAt: r.issuedAt, issuedBy: r.issuedBy }),
      onChanged
    );
  };

  return (
    <section className={`${T.surface} p-3 space-y-3`} data-convert={ent.id} aria-label={S.entitlement.convert}>
      <h5 className="text-[12.5px] font-semibold text-[var(--ap-text-1)]">{S.entitlement.convert}</h5>
      <GiftChoice
        lang={lang}
        dir={dir}
        state={choice}
        onChange={setChoice}
        levels={levels}
        disabled={flow.busy}
        onOpenManual={() => {
          setSheetEver(true);
          setSheetOpen(true);
        }}
      />
      <div className="space-y-1.5" aria-live="polite">
        <button type="button" className={`${T.btnPrimary} relative lv-hit w-full`} disabled={!!block || flow.busy} onClick={() => void issue()} data-issue-code>
          <KeyRound className="w-4 h-4" aria-hidden="true" />
          {flow.busy ? S.decision.issuing : S.decision.issue}
        </button>
        {block && <p className="text-[12px] text-[var(--ap-text-3)]">{blockText(lang, block)}</p>}
        {flow.error && <Notice tone="danger" live>{flow.error}</Notice>}
      </div>
      {sheetEver && (
        <React.Suspense fallback={null}>
          <GiftItemSheet
            open={sheetOpen}
            mode="manual-gift"
            level={choice.level ?? 1}
            initialManual={choice.manual}
            onClose={() => setSheetOpen(false)}
            onChosen={(manual) => {
              setChoice({ ...choice, manual, mode: 'manual' });
              setSheetOpen(false);
            }}
          />
        </React.Suspense>
      )}
      {confirmDialog}
    </section>
  );
}
