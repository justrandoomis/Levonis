/**
 * «الهدايا الممنوحة» — every grant, newest first, filtered by status, level,
 * reason and a customer search, paged with the server's cursor
 * (`GET /api/gifts/admin/grants`). A row opens its detail.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, Search } from 'lucide-react';
import { api, failureText } from '../../lib/api';
import { formatDate } from '../orders/format';
import { Banner, Select } from '../adminProducts/form/formUi';
import * as T from '../adminProducts/theme';
import { GiftStatusChip, triOf } from './ui';
import { adminText, reasonKey, statusKey, type AdminLang, type AdminStringKey } from './strings';
import { GIFT_STATUSES, GRANT_REASONS, type AdminGift } from './types';

export default function GrantsPanel({
  lang,
  refreshKey,
  onOpen,
}: {
  lang: AdminLang;
  /** Bumped by the parent after a grant or an action, to re-read the first page. */
  refreshKey: number;
  onOpen: (id: string) => void;
}) {
  const t = (k: AdminStringKey) => adminText(lang, k);
  const [status, setStatus] = useState('');
  const [level, setLevel] = useState('');
  const [reason, setReason] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AdminGift[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  const query = useCallback(
    (after: string | null) => {
      const p = new URLSearchParams();
      if (status) p.set('status', status);
      if (level) p.set('level', level);
      if (reason) p.set('reason', reason);
      if (q.trim()) p.set('q', q.trim());
      if (after) p.set('cursor', after);
      p.set('limit', '30');
      return `/api/gifts/admin/grants?${p.toString()}`;
    },
    [status, level, reason, q]
  );

  const load = useCallback(
    async (more: boolean) => {
      const mine = ++seq.current;
      setBusy(true);
      setError('');
      try {
        const res = await api.get<{ grants: AdminGift[]; next_cursor: string | null }>(query(more ? cursor : null));
        if (mine !== seq.current) return;
        setRows((prev) => (more && prev ? [...prev, ...res.grants] : res.grants));
        setCursor(res.next_cursor);
      } catch (e) {
        if (mine === seq.current) setError(failureText(e, t('loadFailed')));
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the cursor is read at call time
    [query, cursor]
  );

  // Filters and the parent's refresh re-read the first page (debounced for typing).
  useEffect(() => {
    const timer = setTimeout(() => void load(false), q ? 300 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` changes with the cursor
  }, [status, level, reason, q, refreshKey]);

  return (
    <div className="space-y-3" data-gift-grants>
      <div className="grid gap-2 [grid-template-columns:minmax(0,1fr)] md:[grid-template-columns:repeat(2,minmax(0,1fr))] xl:[grid-template-columns:repeat(3,minmax(0,1fr))]">
        <div className="relative min-w-0">
          <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-2.5 text-[var(--ap-text-3)]" aria-hidden />
          <input className={`${T.input} w-full ps-8`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} aria-label={t('search')} />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('filterStatus')}>
          <option value="">
            {t('filterStatus')}: {t('filterAll')}
          </option>
          {GIFT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(statusKey(s))}
            </option>
          ))}
        </Select>
        <div className="flex gap-2 min-w-0">
          <div className="min-w-0 flex-1">
            <Select value={level} onChange={(e) => setLevel(e.target.value)} aria-label={t('filterLevel')}>
              <option value="">
                {t('filterLevel')}: {t('filterAll')}
              </option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {adminText(lang, 'levelN', { n })}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-0 flex-1">
            <Select value={reason} onChange={(e) => setReason(e.target.value)} aria-label={t('filterReason')}>
              <option value="">
                {t('filterReason')}: {t('filterAll')}
              </option>
              {GRANT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(reasonKey(r))}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {!rows && busy && (
        <p className="flex items-center gap-2 text-[13px] text-[var(--ap-text-3)]">
          <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden /> {t('loading')}
        </p>
      )}
      {rows && rows.length === 0 && !busy && <p className="py-6 text-center text-[13px] text-[var(--ap-text-3)]">{t('grantsEmpty')}</p>}

      {rows && rows.length > 0 && (
        <ul className={`${T.surface} divide-y divide-[var(--ap-hairline)] overflow-hidden`}>
          {rows.map((g) => {
            const product = g.chosen ? (g.chosen.name.en || g.chosen.name.ar || '').trim() : '';
            return (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => onOpen(g.id)}
                  className="w-full text-start flex items-center gap-3 px-3 py-2.5 min-h-[56px] hover:bg-[var(--ap-surface-2)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gold"
                  data-gift-grant-row={g.id}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[13px] font-semibold text-[var(--ap-text-1)]" dir="auto">
                        {g.user.name || g.user.username || g.user.email}
                      </span>
                      <GiftStatusChip lang={lang} status={g.status} />
                    </p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ap-text-3)]">
                      {/* Each part is isolated, so an English product name never drags the date's digits across the dot. */}
                      {[
                        g.level ? triOf(lang, g.level.name) || adminText(lang, 'levelN', { n: g.level.n }) : '',
                        t(reasonKey(g.reason)),
                        product,
                        formatDate(g.granted_at, lang),
                      ]
                        .filter(Boolean)
                        .map((part, i) => (
                          <span key={i}>
                            {i > 0 && ' · '}
                            <bdi>{part}</bdi>
                          </span>
                        ))}
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 shrink-0 text-[var(--ap-text-3)] rtl:rotate-180" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {cursor && (
        <button type="button" className={`${T.btnSecondary} w-full`} disabled={busy} onClick={() => void load(true)} data-gift-grants-more>
          {busy && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden />}
          {t('loadMore')}
        </button>
      )}
    </div>
  );
}
