/**
 * ONE GLANCE AT A DEVICE — phase 8 (DECISIONS row 364): what the customer bought, what holds today and until
 * when, Levo Care's window, the inspection and the free-return fact. Drawn the same way on the units table, the
 * order screen's warranty section and the serial page (the words live in ./deskStrings).
 *
 * A device whose payload carries no `cover` (an older server) draws nothing: the caller keeps what it showed.
 */
import React from 'react';
import { formatMoney } from '../../lib/money';
import { dateLocale } from '../orders/format';
import {
  DESK, FREE_RETURN_DAYS, TONE_CLASS, boughtText, coverChip, deskLang, todayText,
  type DeskCare, type DeskCover, type DeskServices,
} from './deskStrings';

export function deskDate(iso: string | null, lang: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(dateLocale(lang), { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Before delivery, and for FREE_RETURN_DAYS after it; a caller that sends no date always shows the fact. */
function returnFactMatters(deliveredAt: string | null | undefined): boolean {
  if (deliveredAt === undefined || deliveredAt === null) return true;
  const ms = Date.parse(deliveredAt);
  return !Number.isFinite(ms) || Date.now() - ms <= FREE_RETURN_DAYS * 86_400_000;
}

export function CoverChip({ cover, lang }: { cover: DeskCover; lang: string }) {
  const chip = coverChip(DESK[deskLang(lang)], cover);
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap ${TONE_CLASS[chip.tone]}`}
      data-cover-chip={cover.now}
      data-cover-warranty={cover.warranty}
    >
      {chip.label}
    </span>
  );
}

export default function UnitCoverBlock({
  services,
  care,
  cover,
  lang,
  remainingDays = null,
  deliveredAt,
  chip = true,
}: {
  services: DeskServices | null;
  care: DeskCare | null;
  cover: DeskCover | null | undefined;
  lang: string;
  remainingDays?: number | null;
  /** The free-return fact is shown only while it can matter: before delivery and in its first days. */
  deliveredAt?: string | null;
  chip?: boolean;
}) {
  if (!cover) return null;
  const t = DESK[deskLang(lang)];
  const date = (iso: string | null) => deskDate(iso, lang);
  const left = care && care.state === 'active' ? t.careLeft(care.claims_left, care.benefit_left_iqd !== null ? formatMoney(care.benefit_left_iqd, deskLang(lang)) : null) : '';
  return (
    <div className="space-y-1 text-[12px] leading-relaxed min-w-0" data-unit-cover={cover.now}>
      {chip && <CoverChip cover={cover} lang={lang} />}
      <p className="text-text-secondary" data-unit-bought>
        <span className="text-text-muted">{t.bought}: </span>
        <span className="text-text-primary font-bold">{boughtText(t, services, cover)}</span>
      </p>
      <p className="text-text-secondary" data-unit-today>
        <span className="text-text-muted">{t.today}: </span>
        <span className="text-text-primary">{todayText(t, cover, care, date)}</span>
        {cover.now === 'warranty' && remainingDays !== null && <span className="text-text-muted"> · {t.daysLeft(remainingDays)}</span>}
      </p>
      {care && cover.now === 'warranty' && care.care_only_from && care.end_at && care.state !== 'closed' && (
        <p className="text-text-muted" data-unit-care-after>
          {t.careAfter(date(care.care_only_from), date(care.end_at))}
        </p>
      )}
      {care && care.state === 'terms_missing' && <p className="text-warning">{t.careTermsMissing}</p>}
      {left && <p className="text-text-muted tabular-nums" data-unit-care-left>{left}</p>}
      {cover.goodwill && cover.months !== null && cover.sold_months !== null && (
        <p className="text-text-secondary" data-unit-goodwill>{t.goodwill(cover.months, cover.sold_months)}</p>
      )}
      {services && services.inspection !== 'none' && (
        <p className={services.inspection === 'done' ? 'text-text-muted' : 'text-warning'} data-unit-inspection={services.inspection}>
          {services.inspection === 'done' ? t.inspectionDone : t.inspectionPending}
        </p>
      )}
      {services && returnFactMatters(deliveredAt) && (
        <p className="text-text-muted" data-unit-free-return={services.free_return ? 'yes' : 'no'} title={t.returnInfo}>
          {services.free_return ? t.freeReturn : t.noFreeReturn}
        </p>
      )}
    </div>
  );
}
