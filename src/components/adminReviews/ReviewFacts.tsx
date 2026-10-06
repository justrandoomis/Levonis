/**
 * THE FACTS OF ONE PRINTER REVIEW (brief §3): who wrote it, which product and
 * family, the order, its line, the unit, the serial, the warranty link, the
 * date, whether the unit was rewarded before — and the ten conditions, at
 * entry and now, each as ✓ / ✗ with its word. Read-only: the server derived
 * every value; nothing here predicts a level.
 *
 * Also the PUBLIC visibility bar: publishing is a separate decision from the
 * gift (a rejected gift never unpublishes a review, and the reverse).
 */
import React, { useState } from 'react';
import { ExternalLink, Eye, EyeOff, MessageSquareWarning } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api } from '../../lib/api';
import { toast } from '../../lib/toastStore';
import { usePrompt } from '../ui/PromptDialog';
import { formatDate, formatDateTime, statusLabel } from '../orders/format';
import { checklist, fill, nameIn, personLabel, type Lang, type QueueRow, type ReviewStatus } from './model';
import { adminStrings } from './strings';
import { errorText } from './errorText';
import { Chip, CopyValue, Fact, Stars, Verdict } from './ui';

export function familyLabel(lang: string, family: QueueRow['product']['family']): string {
  const S = adminStrings(lang);
  return family ? S.families[family] : S.families.none;
}

/** The admin order screen, deep-linked (Admin.tsx `?tab=orders&order=`). */
export function orderHref(orderId: string): string {
  return `?tab=orders&order=${encodeURIComponent(orderId)}`;
}

export function OrderLink({ id, label }: { id: string; label: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-[12.5px]" dir="ltr">
        {id}
      </span>
      <a
        href={orderHref(id)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--ap-accent-text)] underline-offset-2 hover:underline"
      >
        {label}
        <ExternalLink className="w-3 h-3" aria-hidden="true" />
      </a>
    </span>
  );
}

export function ReviewFacts({ row, lang }: { row: QueueRow; lang: Lang }) {
  const S = adminStrings(lang);
  const sec = row.product.section;
  const section = sec ? (lang === 'en' ? sec.name_en : lang === 'ckb' ? sec.name_ckb || sec.name_ar : sec.name_ar) : '';
  const images = row.review.media.filter((m) => m.kind === 'image').length;
  const videos = row.review.media.length - images;
  const regTone = row.registration.state === 'reviewer' ? 'success' : row.registration.state === 'none' ? 'warning' : 'danger';
  return (
    <section aria-label={S.facts.title} data-review-facts>
      <h4 className="mb-2 text-[12px] font-semibold text-[var(--ap-text-3)]">{S.facts.title}</h4>
      <dl className="grid gap-x-4 gap-y-3 md:grid-cols-2">
        <Fact label={S.facts.customer}>
          <span className="block">{personLabel(row.user)}</span>
          {row.user.email && (
            <span className="block text-[12px] text-[var(--ap-text-2)]" dir="ltr">
              {row.user.email}
              {row.user.username ? ` · @${row.user.username}` : ''}
            </span>
          )}
        </Fact>
        <Fact label={S.facts.product}>
          <span className="block">{nameIn(lang, row.product) || '—'}</span>
          {row.product.id && (
            <span className="block font-mono text-[11.5px] text-[var(--ap-text-3)]" dir="ltr">
              {row.product.id}
            </span>
          )}
        </Fact>
        <Fact label={S.facts.productType}>
          {familyLabel(lang, row.product.family)}
          {section ? <span className="text-[var(--ap-text-2)]"> · {section}</span> : null}
        </Fact>
        <Fact label={S.facts.order}>
          {row.order ? <OrderLink id={row.order.id} label={S.facts.openOrder} /> : '—'}
        </Fact>
        <Fact label={S.facts.orderStatus}>
          {row.order?.status ? statusLabel(lang, row.order.status) : '—'}
          {row.order?.delivered_at ? (
            <span className="text-[var(--ap-text-2)]"> · {S.facts.deliveredAt}: {formatDate(row.order.delivered_at, lang)}</span>
          ) : null}
        </Fact>
        <Fact label={S.facts.orderItem}>
          {row.order_item ? (
            <>
              {row.order_item.name && <span className="block">{row.order_item.name}</span>}
              {row.order_item.option && <span className="block text-[12px] text-[var(--ap-text-2)]">{row.order_item.option}</span>}
              <span className="block font-mono text-[11.5px] text-[var(--ap-text-3)]" dir="ltr">
                {row.order_item.id}
              </span>
            </>
          ) : (
            '—'
          )}
        </Fact>
        <Fact label={S.facts.unit}>
          {row.unit ? (
            <>
              <span className="block font-mono text-[12px]" dir="ltr">
                {row.unit.id}
              </span>
              {row.unit.unit_index !== null && <span className="block text-[12px] text-[var(--ap-text-2)]">{fill(S.facts.unitIndex, { n: row.unit.unit_index })}</span>}
              {row.unit.warranty_end_at && (
                <span className="block text-[12px] text-[var(--ap-text-2)]">{fill(S.facts.warrantyEnd, { date: formatDate(row.unit.warranty_end_at, lang) })}</span>
              )}
              {row.unit.replaced_by_unit_id && <span className="block text-[12px] text-[var(--ap-warning)]">{S.facts.replaced}</span>}
            </>
          ) : (
            '—'
          )}
        </Fact>
        <Fact label={S.facts.serial}>
          {row.serial ? (
            <span className="inline-flex items-center gap-2">
              <span className="font-mono text-[12.5px]" dir="ltr">
                {row.serial}
              </span>
              <CopyValue value={row.serial} label={S.copy} copiedLabel={S.copied} />
            </span>
          ) : (
            <span className="text-[var(--ap-text-3)]">{S.facts.noSerial}</span>
          )}
        </Fact>
        {row.receipt_no && (
          <Fact label={S.facts.receipt} ltr>
            <span className="font-mono text-[12.5px]">{row.receipt_no}</span>
          </Fact>
        )}
        <Fact label={S.facts.registration}>
          <Chip tone={regTone}>{S.registration[row.registration.state]}</Chip>
          {row.registration.registered_at && (
            <span className="block mt-1 text-[12px] text-[var(--ap-text-2)]">{fill(S.facts.registeredAt, { date: formatDateTime(row.registration.registered_at, lang) })}</span>
          )}
        </Fact>
        <Fact label={S.facts.priorReward}>
          {row.prior_reward ? (
            <Chip tone="danger">{fill(S.facts.priorYes, { state: S.rewardStates[row.prior_reward.state as keyof typeof S.rewardStates] ?? row.prior_reward.state })}</Chip>
          ) : (
            <Chip tone="success">{S.facts.priorNone}</Chip>
          )}
        </Fact>
        <Fact label={S.facts.reviewDate}>{formatDateTime(row.review.created_at, lang) || '—'}</Fact>
        <Fact label={S.facts.stars}>
          <Stars n={row.review.stars} label={fill(S.facts.starsValue, { n: row.review.stars })} />
        </Fact>
        <Fact label={S.facts.media}>{row.review.media.length ? fill(S.facts.mediaCount, { images, videos }) : S.facts.noMedia}</Fact>
      </dl>
    </section>
  );
}

