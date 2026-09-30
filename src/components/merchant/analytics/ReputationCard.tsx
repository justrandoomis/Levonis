/**
 * «سمعتك» — THE MERCHANT'S OWN REPUTATION, WITH ITS EVIDENCE
 * (docs/COMMUNITY_ECOSYSTEM.md §9.6, Reputation V2; `GET /api/merchant/reputation`,
 * worker/routes/merchantReputation.ts — the store owner only, `private, no-store`).
 *
 * The public sees a badge and «لماذا؟»; the merchant sees WHY THEY HAVE IT —
 * the figures of the night it was computed (`evidence`) — and, for every badge
 * they do not hold yet, the rule and how far they are from it («7 من 10»),
 * counted from the same 30- and 90-day windows the nightly run reads. Below,
 * the windows themselves: the usual first reply, the orders completed, the
 * completion rate, the orders they cancelled, the disputes they lost — every
 * figure the server's; a rate over nothing is «—», never 0.
 *
 * `null` from the server means the database is not computing yet: the card
 * says «قيد الحساب», not a row of zeros. An account without a store (404)
 * draws nothing. A lazy chunk of the analytics screen
 * (../shell/sections/AnalyticsSection.tsx): PLUS or not, a merchant's
 * reputation is theirs to read.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { Button } from '../../ui/Button';
import { CardSkeleton } from '../../ui/DashboardSkeletons';
import { BADGE_ICONS } from '../../community/reputation/BadgeChips';
import { BADGE_KEYS, myReputation, type BadgeKey, type MerchantReputation, type OwnBadge, type ReputationWindow } from '../../community/reputation/api';
import { repDate, repLang, reputationStrings, respondsWithin, ruleSentence, withinWords, type RepLang, type ReputationStrings } from '../../community/reputation/strings';
import { DataTable } from './charts';

const pct = (v: number, lang: RepLang) => (lang === 'en' ? `${v}%` : `${v}٪`);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * The figures that earned a badge, as «figure label» pairs — «14 محادثات»;
 * `labelFirst` where the language reads the other way round: «نصف ردودك
 * الأولى خلال ساعة».
 */
export function evidenceFigures(b: OwnBadge, s: ReputationStrings, lang: RepLang): Array<{ figure: string; label: string; labelFirst?: boolean }> {
  const e = b.evidence ?? {};
  switch (b.key) {
    case 'verified_merchant':
      return [{ figure: '', label: s.card.evidence.verified }];
    case 'fast_response':
      return [
        { figure: `${withinWords(n(e.median_within_minutes) || 60, lang)}${lang === 'ckb' ? 'دا' : ''}`, label: s.card.evidence.median, labelFirst: true },
        { figure: String(n(e.threads)), label: s.card.evidence.threads },
      ];
    case 'reliable_seller':
      return [
        { figure: String(n(e.completed)), label: s.card.evidence.completed },
        { figure: pct(n(e.merchant_cancel_percent), lang), label: s.card.evidence.cancel },
        { figure: String(n(e.disputes_lost)), label: s.card.evidence.lost },
      ];
    case 'custom_specialist':
      return [{ figure: String(n(e.custom_completed)), label: s.card.evidence.custom }];
    case 'high_completion':
      return [
        { figure: pct(n(e.completion_percent), lang), label: s.card.evidence.completion },
        { figure: String(n(e.orders)), label: s.card.evidence.orders },
      ];
  }
}

/** How far a badge not held yet is from its rule's count — null when the rule has no count to climb. */
export function progressOf(key: BadgeKey, r: MerchantReputation): { have: number; need: number } | null {
  const rule = r.rules?.[key] ?? {};
  const w30 = r.metrics.window_30;
  const w90 = r.metrics.window_90;
  switch (key) {
    case 'fast_response':
      return { have: w30.first_reply_count, need: n(rule.min_threads) || 10 };
    case 'reliable_seller':
      return { have: w90.orders_completed, need: n(rule.min_completed) || 20 };
    case 'custom_specialist':
      return { have: w90.custom_orders_completed, need: n(rule.min_custom_completed) || 10 };
    case 'high_completion':
      return { have: w90.orders_ended, need: n(rule.min_orders) || 20 };
    default:
      return null;
  }
}

function Figures({ items }: { items: Array<{ figure: string; label: string; labelFirst?: boolean }> }) {
  return (
    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-text-secondary">
      {items.map((it, i) => {
        const figure = it.figure ? <bdi className="font-semibold tabular-nums text-text-primary">{it.figure}</bdi> : null;
        return (
          <span key={i}>
            {it.labelFirst ? (
              <>
                {it.label} {figure}
              </>
            ) : (
              <>
                {figure} {it.label}
              </>
            )}
          </span>
        );
      })}
    </p>
  );
}

function Row({ icon, title, children, muted = false, badge }: { icon: ReactNode; title: string; children: ReactNode; muted?: boolean; badge: BadgeKey }) {
  return (
    <li className="flex items-start gap-3 py-3" data-reputation-badge={badge} data-earned={muted ? 'no' : 'yes'}>
      <span aria-hidden="true" className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-raised ${muted ? 'text-text-muted' : 'text-gold'}`}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-[13.5px] font-bold ${muted ? 'text-text-secondary' : 'text-text-primary'}`}>{title}</p>
        {children}
      </div>
    </li>
  );
}

