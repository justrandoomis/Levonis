/**
 * The small, shared pieces of «التسعير والشحن»: the preview banner, the status
 * chips and the reason list. Presentation only — the words come from
 * strings.ts (and through it, the contracts), the figures from the server.
 */
import React from 'react';
import { AlertTriangle, CircleAlert, Eye, Info, OctagonAlert, ShieldAlert } from 'lucide-react';
import { StatusChip, type Tone } from '../ui/Badge';
import { ErrorState } from '../ui/AsyncStates';
import OwnerCostVerifyCard from '../auth/OwnerCostVerifyCard';
import { ApiError } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import type { Language } from '../../translations';
import type { LegacyValueState, PricingMigrationStatus } from '../../../packages/contracts/src/pricingMigrationLabels';
import { previewOnlyText, reasonText, reasonTone, statusLabel, valueStateLabel, type ReasonTone } from './strings';

/** The six statuses, worst first, as the system's semantic tones (never a seventh colour). */
export const STATUS_TONE: Readonly<Record<PricingMigrationStatus, Tone>> = {
  CONFLICT: 'danger',
  TARGET_PROFIT_REVIEW_REQUIRED: 'warning',
  NEEDS_MANUAL_REVIEW: 'warning',
  WAITING_FOR_SUPPLIER_COST: 'info',
  READY_TO_SWITCH: 'accent',
  READY: 'success',
};

const VALUE_TONE: Readonly<Record<LegacyValueState, Tone>> = {
  MIGRATED: 'success',
  TARGET_PROFIT_UNRESOLVED: 'warning',
  TARGET_PROFIT_REVIEW_REQUIRED: 'warning',
  DIRECT_PREMIUM_REVIEW_REQUIRED: 'warning',
  NOT_APPLICABLE: 'neutral',
  CONFLICT: 'danger',
};

export function MigrationStatusChip({ status, lang, className = '' }: { status: PricingMigrationStatus; lang: Language; className?: string }) {
  return (
    <StatusChip tone={STATUS_TONE[status]} className={className}>
      {statusLabel(status, lang)}
    </StatusChip>
  );
}

export function ValueStateChip({ state, lang }: { state: LegacyValueState; lang: Language }) {
  return <StatusChip tone={VALUE_TONE[state]}>{valueStateLabel(state, lang)}</StatusChip>;
}

/**
 * «معاينة فقط — لا يتغير شيء في المتجر.» — the first thing on the screen, in
 * the contract's own words, with what that means in one more sentence. An
 * info alert, not a warning: nothing is wrong, and nothing can go wrong here.
 */
export function PreviewBanner({ lang, body }: { lang: Language; body: string }) {
  return (
    <div role="note" data-pricing-preview-banner className="lv-alert lv-alert-info flex items-start gap-3">
      <Eye aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-info" />
      <div className="min-w-0">
        <p className="text-[14px] font-bold leading-relaxed text-text-primary">{previewOnlyText(lang)}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-text-secondary">{body}</p>
      </div>
    </div>
  );
}

const REASON_ICON: Readonly<Record<ReasonTone, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>>> = {
  danger: OctagonAlert,
  warning: AlertTriangle,
  info: Info,
  neutral: CircleAlert,
};

const REASON_ICON_CLASS: Readonly<Record<ReasonTone, string>> = {
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
  neutral: 'text-text-muted',
};

export interface ReasonItem {
  code: string;
  /** Already-formatted figures for the label's slots. */
  params?: { method?: string; iqd?: string };
  /** A short prefix: the channel or route the reason is about. */
  where?: string;
  /** A quiet second line, e.g. the channels a readiness code applies to. */
  detail?: string;
}

/**
 * A list of reasons, each with the icon of its weight and the contract's own
 * sentence. The icon is never the only cue: the sentence says what it is.
 */
export function ReasonList({ items, lang, quiet = false }: { items: ReasonItem[]; lang: Language; quiet?: boolean }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-2" data-pricing-reasons>
      {items.map((item, i) => {
        const tone = reasonTone(item.code);
        const Icon = REASON_ICON[tone];
        return (
          <li key={`${item.code}-${i}`} data-reason-code={item.code} className="flex items-start gap-2">
            <Icon aria-hidden="true" className={`mt-[3px] h-4 w-4 shrink-0 ${REASON_ICON_CLASS[tone]}`} />
            <div className="min-w-0">
              <p className={`text-[13px] leading-relaxed ${quiet ? 'text-text-muted' : 'text-text-secondary'}`}>
                {item.where && <span className="font-semibold text-text-primary">{item.where} — </span>}
                {reasonText(item.code, lang, item.params)}
              </p>
              {item.detail && <p className="mt-0.5 text-[12px] leading-relaxed text-text-muted">{item.detail}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A small uppercase-free section label: quieter than a heading, louder than body text. */
export function Eyebrow({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h4 id={id} className="text-[12px] font-bold leading-snug text-text-muted">
      {children}
    </h4>
  );
}

/** An LTR island for a decimal or a measure, tabular, so it never reorders in Arabic. */
export function Figure({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={`whitespace-nowrap tabular-nums ${className}`}>
      {children}
    </bdi>
  );
}

/**
 * A refusal or a failure, said by CODE. The owner's own unverified session
 * (OWNER_EMAIL_UNVERIFIED) gets the card that opens cost, never a dead end;
 * any other refusal says the contract's sentence; a network or server failure
 * offers a retry.
 */
export function PricingFailure({ error, lang, onRetry, fallback }: { error: unknown; lang: Language; onRetry?: () => void; fallback: string }) {
  if (error instanceof ApiError && error.code === 'OWNER_EMAIL_UNVERIFIED') return <OwnerCostVerifyCard />;
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 404) {
    return (
      <div role="alert" data-pricing-refusal={error.code ?? error.status} className="lv-alert lv-alert-danger flex items-start gap-3">
        <ShieldAlert aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
        <p className="text-[14px] leading-relaxed text-text-primary">{apiRefusal(error, lang, fallback)}</p>
      </div>
    );
  }
  return <ErrorState error={error} onRetry={onRetry} compact />;
}
