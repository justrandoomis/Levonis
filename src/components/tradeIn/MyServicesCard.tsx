/**
 * «خدماتي» on the profile (spec §10.2): one card, after «طلباتي», members only — «أجهزتي والضمان»
 * (the open cases) and «الاستبدال» (the ONE next thing a trade-in asks of the customer, with its
 * date), from GET /api/me/services. Price protection and the perks join when their phases land
 * (the server answers `null` for them now). A failed read still shows both doors, without a line.
 * Its own lazy chunk: the profile carries only the import line.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Repeat, ShieldCheck } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api } from '../../lib/api';
import type { ServicesSummary } from '../../../packages/contracts/src/myDevices';
import { useT } from './useT';
import { dateText } from './model';
import { countText } from './copy';

export default function MyServicesCard() {
  const { t } = useT();
  const { dir, lang } = useLanguage();
  const [s, setS] = useState<ServicesSummary | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .get<ServicesSummary & { success?: boolean }>('/api/me/services', {
        mascot: 'silent',
      })
      .then((d) => alive && setS(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  const devicesLine = s
    ? s.devices.open_cases > 0
      ? countText('services.openCases', s.devices.open_cases, lang)
      : s.devices.count > 0
        ? countText('services.devicesCount', s.devices.count, lang)
        : t('services.noCases')
    : '';
  const tin = s?.trade_in;
  const date = tin?.next_at ? dateText(tin.next_at, lang) : '';
  const tradeLine = !tin
    ? ''
    : tin.next_action === 'hand_in'
      ? date
        ? t('next.handIn', { date })
        : t('next.handInNow')
      : tin.next_action === 'decide'
        ? t('next.decide')
        : tin.next_action === 'pay'
          ? t('next.pay')
          : tin.next_action === 'collect_device'
            ? t('next.collect')
            : tin.next_action === 'reissued'
              ? t('next.reissued', { date })
              : tin.open > 0
                ? countText('services.openCases', tin.open, lang)
                : t('services.nothing');

  const rows = [
    {
      to: '/warranty',
      icon: ShieldCheck,
      title: t('services.devices'),
      line: devicesLine,
      key: 'devices',
      urgent: false,
    },
    {
      to: '/trade-in',
      icon: Repeat,
      title: t('services.tradeIn'),
      line: tradeLine,
      key: 'trade_in',
      urgent: !!tin?.next_action,
    },
  ];

  return (
    <section className="lv-surface mb-3 p-3 text-text-primary" aria-labelledby="profile-services" data-profile-services>
      <h2 id="profile-services" className="mb-2 text-[14px] font-bold">
        {t('services.title')}
      </h2>
      <ul className="divide-y divide-border-subtle">
        {rows.map((r) => (
          <li key={r.key}>
            <Link
              to={r.to}
              data-services-row={r.key}
              className="flex min-h-[56px] items-center gap-3 rounded-lg px-1 py-2 transition-colors hover:bg-white/[0.06] active:bg-[var(--clay-well-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span className="lv-well flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
                <r.icon className="h-[18px] w-[18px] text-gold" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-bold leading-5">{r.title}</span>
                {r.line ? <span className={`block truncate text-[12px] ${r.urgent ? 'font-semibold text-gold' : 'text-text-muted'}`}>{r.line}</span> : null}
              </span>
              <Chevron className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
