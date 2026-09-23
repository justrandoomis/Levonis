/**
 * «ليفو كوميونيتي تحت الصيانة، واسمح بالأعضاء من قائمة في الادارة» — the one
 * switch that shuts Levo Community, and the list of people who may still come
 * in while it is shut.
 *
 * It is NOT one of the commission fields beside it. Those are numbers that
 * change what a FUTURE sale costs; this is a door. So it has its own pair of
 * routes (GET/PUT /api/admin/community/gate), every flip writes an audit row
 * naming who flipped it, and the generic settings PATCH cannot reach it.
 *
 * What the panel promises, and what the server actually does
 * (worker/lib/communityGate.ts):
 *   * while it is shut, the gated /api/community routes answer 503
 *     COMMUNITY_CLOSED to everyone who is not an admin and not on the list —
 *     the tab disappearing from the app is presentation on top of that;
 *   * the list is USER IDS, never usernames or emails: a name its owner can
 *     change is a way into a list they were not put on;
 *   * merchants keep running the shops they already have. Their catalogue,
 *     their orders and their own storefront subdomains are outside this wall
 *     on purpose — closing a browsing surface must not close a business.
 *
 * CLOSING DELETES NOTHING: no merchant, no product, no request, no follow, no
 * order. Reopening puts everything back exactly as it was.
 */