/** The ten conditions of brief §2: at entry (the admission statement) and now (live). */
export function EligibilityChecklist({ row, lang }: { row: QueueRow; lang: Lang }) {
  const S = adminStrings(lang);
  const rows = checklist(row);
  const ex = row.eligibility.live?.excluded;
  const exclusions = ex ? (['gift_line', 'refunded', 'traded_in'] as const).filter((k) => ex[k]) : [];
  return (
    <section aria-label={S.checklist.title} data-eligibility-checklist>
      <h4 className="mb-2 text-[12px] font-semibold text-[var(--ap-text-3)]">{S.checklist.title}</h4>
      <div className={`${T.surface} overflow-hidden`}>
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className={T.tableHead}>
              <th scope="col" className="px-2.5 py-2 text-start font-semibold">
                {S.checklist.condition}
              </th>
              <th scope="col" className="px-2 py-2 text-start font-semibold whitespace-nowrap">
                {S.checklist.atEntry}
              </th>
              <th scope="col" className="px-2 py-2 text-start font-semibold whitespace-nowrap">
                {S.checklist.now}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.check} className="border-t border-[var(--ap-hairline)] align-top" data-check={r.check} data-now={r.now === null ? 'unknown' : r.now ? 'met' : 'not-met'}>
                <th scope="row" className="px-2.5 py-2 text-start font-normal text-[var(--ap-text-1)]">
                  {S.checklist.checks[r.check]}
                </th>
                <td className="px-2 py-2 whitespace-nowrap">
                  <Verdict value={r.atEntry} met={S.checklist.met} notMet={S.checklist.notMet} unknown={S.checklist.unknown} />
                </td>
                <td className="px-2 py-2 whitespace-nowrap">
                  <Verdict value={r.now} met={S.checklist.met} notMet={S.checklist.notMet} unknown={S.checklist.unknown} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {exclusions.length > 0 && (
        <div className="mt-2">
          <p className="text-[11.5px] font-semibold text-[var(--ap-text-3)]">{S.checklist.excluded}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {exclusions.map((k) => (
              <li key={k}>
                <Chip tone="danger">{S.checklist.exclusions[k]}</Chip>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!row.eligibility.live && <p className="mt-2 text-[12px] text-[var(--ap-text-3)]">{S.checklist.noLive}</p>}
    </section>
  );
}

/** The deterministic quality score — advice only, never a level. */
export function QualityAdvice({ row, lang }: { row: QueueRow; lang: Lang }) {
  const S = adminStrings(lang);
  const q = row.quality;
  if (!q || (q.score === null && !q.reasons.length && !q.signals.length)) return null;
  return (
    <section className="rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-2)] px-3 py-2.5 text-[12px] text-[var(--ap-text-2)]" data-quality-advice>
      <p className="font-semibold text-[var(--ap-text-1)]">
        {S.quality.title}
        {q.score !== null && <span className="ms-2 font-normal tabular-nums">{fill(S.quality.score, { score: q.score })}</span>}
      </p>
      {q.reasons.length > 0 && (
        <p className="mt-1 break-words">
          {S.quality.reasons}: {q.reasons.join(' · ')}
        </p>
      )}
      {q.signals.length > 0 && (
        <p className="mt-1 break-words text-[var(--ap-warning)]">
          {S.quality.signals}: {q.signals.join(' · ')}
        </p>
      )}
      <p className="mt-1 text-[11.5px] text-[var(--ap-text-3)]">{S.quality.note}</p>
    </section>
  );
}

/** Legacy rewards kept their private Instagram evidence; admins can still read it. */
export function LegacyEvidence({ row, lang }: { row: QueueRow; lang: Lang }) {
  const S = adminStrings(lang);
  if (!row.instagram) return null;
  return (
    <section className="text-[12.5px]" data-legacy-evidence>
      <p className="mb-1 text-[12px] font-semibold text-[var(--ap-text-3)]">{S.queue.instagram}</p>
      <div className="flex flex-wrap items-center gap-3">
        {row.instagram.link && (
          <a href={row.instagram.link} target="_blank" rel="noopener noreferrer" dir="ltr" className="inline-flex items-center gap-1 break-all text-[var(--ap-accent-text)] underline">
            {row.instagram.link}
            <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
          </a>
        )}
        {row.instagram.file_url && (
          <a href={row.instagram.file_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[var(--ap-accent-text)] underline">
            {S.queue.evidenceFile}
            <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>
        )}
      </div>
    </section>
  );
}

const STATUS_TONE: Record<ReviewStatus, 'success' | 'warning' | 'danger'> = {
  published: 'success',
  pending: 'warning',
  rejected: 'danger',
};

export function ReviewStatusChip({ status, lang }: { status: ReviewStatus; lang: Lang }) {
  const S = adminStrings(lang);
  const Icon = status === 'published' ? Eye : EyeOff;
  return (
    <Chip tone={STATUS_TONE[status]} icon={<Icon className="w-3 h-3" aria-hidden="true" />}>
      {S.reviewStatus[status]}
    </Chip>
  );
}

/**
 * PUBLIC VISIBILITY — `POST /api/reviews/admin/:id/moderate`, unchanged.
 * Reasons go through the house prompt (never `window.prompt`).
 */
export function ModerationBar({
  reviewId,
  status,
  note,
  lang,
  onDone,
}: {
  reviewId: string;
  status: ReviewStatus;
  note: string;
  lang: Lang;
  onDone: () => void;
}) {
  const S = adminStrings(lang);
  const [prompt, promptDialog] = usePrompt();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const act = async (action: 'approve' | 'reject' | 'request_changes') => {
    if (busy) return;
    let reason = '';
    if (action !== 'approve') {
      const answer = await prompt({
        title: action === 'reject' ? S.moderation.unpublish : S.moderation.requestChanges,
        description: S.moderation.reasonTitle,
        label: S.moderation.reasonLabel,
        required: true,
        multiline: true,
        maxLength: 1000,
        validate: (v) => (v.length < 3 ? S.reasonMin3 : null),
        confirmLabel: action === 'reject' ? S.moderation.unpublish : S.moderation.requestChanges,
        cancelLabel: S.cancel,
        destructive: action === 'reject',
      });
      if (answer === null) return;
      reason = answer;
    }
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/reviews/admin/${encodeURIComponent(reviewId)}/moderate`, { action, reason });
      toast.success(action === 'approve' ? S.moderation.published : action === 'reject' ? S.moderation.unpublished : S.moderation.changesRequested);
      onDone();
    } catch (e) {
      setError(await errorText(e, lang));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${T.surface} p-3 space-y-2`} data-moderation={reviewId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[12px] font-semibold text-[var(--ap-text-3)]">{S.moderation.title}</h4>
        <ReviewStatusChip status={status} lang={lang} />
      </div>
      {note && (
        <p className="flex items-start gap-1.5 text-[12px] text-[var(--ap-warning)] break-words">
          <MessageSquareWarning className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          {fill(S.moderation.note, { note })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {status !== 'published' && (
          <button type="button" className={`${T.btnSecondary} relative lv-hit`} disabled={busy} onClick={() => void act('approve')} data-moderate="approve">
            {S.moderation.publish}
          </button>
        )}
        {status !== 'rejected' && (
          <button type="button" className={`${T.btnDanger} relative lv-hit`} disabled={busy} onClick={() => void act('reject')} data-moderate="reject">
            {S.moderation.unpublish}
          </button>
        )}
        <button type="button" className={`${T.btnGhost} relative lv-hit`} disabled={busy} onClick={() => void act('request_changes')} data-moderate="request_changes">
          {S.moderation.requestChanges}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] text-[var(--ap-danger)]">
          {error}
        </p>
      )}
      {promptDialog}
    </section>
  );
}
