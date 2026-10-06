/**
 * «الهدايا» — THE ADMIN'S GIFT LEVELS AND GRANTS (owner brief 2026-10-06 §1;
 * docs/GIFTS_QUICK_BUY.md §1.3). A lazy panel of the admin dashboard, in the
 * products panel's `.ap` theme:
 *
 *   المستويات         five levels of real store products (LevelsPanel)
 *   الهدايا الممنوحة   every grant, filtered and paged (GrantsPanel), each
 *                      opening its detail and audit timeline (GrantDetail)
 *   «منح هدية»         the grant sheet (GrantSheet)
 *
 * Every write is the server's one audited batch; this screen re-reads after
 * each one rather than guessing what changed.
 */
import { useCallback, useEffect, useState } from 'react';
import { Gift, Plus } from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import LevelsPanel from './LevelsPanel';
import GrantsPanel from './GrantsPanel';
import GrantSheet from './GrantSheet';
import GrantDetail from './GrantDetail';
import { adminLang, adminText, type AdminStringKey } from './strings';
import type { Level } from './types';

export type AdminGiftsView = 'levels' | 'grants';

export default function AdminGifts({ initialView = 'levels' }: { initialView?: AdminGiftsView }) {
  const { lang: rawLang, dir } = useLanguage();
  const lang = adminLang(rawLang);
  const t = (k: AdminStringKey) => adminText(lang, k);
  const [view, setView] = useState<AdminGiftsView>(initialView);
  const [granting, setGranting] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState('');

  useEffect(() => setView(initialView), [initialView]);

  // The grant sheet needs the levels (names, active, items) whichever tab is open.
  const loadLevels = useCallback(async () => {
    try {
      const res = await api.get<{ levels: Level[] }>('/api/gifts/admin/levels');
      setLevels(res.levels ?? []);
    } catch {
      /* the levels tab shows its own error; the sheet stays usable without names */
    }
  }, []);

  useEffect(() => {
    if (granting) void loadLevels();
  }, [granting, loadLevels]);

  return (
    <div className={`${T.AP} space-y-4`} dir={dir} data-panel="gifts">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[20px] font-bold leading-tight text-[var(--ap-text-1)]">
            <Gift className="w-5 h-5 text-gold" aria-hidden /> {t('title')}
          </h1>
          <p className="mt-1 max-w-[70ch] text-[12.5px] text-[var(--ap-text-3)]">{t('subtitle')}</p>
        </div>
        <button type="button" className={T.btnPrimary} onClick={() => setGranting(true)} data-gift-grant-open>
          <Plus className="w-4 h-4" aria-hidden /> {t('grantGift')}
        </button>
      </header>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t('title')}>
        {(['levels', 'grants'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            aria-pressed={view === v}
            className={T.chip}
            onClick={() => setView(v)}
            data-gift-tab={v}
          >
            {v === 'levels' ? t('tabLevels') : t('tabGrants')}
          </button>
        ))}
      </div>

      {notice && (
        <p role="status" className="text-[13px] text-success">
          {notice}
        </p>
      )}

      {view === 'levels' ? <LevelsPanel lang={lang} /> : <GrantsPanel lang={lang} refreshKey={refreshKey} onOpen={setDetailId} />}

      <GrantSheet
        lang={lang}
        open={granting}
        levels={levels}
        onClose={() => setGranting(false)}
        onGranted={(grant) => {
          setGranting(false);
          setNotice(t('granted'));
          setView('grants');
          setRefreshKey((k) => k + 1);
          setDetailId(grant.id);
        }}
      />
      <GrantDetail lang={lang} giftId={detailId} onClose={() => setDetailId(null)} onChanged={() => setRefreshKey((k) => k + 1)} />
    </div>
  );
}