import { useCallback, useEffect, useState } from 'react';
import { Lock, LockOpen, RefreshCw, Search, X, UserPlus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { adminCommunityApi } from '../../lib/merchant';
import { resetCommunityAccessCache } from '../../pages/community/access';

type T = (ar: string, en: string) => string;

interface Member {
  id: string;
  username: string | null;
  name: string | null;
  email: string | null;
}

const btn =
  'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12.5px] font-bold transition-colors disabled:opacity-50';

export default function CommunityGatePanel({ t }: { t: T }) {
  /** The server's answer. `null` until it has given one — never assumed. */
  const [open, setOpen] = useState<boolean | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const [q, setQ] = useState('');
  const [found, setFound] = useState<Member[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    const res = await adminCommunityApi.gate();
    setOpen(res.open);
    setDraftOpen(res.open);
    setMembers(res.members);
  }, []);

  useEffect(() => {
    let alive = true;
    load().catch((e: unknown) => {
      if (alive) setNote({ ok: false, text: e instanceof ApiError ? e.message : t('تعذّر القراءة', 'Could not load') });
    });
    return () => {
      alive = false;
    };
  }, [load, t]);

  async function search() {
    const term = q.trim();
    if (!term) return;
    setSearching(true);
    try {
      const d = await api.get<{ users: Member[] }>(`/api/admin/users?search=${encodeURIComponent(term)}&limit=20`);
      setFound(d.users);
    } catch (e) {
      setNote({ ok: false, text: e instanceof ApiError ? e.message : t('تعذّر البحث', 'Search failed') });
    } finally {
      setSearching(false);
    }
  }

  async function apply(nextOpen: boolean, nextMembers: Member[]) {
    setBusy(true);
    setNote(null);
    try {
      const res = await adminCommunityApi.saveGate(nextOpen, nextMembers.map((m) => m.id));
      setOpen(res.open);
      setDraftOpen(res.open);
      // The admin's own app asked this question already; make it ask again.
      resetCommunityAccessCache();
      setNote({
        ok: true,
        text: res.open
          ? t('المجتمع مفتوح للجميع', 'The community is open to everyone')
          : t('المجتمع تحت الصيانة', 'The community is under maintenance'),
      });
      await load();
    } catch (e) {
      // The server refused — its sentence is shown as it arrived, never reworded.
      setNote({ ok: false, text: e instanceof ApiError ? e.message : t('تعذّر الحفظ', 'Could not save') });
      setDraftOpen(open ?? false);
    } finally {
      setBusy(false);
    }
  }

  const label = (m: Member) => m.username || m.name || m.email || m.id;

  return (
    <section
      className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3 min-w-0"
      data-community-gate-panel
    >
      <div className="flex items-start gap-2 min-w-0">
        {open === true ? (
          <LockOpen className="w-4 h-4 text-gold shrink-0 mt-0.5" aria-hidden="true" />
        ) : (
          <Lock className="w-4 h-4 text-gold shrink-0 mt-0.5" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-bold text-white">{t('صيانة المجتمع', 'Community maintenance')}</h3>
          <p className="text-[12px] text-zinc-400 leading-relaxed mt-0.5">
            {t(
              'عند الإغلاق يرفض الخادم كل طلبات المجتمع لمن ليس مسؤولاً وليس في القائمة. الإغلاق لا يحذف أي متجر أو منتج أو طلب، والتجار يواصلون إدارة متاجرهم.',
              'While it is shut the SERVER refuses every community request from anyone who is not an admin and not on the list. Closing deletes no store, product or request, and merchants keep running their shops.'
            )}
          </p>
        </div>
      </div>

      {open === null && note === null && (
        <p role="status" className="text-[12.5px] text-zinc-400 py-2">
          {t('جارٍ التحميل…', 'Loading…')}
        </p>
      )}

      {open !== null && (
        <>
          <p
            className="text-[12.5px] text-white font-bold"
            data-community-gate-state={open ? 'open' : 'closed'}
          >
            {open ? t('المجتمع مفتوح', 'Community is open') : t('المجتمع تحت الصيانة', 'Community is under maintenance')}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void apply(!draftOpen, members)}
              disabled={busy}
              className={`${btn} bg-gold text-black`}
              data-community-gate-toggle
            >
              {draftOpen ? t('أغلق المجتمع', 'Close the community') : t('افتح المجتمع', 'Open the community')}
            </button>
            <button
              type="button"
              onClick={() => {
                setNote(null);
                load().catch(() => setNote({ ok: false, text: t('تعذّر القراءة', 'Could not load') }));
              }}
              disabled={busy}
              className={`${btn} bg-zinc-800 text-zinc-200`}
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              {t('تحديث', 'Refresh')}
            </button>
          </div>

          {/* ---- the allow-list ---- */}
          <div className="pt-2 border-t border-zinc-800 space-y-2">
            <h4 className="text-[12.5px] font-bold text-white">
              {t('الأعضاء المسموح لهم', 'Allowed members')}
              <span className="text-zinc-500 font-normal"> ({members.length})</span>
            </h4>
            <p className="text-[11.5px] text-zinc-500 leading-relaxed">
              {t(
                'يدخل هؤلاء أثناء الصيانة. المطابقة على معرّف الحساب وليس على الاسم — الاسم يمكن تغييره.',
                'These accounts come in while it is shut. Matched on the account id, never the name — a name can be changed.'
              )}
            </p>

            {members.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" data-community-gate-members>
                {members.map((m) => (
                  <li
                    key={m.id}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2 py-1 text-[12px] text-zinc-200"
                  >
                    <span className="truncate max-w-[180px]">{label(m)}</span>
                    <button
                      type="button"
                      aria-label={t('إزالة', 'Remove')}
                      disabled={busy}
                      onClick={() => void apply(draftOpen, members.filter((x) => x.id !== m.id))}
                      className="text-zinc-400 hover:text-red-400"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void search();
                  }
                }}
                placeholder={t('ابحث بالاسم أو البريد', 'Search by name or email')}
                className="flex-1 min-w-[180px] bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-white text-[12.5px] focus:outline-none focus:border-gold"
              />
              <button type="button" onClick={() => void search()} disabled={searching} className={`${btn} bg-zinc-800 text-zinc-200`}>
                <Search className="w-3.5 h-3.5" aria-hidden="true" />
                {t('بحث', 'Search')}
              </button>
            </div>

            {found !== null && (
              <ul className="space-y-1" data-community-gate-results>
                {found.length === 0 && <li className="text-[12px] text-zinc-500">{t('لا نتائج', 'No results')}</li>}
                {found.map((u) => {
                  const already = members.some((m) => m.id === u.id);
                  return (
                    <li key={u.id} className="flex items-center gap-2 text-[12px] text-zinc-300">
                      <span className="truncate flex-1">
                        {label(u)} <span className="text-zinc-600">{u.id}</span>
                      </span>
                      <button
                        type="button"
                        disabled={busy || already}
                        onClick={() => void apply(draftOpen, [...members, u])}
                        className={`${btn} bg-zinc-800 text-zinc-200 !py-1`}
                      >
                        <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
                        {already ? t('مضاف', 'Added') : t('أضف', 'Add')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {note && (
        <p
          role={note.ok ? 'status' : 'alert'}
          className={`text-[12px] ${note.ok ? 'text-emerald-300' : 'text-red-400'}`}
          data-community-gate-note
        >
          {note.text}
        </p>
      )}
    </section>
  );
}
