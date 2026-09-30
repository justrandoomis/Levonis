/**
 * THE STATUS STRIP — the first line of Today (merchant platform v2 §3.2):
 * the store's mark and name, one sentence about the clock («مفتوح الآن ·
 * يغلق 9:00 م»), and the switch that pauses or reopens the shop.
 *
 * TWO DIFFERENT «OPEN»S, KEPT APART ON PURPOSE.
 *   · The SWITCH is the merchant's own pause (`merchant_stores.status`,
 *     PATCH /api/merchant/store {open}); the server decides whether a reopen
 *     is allowed (suspension, lapsed PLUS, no delivery coverage) and refuses
 *     with a code this strip renders as a sentence — never the raw message.
 *   · The SENTENCE is the opening HOURS at this instant, computed by the
 *     server in Baghdad time (`open_now`, `next_change_at` on /api/merchant/me,
 *     worker/lib/storeHours.ts). The clock word is re-derived here from the
 *     same pure function once `next_change_at` has passed, so a tab left open
 *     over closing time flips its own word without a fetch.
 */
import { useEffect, useState } from 'react';
import { Store } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { api } from '../../../lib/api';
import type { MerchantStore } from '../../../lib/merchant';
import { baghdadDaysBetween, baghdadWeekday, nextChangePassed, openNow, type OpenNow } from '../../../../worker/lib/storeHours';
import { Switch } from '../../ui/Switch';
import { useToast } from '../../ui/Toast';
import { useWorkspace } from '../shell/context';
import { storeStatus } from '../shell/status';
import { say } from '../shell/strings';
import { fill, useCounterStrings, type CounterLang, type CounterStrings } from './strings';

/** The two hour fields the server adds to the store shape (worker/routes/merchant.ts `storePublicShape`). */
export type StoreHoursState = Pick<MerchantStore, 'business_hours'> & { open_now?: boolean | null; next_change_at?: string | null };

/**
 * «9:00 م» in Baghdad, in the APP's language — never the device's: an Arabic
 * UI on an English-locale phone used to read «يفتح 9:00 PM». Arabic takes the
 * Iraqi locale with Latin digits (the house rule of `dateLocale`); Sorani,
 * which Chromium has no clock data for, reads the 24-hour clock in Latin
 * digits — no meridiem word to borrow from another language. In the two RTL
 * languages the time is wrapped as an isolate (U+2068…U+2069) with a no-break
 * space, so it stays one LTR island and never breaks across lines (§7).
 */
export function baghdadClock(iso: string, lang: CounterLang): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const text = new Date(t).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ar-IQ-u-nu-latn', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Baghdad',
    ...(lang === 'ckb' ? { hourCycle: 'h23' as const } : {}),
  });
  return lang === 'en' ? text : `\u2068${text.replace(/\s+/g, '\u00a0')}\u2069`;
}

/**
 * The open state at `nowMs`: the server's fields, or — once the server's
 * instant has passed on this clock, or an older server sent no verdict — the
 * same rule over the store's own hours. Pure.
 */
export function resolveOpenState(store: StoreHoursState, nowMs: number): OpenNow {
  const state: OpenNow = { open_now: store.open_now ?? null, next_change_at: store.next_change_at ?? null };
  if (store.open_now === undefined || nextChangePassed(state, nowMs)) return openNow(store.business_hours, null, nowMs);
  return state;
}

/** The clock sentence for a store. Pure, for the tests. */
export function openStateSentence(s: CounterStrings, store: StoreHoursState, lang: CounterLang, nowMs: number = Date.now()): string {
  const state = resolveOpenState(store, nowMs);
  if (state.open_now === null) return s.status.byArrangement;
  const next = state.next_change_at;
  if (state.open_now) return next ? fill(s.status.openNow, { time: baghdadClock(next, lang) }) : s.status.openNowNoEnd;
  if (!next) return s.status.closedNowNoNext;
  const at = Date.parse(next);
  const days = baghdadDaysBetween(nowMs, at);
  const day = days <= 0 ? '' : days === 1 ? s.status.tomorrow : s.weekdays[baghdadWeekday(at)];
  return fill(s.status.closedNow, { day, time: baghdadClock(next, lang) });
}

function StoreMark({ store }: { store: MerchantStore }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-raised">
      {store.logoUrl ? <img src={store.logoUrl} alt="" className="h-full w-full object-cover" /> : <Store aria-hidden="true" className="h-4 w-4 text-gold" />}
    </span>
  );
}

/**
 * Re-render just after the next flip, so the word changes on its own. The
 * instant is the RESOLVED one (after a flip it is already the following
 * change), so the timer never spins on a server instant that has passed; a
 * far-off change is re-checked hourly, and a past one no sooner than a minute.
 */
function useClockTick(nextChangeAt: string | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const at = nextChangeAt ? Date.parse(nextChangeAt) : NaN;
    if (!Number.isFinite(at)) return;
    const wait = Math.min(Math.max(at - Date.now() + 500, 60_000), 3_600_000);
    const t = window.setTimeout(() => setTick((n) => n + 1), wait);
    return () => window.clearTimeout(t);
  }, [nextChangeAt, tick]);
  return tick;
}

export default function StatusStrip() {
  const ws = useWorkspace();
  const { lang, loc } = useLanguage();
  const s = useCounterStrings();
  const toast = useToast();
  const status = storeStatus(ws.me);
  const store = ws.store as MerchantStore & StoreHoursState;
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const resolved = resolveOpenState(store, now);
  useClockTick(resolved.next_change_at);

  const checked = store.status === 'active';
  const suspended = status.key === 'suspended';
  const sentence = openStateSentence(s, store, lang as CounterLang, now);

  const flip = async (next: boolean) => {
    setBusy(true);
    try {
      await api.patch('/api/merchant/store', { open: next });
      toast.success(next ? s.status.opened : s.status.pausedToast);
      ws.reloadMe();
      ws.attention.refresh(true);
    } catch (e) {
      // The sentences are loaded on the first refusal, not with Today.
      const { apiRefusal } = await import('../../../lib/refusalStrings');
      toast.error(apiRefusal(e, lang, s.generic.error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lv-surface flex items-center gap-3 p-4" data-status-strip data-open-now={String(resolved.open_now ?? 'unknown')}>
      <StoreMark store={store} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold text-text-primary">{store.name}</p>
        <p className="text-[12.5px] text-text-muted" data-open-sentence>
          {sentence}
        </p>
      </div>
      {/* The switch carries its state word beside it (§3.2 «[◉ مفتوح]», HIG: a
          switch has a visible label); the full sentence stays for the reader. */}
      <Switch
        checked={checked}
        onChange={flip}
        busy={busy}
        disabled={suspended}
        label={
          <span className="text-[13px] font-semibold" data-switch-word>
            {say(loc, status.label)}
            <span className="sr-only"> — {s.status.switchLabel}</span>
          </span>
        }
        description={<span className="sr-only">{suspended ? s.status.switchSuspended : checked ? s.status.switchOn : s.status.switchOff}</span>}
        className="shrink-0 gap-2"
      />
    </section>
  );
}