export function ReputationBody({ data, lang }: { data: MerchantReputation; lang: RepLang }) {
  const s = reputationStrings(lang);
  const held = new Map(data.badges.map((b) => [b.key, b]));
  const earned = BADGE_KEYS.filter((k) => held.has(k));
  const missing = BADGE_KEYS.filter((k) => !held.has(k));
  const windows: Array<[string, ReputationWindow]> = [
    [s.card.window(data.metrics.window_30.window_days || 30), data.metrics.window_30],
    [s.card.window(data.metrics.window_90.window_days || 90), data.metrics.window_90],
  ];
  const minThreads = n(data.rules?.fast_response?.min_threads) || 10;
  const dash = '—';
  return (
    <>
      <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-muted">{s.card.through(repDate(data.through, lang))}</p>

      <div className="mt-3 rounded-xl bg-surface-raised px-3 py-2.5" data-reputation-responds={data.responds_within_minutes ?? 'none'}>
        <p className="text-[11.5px] font-semibold text-text-muted">{s.card.respondsLine}</p>
        <p className="mt-0.5 text-[13px] text-text-primary">
          {data.responds_within_minutes ? respondsWithin(data.responds_within_minutes, lang) : s.card.noResponseLine}
        </p>
      </div>

      {earned.length > 0 ? (
        <>
          <h3 className="mt-4 text-[12.5px] font-semibold text-text-muted">{s.card.earned}</h3>
          <ul className="divide-y divide-border-subtle">
            {earned.map((k) => {
              const Icon = BADGE_ICONS[k];
              const b = held.get(k)!;
              return (
                <Row key={k} badge={k} icon={<Icon className="h-4 w-4" />} title={s.names[k]}>
                  <Figures items={evidenceFigures(b, s, lang)} />
                  {b.since && <p className="mt-0.5 text-[11.5px] text-text-muted">{s.since(repDate(b.since, lang))}</p>}
                </Row>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="mt-4 text-[13px] text-text-secondary" data-reputation-none>
          {s.card.none}
        </p>
      )}

      {missing.length > 0 && (
        <>
          <h3 className="mt-4 text-[12.5px] font-semibold text-text-muted">{s.card.notEarned}</h3>
          <ul className="divide-y divide-border-subtle">
            {missing.map((k) => {
              const Icon = BADGE_ICONS[k];
              const p = progressOf(k, data);
              return (
                <Row key={k} badge={k} muted icon={<Icon className="h-4 w-4" />} title={s.names[k]}>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">{ruleSentence(k, data.rules?.[k], lang)}</p>
                  {/* How far, while the count is what is missing; once it is met the rule above says what else is. */}
                  {p && p.have < p.need && (
                    <p className="mt-1 text-[12px] text-text-muted" data-reputation-progress={`${p.have}/${p.need}`}>
                      <bdi className="font-semibold tabular-nums text-text-primary">{s.card.progress(p.have, p.need)}</bdi>
                    </p>
                  )}
                </Row>
              );
            })}
          </ul>
        </>
      )}

      <div className="mt-4" data-reputation-windows>
        <DataTable
          caption={s.card.title}
          columns={[
            { label: '' },
            { label: <span className="whitespace-nowrap">{windows[0][0]}</span>, numeric: true },
            { label: <span className="whitespace-nowrap">{windows[1][0]}</span>, numeric: true },
          ]}
          rows={[
            [s.card.median, ...windows.map(([, w]) => (w.median_within_minutes ? withinWords(w.median_within_minutes, lang) : dash))],
            [s.card.firstReplies, ...windows.map(([, w]) => (w.first_reply_count < minThreads ? `${w.first_reply_count} · ${s.card.under(minThreads)}` : String(w.first_reply_count)))],
            [s.card.completed, ...windows.map(([, w]) => String(w.orders_completed))],
            [s.card.customCompleted, ...windows.map(([, w]) => String(w.custom_orders_completed))],
            [s.card.completion, ...windows.map(([, w]) => (w.completion_percent === null ? dash : pct(w.completion_percent, lang)))],
            [s.card.cancelled, ...windows.map(([, w]) => (w.merchant_cancel_percent === null ? dash : pct(w.merchant_cancel_percent, lang)))],
            [s.card.disputesLost, ...windows.map(([, w]) => String(w.disputes_lost))],
          ]}
        />
      </div>
    </>
  );
}

export default function ReputationCard() {
  const { lang } = useLanguage();
  const l = repLang(lang);
  const s = reputationStrings(l);
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; data: MerchantReputation | null } | { kind: 'none' } | { kind: 'error' }>({ kind: 'loading' });

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    myReputation({ mascot: 'silent' })
      .then((data) => setState({ kind: 'ready', data }))
      // No store behind this account: there is no reputation to show, and nothing to say about it.
      .catch((e: unknown) => setState(e instanceof ApiError && (e.status === 404 || e.status === 403) ? { kind: 'none' } : { kind: 'error' }));
  }, []);
  useEffect(load, [load]);

  if (state.kind === 'none') return null;
  if (state.kind === 'loading') return <CardSkeleton lines={4} />;
  return (
    <section aria-labelledby="reputation-title" className="lv-surface p-4" data-reputation-card={state.kind === 'ready' ? (state.data ? 'ready' : 'calculating') : 'error'}>
      <h2 id="reputation-title" className="text-[15px] font-bold text-text-primary">
        {s.card.title}
      </h2>
      {state.kind === 'error' ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2" role="alert">
          <p className="text-[13px] text-text-secondary">{s.card.failed}</p>
          <Button variant="secondary" size="sm" onClick={load}>
            {s.card.retry}
          </Button>
        </div>
      ) : state.data ? (
        <ReputationBody data={state.data} lang={l} />
      ) : (
        <p className="mt-2 text-[13px] text-text-secondary">{s.card.calculating}</p>
      )}
    </section>
  );
}
