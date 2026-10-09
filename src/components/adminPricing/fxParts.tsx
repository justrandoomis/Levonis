/**
 * The exchange-rate panel's shared pieces (FX programme plan §12): how an
 * owner act is sent and answered, how a refusal is said, how a date and a
 * rate are written. Presentation and wiring only — every figure is the
 * server's text, formatted for reading; nothing here computes a rate.
 */
import React, { useCallback, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, LogIn, ShieldAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import type { Tone } from '../ui/Badge';
import { ApiError } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import { useOptionalAuth } from '../../AuthContext';
import type { Language } from '../../translations';
import type { FxPairId, FxRatesAnswer, FxRefreshReport, FxStatus } from './api';
import type { FxRefreshOutcome, FxStrings } from './fxStrings';
import { fxCount, shownFigure } from './format';
import { Figure } from './parts';

/** The five statuses as the system's semantic tones. */
export const FX_STATUS_TONE: Readonly<Record<FxStatus, Tone>> = {
  OK: 'success',
  REVIEW_REQUIRED: 'warning',
  FAILED: 'danger',
  STALE: 'warning',
  NOT_CONFIGURED: 'neutral',
};

/** The two currencies a pair reads in: «1 USD = … د.ع», «1 EUR = … USD». */
export const PAIR_UNITS: Readonly<Record<FxPairId, { from: string; to: 'IQD' | 'USD' }>> = {
  USD_IQD: { from: 'USD', to: 'IQD' },
  EUR_USD: { from: 'EUR', to: 'USD' },
  CNY_USD: { from: 'CNY', to: 'USD' },
};

/**
 * How many decimals a pair's rate is SHOWN with (UX review #1): CNY/USD
 * carries ten (the server rounds C up at the 10th place) — shown to six,
 * marked «≈», the exact text in the tooltip. USD/IQD (≤ 4) and EUR/USD (the
 * ECB's 4) are shown as they are. A figure sent back to the server (a manual
 * rate, «استخدم … سعرًا يدويًا») is always the exact text.
 */
export const RATE_SHOWN_PLACES: Readonly<Record<FxPairId, number | null>> = { USD_IQD: null, EUR_USD: null, CNY_USD: 6 };
/** EUR and CNY in dinars (E × U, C × U) are read in whole dinars. */
export const DERIVED_IQD_SHOWN_PLACES = 0;

/**
 * A figure of the panel, as shown: Latin digits, rounded to `places` when
 * given, «≈» and the exact text in the tooltip when it was. The «≈» stands
 * OUTSIDE the left-to-right island, in the reading direction, so a unit after
 * the figure («≈ 233 د.ع») never reads as «233 ≈ د.ع» in Arabic or Sorani.
 */
export function FxFigure({ rate, places = null, className = '' }: { rate: string; places?: number | null; className?: string }) {
  const f = shownFigure(rate, places);
  if (!f.approx) return <Figure className={className}>{f.text}</Figure>;
  return (
    <span className="whitespace-nowrap">
      ≈{' '}
      <Figure className={className} title={f.exact}>
        {f.text}
      </Figure>
    </span>
  );
}

/**
 * «1 USD = 1,703.9167 IQD» — the rate as the server wrote it, in Latin digits
 * (`fxFigure`, UX review #1). Both sides are currency CODES: inside the
 * left-to-right island an Arabic unit («د.ع») would reorder itself in front of
 * the figure. A rate shown rounded reads «1 CNY ≈ 0.139202 USD», the exact
 * text in the tooltip.
 */
export function RateLine({ pair, rate, className = '' }: { pair: FxPairId; rate: string; lang?: Language; className?: string }) {
  const u = PAIR_UNITS[pair];
  const f = shownFigure(rate, RATE_SHOWN_PLACES[pair]);
  return (
    <Figure className={className} title={f.approx ? `1 ${u.from} = ${f.exact} ${u.to}` : undefined}>
      1 {u.from} {f.approx ? '≈' : '='} {f.text} {u.to}
    </Figure>
  );
}

/** The Gregorian months as Sorani writes them (Intl carries no Sorani calendar names in every browser). */
const CKB_MONTHS = ['کانوونی دووەم', 'شوبات', 'ئازار', 'نیسان', 'ئایار', 'حوزەیران', 'تەممووز', 'ئاب', 'ئەیلوول', 'تشرینی یەکەم', 'تشرینی دووەم', 'کانوونی یەکەم'];

/**
 * A date and time for reading, in the reader's language and the SAME Latin
 * digits as every figure of the panel (`fxFigure`, UX review #1, #10), so a
 * card never mixes two digit systems. A 24-hour clock (no «ص/م» to wrap onto
 * a line of its own) and no year when it is this year.
 */
export function fxDate(iso: string | null | undefined, lang: Language): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const thisYear = d.getFullYear() === new Date().getFullYear();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (lang === 'ckb') return `${d.getDate()}ی ${CKB_MONTHS[d.getMonth()]}${thisYear ? '' : ` ${d.getFullYear()}`}، ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(thisYear ? {} : { year: 'numeric' }) };
  if (lang === 'en') return new Intl.DateTimeFormat('en-GB', opts).format(d);
  try {
    return new Intl.DateTimeFormat('ar-IQ-u-nu-latn', opts).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** The hours of a 24-hour rule, written as the panel writes every number. */
export const FX_DAY_HOURS = fxCount(24);
/** The large-change line (§7.8), as the panel writes it. */
export const FX_LARGE_CHANGE_PCT = fxCount(15);

/** A percentage for reading: the server's text cut to two decimals (never rounded through a float), trailing zeros dropped. */
export function pctText(text: string | null | undefined): string {
  if (!text) return '';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return text;
  const frac = (m[3] ?? '').slice(0, 2).replace(/0+$/, '');
  return `${m[1]}${m[2]}${frac ? `.${frac}` : ''}`;
}

/**
 * A refusal in the owner's language, by code. The fresh sign-in is said as
 * the panel says it; a stale panel (409 PRICING_CHANGED) is told it was
 * reloaded — not P1's «export the file again» (UX review #5).
 */
export function fxRefusalText(error: unknown, lang: Language, s: FxStrings): string {
  if (error instanceof ApiError && error.code === 'REAUTH_REQUIRED') return s.reauth;
  if (error instanceof ApiError && error.code === 'PRICING_CHANGED') return s.panelChanged;
  return apiRefusal(error, lang, s.loadFailed);
}

export interface FxMessageState {
  tone: 'success' | 'warning' | 'danger';
  text: string;
  /** A large change was refused for want of the explicit confirmation: send it again with it. */
  confirmLarge?: () => void;
  /** The act needs a fresh sign-in: offer the way through (UX review #2). */
  reauth?: boolean;
}

/**
 * What «تحديث الآن» found, in the owner's words (UX review #4) — from the
 * server's report, never a bare «تم الحفظ». Each outcome said once, the most
 * important first: a value waiting for review, a value applied, a fetch that
 * failed, today's limit, another run in progress, a manual pair observed, or
 * checked and unchanged.
 */
export function refreshMessage(report: FxRefreshReport | undefined, s: FxStrings): FxMessageState {
  const said = new Set<FxRefreshOutcome>();
  for (const c of report?.checked ?? []) {
    if (c.result === 'REVIEW_HELD') said.add('held');
    else if (c.result === 'APPLIED') said.add('applied');
    else if (c.result === 'FAILED' || c.result === 'STALE' || c.result === 'INVALID' || c.result === 'NOT_CONFIGURED') said.add('failed');
    else if (c.result === 'DEFERRED' && c.code === 'PROVIDER_BUDGET') said.add('limit');
    // The 24-hour guard could not read its window: nothing applied, and the owner is told so (owner decision 11).
    else if (c.result === 'DEFERRED' && c.code === 'FX_GUARD_UNREAD') said.add('unverified');
    else if (c.result === 'OBSERVED') said.add('observed');
    else said.add('unchanged');
  }
  if ((report?.budget_deferred ?? []).length) said.add('limit');
  if ((report?.lease_held ?? []).length) said.add('busy');
  if (said.size === 0) said.add('unchanged');
  const order: FxRefreshOutcome[] = ['held', 'applied', 'failed', 'unverified', 'limit', 'busy', 'observed', 'unchanged'];
  const outcomes = order.filter((o) => said.has(o) && !(o === 'unchanged' && said.size > 1));
  const warn = outcomes.some((o) => o === 'held' || o === 'failed' || o === 'unverified' || o === 'limit' || o === 'busy');
  return { tone: warn ? 'warning' : 'success', text: outcomes.map((o) => s.refreshOutcome[o]).join(' ') };
}

/** The pricing tab's own address: a fresh sign-in comes back to it. */
export const PRICING_TAB_PATH = '/admin?tab=pricing';

/**
 * «سجّل الدخول مجددًا»: sign this session out, then open the sign-in page
 * with the way back to the pricing tab (`?next=` is sanitised by Auth.tsx to
 * a same-origin path). The session must end first — the sign-in page sends a
 * signed-in visitor straight on, and only a NEW sign-in is fresh.
 */
export function useSignInAgain(): () => Promise<void> {
  const auth = useOptionalAuth();
  return useCallback(async () => {
    try {
      await auth?.logout();
    } finally {
      window.location.assign(`/auth?next=${encodeURIComponent(PRICING_TAB_PATH)}`);
    }
  }, [auth]);
}

/**
 * ONE OWNER ACT AT A TIME, ANSWERED WHERE IT WAS ASKED. Every act answers
 * with the whole rates body, which replaces the panel's copy; a refusal is
 * said beside the control that sent it. A stale panel (409 PRICING_CHANGED:
 * another act moved the pair's owner version) reloads itself. A move above
 * 15% is refused once for want of `confirm_large_change`; the message then
 * offers the explicit confirmation, which sends the same act again with it.
 */
export function useFxAct(opts: { lang: Language; s: FxStrings; onAnswer: (answer: FxRatesAnswer) => void; onStale: () => void }) {
  const { lang, s, onAnswer, onStale } = opts;
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<FxMessageState | null>(null);
  const inFlight = useRef(false);

  /**
   * `describe` says what the answer means when «تم الحفظ» would not (the
   * refresh report, UX review #4). `confirmLarge` is the second send of an
   * act the owner explicitly confirmed.
   */
  const run = useCallback(
    async (
      key: string,
      call: (confirmLarge: boolean) => Promise<FxRatesAnswer>,
      describe?: (answer: FxRatesAnswer) => FxMessageState,
      confirmLarge = false
    ): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(key);
      setMessage(null);
      try {
        const answer = await call(confirmLarge);
        onAnswer(answer);
        setMessage(describe ? describe(answer) : { tone: 'success', text: s.saved });
        return true;
      } catch (e) {
        const code = e instanceof ApiError ? e.code : null;
        if (code === 'PRICING_LARGE_CHANGE_CONFIRM' && !confirmLarge) {
          setMessage({ tone: 'warning', text: s.largeChange(FX_LARGE_CHANGE_PCT), confirmLarge: () => void run(key, call, describe, true) });
        } else {
          if (code === 'PRICING_CHANGED') onStale();
          setMessage({ tone: 'danger', text: fxRefusalText(e, lang, s), reauth: code === 'REAUTH_REQUIRED' });
        }
        return false;
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
    },
    [lang, s, onAnswer, onStale]
  );

  return { busy, message, run, clear: useCallback(() => setMessage(null), []) };
}

/**
 * The answer to an act: announced, beside the act, with the large-change
 * confirmation when it is needed — and, when the act needs a fresh sign-in,
 * the button that signs in again and comes back here (UX review #2).
 */
export function FxMessage({ message, s }: { message: FxMessageState | null; s: FxStrings }) {
  const signInAgain = useSignInAgain();
  if (!message) return null;
  const Icon = message.tone === 'success' ? CheckCircle2 : message.tone === 'warning' ? AlertTriangle : ShieldAlert;
  const color = message.tone === 'success' ? 'text-success' : message.tone === 'warning' ? 'text-warning' : 'text-danger';
  return (
    <div
      role={message.tone === 'success' ? 'status' : 'alert'}
      data-fx-message={message.tone}
      className={`mt-3 flex items-start gap-2 text-[13px] leading-relaxed ${message.tone === 'success' ? 'text-text-secondary' : 'lv-alert lv-alert-' + message.tone + ' text-text-primary'}`}
    >
      <Icon aria-hidden="true" className={`mt-[2px] h-4 w-4 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1">
        <p>{message.text}</p>
        {message.confirmLarge && (
          <Button size="sm" variant="secondary" className="mt-2" onClick={message.confirmLarge} data-fx-confirm-large>
            {s.largeConfirm}
          </Button>
        )}
        {message.reauth && (
          <Button size="sm" variant="primary" className="mt-2" icon={<LogIn aria-hidden="true" className="h-4 w-4 rtl:-scale-x-100" />} onClick={signInAgain} data-fx-sign-in-again>
            {s.signInAgain}
          </Button>
        )}
      </div>
    </div>
  );
}

/** One fact of a card: a quiet label over the server's figure (or «غير معروف»). */
export function Fact({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? 'col-span-2' : ''}`}>
      <dt className="text-[12px] leading-snug text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-[13.5px] font-semibold leading-snug text-text-primary">{children}</dd>
    </div>
  );
}
