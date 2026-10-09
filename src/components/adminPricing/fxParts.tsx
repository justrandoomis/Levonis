/**
 * The exchange-rate panel's shared pieces (FX programme plan §12): how an
 * owner act is sent and answered, how a refusal is said, how a date and a
 * rate are written. Presentation and wiring only — every figure is the
 * server's text, formatted for reading; nothing here computes a rate.
 */
import React, { useCallback, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import type { Tone } from '../ui/Badge';
import { ApiError } from '../../lib/api';
import { apiRefusal } from '../../lib/refusalStrings';
import type { Language } from '../../translations';
import type { FxPairId, FxRatesAnswer, FxStatus } from './api';
import type { FxStrings } from './fxStrings';
import { localizeDigits, readDecimal } from './format';
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
 * «1 USD = 1,703.9167 IQD» — the rate as the server wrote it, in the reader's
 * digits. Both sides are currency CODES: inside the left-to-right island an
 * Arabic unit («د.ع») beside Arabic-Indic digits would reorder itself in front
 * of the figure.
 */
export function RateLine({ pair, rate, lang, className = '' }: { pair: FxPairId; rate: string; lang: Language; className?: string }) {
  const u = PAIR_UNITS[pair];
  return (
    <Figure className={className}>
      {readDecimal('1', lang)} {u.from} = {readDecimal(rate, lang)} {u.to}
    </Figure>
  );
}

/** The Gregorian months as Sorani writes them (Intl carries no Sorani calendar names in every browser). */
const CKB_MONTHS = ['کانوونی دووەم', 'شوبات', 'ئازار', 'نیسان', 'ئایار', 'حوزەیران', 'تەممووز', 'ئاب', 'ئەیلوول', 'تشرینی یەکەم', 'تشرینی دووەم', 'کانوونی یەکەم'];

/**
 * A date and time for reading, in the reader's language and the SAME digits
 * as the figures beside it (`readDecimal` writes the system's digits outside
 * English), so a card never mixes two digit systems. A 24-hour clock (no
 * «ص/م» to wrap onto a line of its own) and no year when it is this year.
 */
export function fxDate(iso: string | null | undefined, lang: Language): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const thisYear = d.getFullYear() === new Date().getFullYear();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (lang === 'ckb') {
    const text = `${d.getDate()}ی ${CKB_MONTHS[d.getMonth()]}${thisYear ? '' : ` ${d.getFullYear()}`}، ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return localizeDigits(text.replace(/,/g, ''), lang);
  }
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(thisYear ? {} : { year: 'numeric' }) };
  if (lang === 'en') return new Intl.DateTimeFormat('en-GB', opts).format(d);
  let nu = 'latn';
  try {
    nu = new Intl.NumberFormat().resolvedOptions().numberingSystem || 'latn';
  } catch {
    /* keep Latin */
  }
  try {
    return new Intl.DateTimeFormat(`ar-IQ-u-nu-${nu}`, opts).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** A percentage for reading: the server's text cut to two decimals (never rounded through a float), trailing zeros dropped. */
export function pctText(text: string | null | undefined): string {
  if (!text) return '';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return text;
  const frac = (m[3] ?? '').slice(0, 2).replace(/0+$/, '');
  return `${m[1]}${m[2]}${frac ? `.${frac}` : ''}`;
}

/** A refusal in the owner's language, by code; the fresh sign-in is said as the panel says it. */
export function fxRefusalText(error: unknown, lang: Language, s: FxStrings): string {
  if (error instanceof ApiError && error.code === 'REAUTH_REQUIRED') return s.reauth;
  return apiRefusal(error, lang, s.loadFailed);
}

export interface FxMessageState {
  tone: 'success' | 'warning' | 'danger';
  text: string;
  /** A large change was refused for want of the explicit confirmation: send it again with it. */
  confirmLarge?: () => void;
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

  const run = useCallback(
    async (key: string, call: (confirmLarge: boolean) => Promise<FxRatesAnswer>, confirmLarge = false): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(key);
      setMessage(null);
      try {
        onAnswer(await call(confirmLarge));
        setMessage({ tone: 'success', text: s.saved });
        return true;
      } catch (e) {
        const code = e instanceof ApiError ? e.code : null;
        if (code === 'PRICING_LARGE_CHANGE_CONFIRM' && !confirmLarge) {
          setMessage({ tone: 'warning', text: s.largeChange, confirmLarge: () => void run(key, call, true) });
        } else {
          if (code === 'PRICING_CHANGED') onStale();
          setMessage({ tone: 'danger', text: fxRefusalText(e, lang, s) });
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

/** The answer to an act: announced, beside the act, with the large-change confirmation when it is needed. */
export function FxMessage({ message, s }: { message: FxMessageState | null; s: FxStrings }) {
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
