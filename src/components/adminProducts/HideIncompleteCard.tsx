/**
 * «إخفاء المنتجات الناقصة عن الزبائن» — THE OWNER'S SWITCH ON THE PRODUCTS PAGE
 * (owner brief 2026-10-10; worker/routes/adminCompleteness.ts).
 *
 * The verified owner alone sees it (the server refuses everyone else with
 * OWNER_ONLY, and an unverified owner with OWNER_EMAIL_UNVERIFIED — the card
 * then simply does not draw). It SHIPS OFF: before turning it on the owner
 * reads how many products it hides and how many bundles that stops, and the
 * confirmation names that number; the server refuses the switch when the
 * number moved in between (HIDE_COUNT_CHANGED) or when a product is not
 * checked yet (COMPLETENESS_NOT_READY — «تحديث العدّ» checks them, 25 a call).
 *
 * Every string is Arabic, English and Sorani (COMPLETENESS_UI).
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, EyeOff, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { contractRefusal, refusalLang } from '../../lib/refusalStrings';
import { COMPLETENESS_UI, fill, tri } from './completeness';
import * as T from './theme';

export interface HideSummary {
  enabled: boolean;
  since: string | null;
  total_ordinary: number;
  evaluated: number;
  stale: number;
  would_hide: number;
  held: number;
  bundles_affected: number;
  sample: Array<{ id: string; name_ar: string; name_en: string; missing_count: number }>;
}

export default function HideIncompleteCard({ lang, onShowIncomplete, onChanged }: { lang: string; onShowIncomplete: () => void; onChanged?: () => void }) {
  const [summary, setSummary] = useState<HideSummary | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<'recount' | 'toggle' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = (x: { ar: string; en: string; ckb: string }) => tri(x, lang);

  const load = useCallback(async () => {
    try {
      // `installed: false` (a database without migration 0184): the card stays away.
      const r = await api.get<{ installed?: boolean; summary: HideSummary | null }>('/api/admin/products-v2/completeness/summary');
      if (r.installed === false || !r.summary) setHidden(true);
      else setSummary(r.summary);
    } catch (e) {
      // Not the verified owner, or no 0184 yet: the card does not draw.
      if (e instanceof ApiError && (e.status === 403 || e.status === 503 || e.status === 401)) setHidden(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const failure = (e: unknown) =>
    setErr(e instanceof ApiError ? contractRefusal(e, refusalLang(lang), e.message) || t(COMPLETENESS_UI.failed) : t(COMPLETENESS_UI.failed));

  const recount = async () => {
    setBusy('recount');
    setErr(null);
    try {
      // 25 products a call, until none is left unchecked (bounded: 40 calls).
      for (let i = 0; i < 40; i++) {
        const r = await api.post<{ stale_left: number; summary: HideSummary }>('/api/admin/products-v2/completeness/refresh', {});
        setSummary(r.summary);
        if (r.stale_left <= 0) break;
      }
      onChanged?.();
    } catch (e) {
      failure(e);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (enabled: boolean) => {
    if (!summary) return;
    setBusy('toggle');
    setErr(null);
    try {
      const r = await api.put<{ summary: HideSummary }>('/api/admin/products-v2/completeness/hide', {
        enabled,
        ...(enabled ? { expected_count: summary.would_hide } : {}),
      });
      setSummary(r.summary);
      setConfirming(false);
      onChanged?.();
    } catch (e) {
      // HIDE_COUNT_CHANGED / COMPLETENESS_NOT_READY carry the fresh summary: show it, ask again.
      const fresh = e instanceof ApiError ? (e.details as { summary?: HideSummary } | undefined)?.summary : undefined;
      if (fresh) setSummary(fresh);
      failure(e);
    } finally {
      setBusy(null);
    }
  };

  if (hidden || !summary) return null;
  const on = summary.enabled;
  return (
    <section className={`${T.surface} p-4 mb-5 min-w-0`} aria-labelledby="hide-incomplete-title" data-hide-incomplete={on ? 'on' : 'off'}>
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <EyeOff className="w-4 h-4 shrink-0 text-[var(--ap-danger)]" aria-hidden="true" />
        <h3 id="hide-incomplete-title" className="text-[14px] font-bold text-[var(--ap-text-1)] min-w-0 flex-1">
          {t(COMPLETENESS_UI.switchTitle)}
        </h3>
        <span
          className={`${T.badgeBase} ${on ? T.badge.hidden : T.badge.draft}`}
          data-hide-state={on ? 'on' : 'off'}
        >
          {on ? t(COMPLETENESS_UI.switchOn) : t(COMPLETENESS_UI.switchOff)}
        </span>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--ap-text-2)]">{t(COMPLETENESS_UI.switchExplain)}</p>
      <p className="mt-2 text-[13px] font-semibold text-[var(--ap-text-1)]" aria-live="polite">
        {on
          ? fill(t(COMPLETENESS_UI.hiddenNow), { n: summary.held })
          : fill(t(COMPLETENESS_UI.willHide), { n: summary.would_hide, m: summary.bundles_affected })}
      </p>
      {summary.stale > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-[var(--ap-warning)]">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          {fill(t(COMPLETENESS_UI.stale), { n: summary.stale })}
        </p>
      )}
      {err && (
        <p className="mt-2 text-[12px] text-[var(--ap-danger)]" role="alert">
          {err}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={T.btnSecondary} onClick={() => void recount()} disabled={busy !== null} data-hide-recount>
          <RefreshCw className={`w-3.5 h-3.5 ${busy === 'recount' ? 'animate-spin' : ''}`} aria-hidden="true" />
          {busy === 'recount' ? t(COMPLETENESS_UI.recounting) : t(COMPLETENESS_UI.recount)}
        </button>
        {(summary.would_hide > 0 || summary.held > 0) && (
          <button type="button" className={T.btnGhost} onClick={onShowIncomplete} data-hide-show-list>
            {t(COMPLETENESS_UI.showList)}
          </button>
        )}
        {on ? (
          <button type="button" className={T.btnSecondary} onClick={() => void toggle(false)} disabled={busy !== null} data-hide-off>
            {t(COMPLETENESS_UI.turnOff)}
          </button>
        ) : confirming ? (
          <button
            type="button"
            className={T.btnDanger}
            onClick={() => void toggle(true)}
            disabled={busy !== null || summary.stale > 0}
            data-hide-confirm
          >
            {fill(t(COMPLETENESS_UI.confirmOn), { n: summary.would_hide })}
          </button>
        ) : (
          <button type="button" className={T.btnPrimary} onClick={() => setConfirming(true)} disabled={busy !== null || summary.stale > 0} data-hide-on>
            {t(COMPLETENESS_UI.turnOn)}
          </button>
        )}
      </div>
    </section>
  );
}

/** «ناقص N» and «مخفي عن الزبائن» in the products list's own theme tokens (light and dark). */
export function ListMissingBadge({ n, held, lang }: { n: number | null | undefined; held?: boolean; lang: string }) {
  const count = typeof n === 'number' ? n : 0;
  if (count <= 0 && !held) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {count > 0 && (
        <span
          className={`${T.badgeBase} ${T.badge.hidden}`}
          data-missing-badge={count}
          title={fill(tri(COMPLETENESS_UI.badgeLabel, lang), { n: count })}
        >
          <AlertTriangle className="w-3 h-3" aria-hidden="true" />
          <span aria-hidden="true">{fill(tri(COMPLETENESS_UI.badge, lang), { n: count })}</span>
          <span className="sr-only">{fill(tri(COMPLETENESS_UI.badgeLabel, lang), { n: count })}</span>
        </span>
      )}
      {held && (
        <span className={`${T.badgeBase} ${T.badge.draft}`} data-held-badge>
          <EyeOff className="w-3 h-3" aria-hidden="true" />
          {tri(COMPLETENESS_UI.heldBadge, lang)}
        </span>
      )}
    </span>
  );
}
