/**
 * «منح هدية» (owner brief 2026-10-06 §1): a customer, a level 1–5, and how —
 * the customer picks one of the level's products, one level product pinned
 * now, or any store product pinned now — the reason, and an internal note the
 * customer never sees. One idempotency key per opening of the sheet, so a
 * double press or a retried request is the same grant.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { api, failureText, newIdempotencyKey } from '../../lib/api';
import { Sheet } from '../ui/Overlay';
import { Banner, Field, Select, TextArea } from '../adminProducts/form/formUi';
import * as T from '../adminProducts/theme';
import ItemFields, { blankItem } from './ItemFields';
import { ItemRow, triOf } from './ui';
import { adminText, reasonKey, type AdminLang, type AdminStringKey } from './strings';
import { GRANT_REASONS, type AdminGift, type GrantReason, type ItemInput, type Level, type UserHit } from './types';

type How = 'level' | 'item' | 'product';

export default function GrantSheet({
  lang,
  open,
  levels,
  onClose,
  onGranted,
}: {
  lang: AdminLang;
  open: boolean;
  levels: Level[];
  onClose: () => void;
  onGranted: (grant: AdminGift) => void;
}) {
  const t = (k: AdminStringKey) => adminText(lang, k);
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<UserHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [user, setUser] = useState<UserHit | null>(null);
  const [level, setLevel] = useState(1);
  const [how, setHow] = useState<How>('level');
  const [itemId, setItemId] = useState('');
  const [product, setProduct] = useState<ItemInput>(blankItem());
  const [reason, setReason] = useState<GrantReason>('admin_gift');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(newIdempotencyKey());
  const seq = useRef(0);

  // A fresh form — and a fresh request key — every time the sheet opens.
  useEffect(() => {
    if (!open) return;
    key.current = `gift-grant-${newIdempotencyKey()}`;
    setQuery('');
    setHits([]);
    setUser(null);
    setLevel(1);
    setHow('level');
    setItemId('');
    setProduct(blankItem());
    setReason('admin_gift');
    setNote('');
    setBusy(false);
    setError('');
  }, [open]);

  // Type-to-search the customer, debounced; only the latest answer counts.
  useEffect(() => {
    const q = query.trim();
    if (!open || user || q.length < 2) {
      setHits([]);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .get<{ users: UserHit[] }>(`/api/gifts/admin/users?q=${encodeURIComponent(q)}`)
        .then((r) => mine === seq.current && setHits(r.users ?? []))
        .catch(() => mine === seq.current && setHits([]))
        .finally(() => mine === seq.current && setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, open, user]);

  const current = levels.find((l) => l.n === level);
  const liveItems = useMemo(() => (current?.items ?? []).filter((i) => i.active), [current]);
  const ready =
    !!user && !busy && (how === 'level' ? liveItems.length > 0 : how === 'item' ? !!itemId : !!product.productId && (product.saleType !== 'pre_order' || !!product.transportMethod));

  // Changing the level un-picks a level item that belongs to another level.
  useEffect(() => {
    if (itemId && !liveItems.some((i) => i.id === itemId)) setItemId('');
  }, [itemId, liveItems]);

  const submit = async () => {
    if (!ready || !user) return;
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        userId: user.id,
        mode: how === 'product' ? 'product' : 'level',
        level,
        reason,
        note: note.trim(),
        idempotencyKey: key.current,
      };
      if (how === 'item') body.itemId = itemId;
      if (how === 'product') body.product = product;
      const res = await api.post<{ grant: AdminGift }>('/api/gifts/admin/grants', body);
      onGranted(res.grant);
    } catch (e) {
      setError(failureText(e, t('loadFailed')));
      setBusy(false);
    }
  };

  const hows: Array<[How, AdminStringKey]> = [
    ['level', 'modeLevel'],
    ['item', 'modeItem'],
    ['product', 'modeProduct'],
  ];

  return (
    <Sheet open={open} onClose={() => !busy && onClose()} labelledBy={titleId} panelClassName="w-full sm:max-w-xl" dirty={!!user && !busy}>
      <form
        className={`${T.AP} px-5 pb-5 pt-2 space-y-4`}
        data-gift-grant-sheet
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id={titleId} className="text-[15px] font-bold text-[var(--ap-text-1)]">
          {t('sheetTitle')}
        </h2>

        {/* 1. The customer */}
        <Field ar={t('findCustomer')} en="Customer" htmlFor="gift-grant-user">
          {user ? (
            <div className="flex items-center justify-between gap-2 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] px-3 py-2" data-gift-grant-user={user.id}>
              <span className="min-w-0 text-[13px] text-[var(--ap-text-1)]">
                <span dir="auto">{user.name || user.username}</span>{' '}
                <span className="text-[var(--ap-text-3)]" dir="ltr">
                  {user.email}
                  {user.phone ? ` · ${user.phone}` : ''}
                </span>
              </span>
              <button type="button" className={T.btnGhostSm} onClick={() => setUser(null)} disabled={busy}>
                <X className="w-3.5 h-3.5" aria-hidden /> {t('change')}
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="relative">
                <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-2.5 text-[var(--ap-text-3)]" aria-hidden />
                <input
                  id="gift-grant-user"
                  className={`${T.input} w-full ps-8`}
                  value={query}
                  placeholder={t('customerHint')}
                  autoComplete="off"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {searching && <p className="text-[12px] text-[var(--ap-text-3)]">{t('loading')}</p>}
              {!searching && query.trim().length >= 2 && hits.length === 0 && <p className="text-[12px] text-[var(--ap-text-3)]">{t('noCustomers')}</p>}
              {hits.length > 0 && (
                <ul className="max-h-48 overflow-y-auto space-y-1" role="listbox" aria-label={t('findCustomer')}>
                  {hits.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        className="w-full text-start rounded-md px-2 py-1.5 hover:bg-[var(--ap-surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                        onClick={() => setUser(h)}
                      >
                        <span className="block text-[13px] text-[var(--ap-text-1)]" dir="auto">
                          {h.name || h.username}
                        </span>
                        <span className="block text-[12px] text-[var(--ap-text-3)]" dir="ltr">
                          {h.email}
                          {h.phone ? ` · ${h.phone}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Field>

        {/* 2. The level */}
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-[12px] font-bold text-text-secondary">{t('chooseLevel')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {levels.map((l) => (
              <button
                key={l.n}
                type="button"
                className={T.chip}
                aria-pressed={level === l.n}
                onClick={() => setLevel(l.n)}
                disabled={busy}
                data-gift-grant-level={l.n}
              >
                {l.n} · {triOf(lang, l.name)}
              </button>
            ))}
          </div>
          {current && !current.active && <Banner kind="warn">{t('levelOffWarn')}</Banner>}
          {current && current.active && how === 'level' && liveItems.length === 0 && <Banner kind="warn">{t('levelEmptyWarn')}</Banner>}
        </fieldset>

        {/* 3. How */}
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-[12px] font-bold text-text-secondary">{t('how')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {hows.map(([h, label]) => (
              <button key={h} type="button" className={T.chip} aria-pressed={how === h} onClick={() => setHow(h)} disabled={busy} data-gift-grant-how={h}>
                {t(label)}
              </button>
            ))}
          </div>
          {how === 'item' && (
            <ul className="space-y-1.5" role="radiogroup" aria-label={t('chooseItem')}>
              {liveItems.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={itemId === i.id}
                    onClick={() => setItemId(i.id)}
                    disabled={busy}
                    className={`w-full text-start rounded-[var(--ap-radius-md)] border p-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${
                      itemId === i.id ? 'border-gold/40 bg-[var(--ap-surface-2)]' : 'border-[var(--ap-border)]'
                    }`}
                  >
                    <ItemRow lang={lang} item={i} />
                  </button>
                </li>
              ))}
              {liveItems.length === 0 && <li className="text-[12.5px] text-[var(--ap-text-2)]">{t('noItems')}</li>}
            </ul>
          )}
          {how === 'product' && <ItemFields lang={lang} value={product} onChange={setProduct} disabled={busy} />}
        </fieldset>

        {/* 4. Why, and the internal note */}
        <Field ar={t('reason')} en="Reason">
          <Select value={reason} onChange={(e) => setReason(e.target.value as GrantReason)} disabled={busy}>
            {GRANT_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(reasonKey(r))}
              </option>
            ))}
          </Select>
        </Field>
        <Field ar={t('note')} en="Note" hint={t('noteHint')}>
          <TextArea dir="auto" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        </Field>

        {error && (
          <div role="alert">
            <Banner kind="error">{error}</Banner>
          </div>
        )}
        <div className="flex gap-2">
          <button type="button" className={`${T.btnGhost} flex-1`} onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
          <button type="submit" className={`${T.btnPrimary} flex-1`} disabled={!ready} data-gift-grant-submit>
            {busy && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden />}
            {busy ? t('granting') : t('grantAction')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
