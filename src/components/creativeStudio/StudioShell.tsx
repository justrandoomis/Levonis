/**
 * The studio’s frame: who is looking, the provider and brand status every
 * screen reads, and the tabs (Home, New design, Editor, Brand, Assets,
 * Archive, Settings). The open design and tab live in the URL
 * (`?tab=…&doc=…`) so a reload reopens the same design; switching away from
 * the editor unmounts it, which flushes its autosave first.
 *
 * Access is decided by the server on every request (403
 * CREATIVE_SCOPE_REQUIRED for an assistant admin); this frame only says so
 * instead of drawing screens nobody can use.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { Button } from '../ui/Button';
import { TabStrip } from '../ui/Tabs';
import type { BrandDto, ProviderStatusDto } from '../../../packages/creativeDoc/src/api';
import { brand as brandApi, provider as providerApi } from './client';
import { S } from './strings';
import { StudioContext, codeOf, failText, useText, type NewDesignPrefill, type StudioContextValue, type StudioTab, type StudioUser } from './shared';
import Home from './Home';
import NewDesign from './NewDesign';
import Editor from './Editor';
import BrandTab from './BrandTab';
import AssetsTab from './AssetsTab';
import ArchiveTab from './ArchiveTab';
import SettingsTab from './SettingsTab';

const TABS: StudioTab[] = ['home', 'new', 'editor', 'brand', 'assets', 'archive', 'settings'];

function fromUrl(): { tab: StudioTab; doc: string | null } {
  try {
    const p = new URLSearchParams(window.location.search);
    const doc = p.get('doc');
    const okDoc = doc && /^[A-Za-z0-9_-]{1,80}$/.test(doc) ? doc : null;
    const tab = p.get('tab') as StudioTab | null;
    if (tab && TABS.includes(tab) && (tab !== 'editor' || okDoc)) return { tab, doc: okDoc };
    return { tab: okDoc ? 'editor' : 'home', doc: okDoc };
  } catch {
    return { tab: 'home', doc: null };
  }
}

export default function StudioShell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { lang, dir, w } = useText();
  const first = useMemo(fromUrl, []);
  const [tab, setTab] = useState<StudioTab>(first.tab);
  const [docId, setDocId] = useState<string | null>(first.doc);
  const [prefill, setPrefill] = useState<NewDesignPrefill | null>(null);
  const [newKey, setNewKey] = useState(0);
  const [providerStatus, setProviderStatus] = useState<ProviderStatusDto | null>(null);
  const [brandDto, setBrandDto] = useState<BrandDto | null>(null);
  const [refused, setRefused] = useState<string>('');
  const [loadError, setLoadError] = useState('');

  const studioUser: StudioUser = {
    isOwner: user?.is_owner === true && user?.owner_email_unverified !== true,
    canDesign: user?.isAdmin === true && user?.admin_scope !== 'assistant',
  };

  const reloadProvider = useCallback(() => {
    providerApi.status().then(setProviderStatus, (e: unknown) => {
      if (codeOf(e) === 'CREATIVE_SCOPE_REQUIRED') setRefused(codeOf(e));
      setProviderStatus(null);
    });
  }, []);
  const reloadBrand = useCallback(() => {
    brandApi.get().then((b) => { setBrandDto(b); setLoadError(''); }, (e: unknown) => {
      if (codeOf(e) === 'CREATIVE_SCOPE_REQUIRED') setRefused(codeOf(e));
      else setLoadError(failText(e, lang));
    });
  }, [lang]);
  useEffect(() => {
    if (!studioUser.canDesign) return;
    reloadProvider();
    reloadBrand();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The tab and the open design are in the URL, so a reload lands on the same design.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    if (docId) url.searchParams.set('doc', docId);
    else url.searchParams.delete('doc');
    window.history.replaceState(window.history.state, '', url);
  }, [tab, docId]);

  // The open editor’s question before leaving it (unsaved work); one at a time.
  const leaveGuard = useRef<(() => boolean) | null>(null);
  const setLeaveGuard = useCallback((guard: () => boolean) => {
    leaveGuard.current = guard;
    return () => {
      if (leaveGuard.current === guard) leaveGuard.current = null;
    };
  }, []);
  const mayLeave = useCallback((): boolean => {
    const guard = leaveGuard.current;
    if (!guard) return true;
    try {
      return guard();
    } catch {
      return true;
    }
  }, []);

  const goTab = useCallback((next: StudioTab) => {
    if (next === tab) return;
    if (tab === 'editor' && !mayLeave()) return;
    setTab(next);
  }, [tab, mayLeave]);

  const ctx: StudioContextValue = {
    user: studioUser,
    provider: providerStatus,
    brand: brandDto,
    reloadProvider,
    reloadBrand,
    goTab,
    openDocument: (id) => {
      setDocId(id);
      setTab('editor');
    },
    startNew: (p) => {
      if (tab === 'editor' && !mayLeave()) return;
      setPrefill(p ?? null);
      setNewKey((k) => k + 1);
      setTab('new');
    },
    setLeaveGuard,
  };

  if (!studioUser.canDesign || refused) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" dir={dir} data-studio-refused>
        <p className="text-sm text-text-secondary">{w(S.assistantRefused)}</p>
        <Button onClick={() => navigate('/admin')}>{w(S.backToAdmin)}</Button>
      </div>
    );
  }

  const items = TABS.filter((t) => t !== 'editor' || docId).map((t) => ({
    id: t,
    label: w(t === 'home' ? S.tabHome : t === 'new' ? S.tabNew : t === 'editor' ? S.tabEditor : t === 'brand' ? S.tabBrand : t === 'assets' ? S.tabAssets : t === 'archive' ? S.tabArchive : S.tabSettings),
  }));

  return (
    <StudioContext.Provider value={ctx}>
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden" dir={dir} data-studio data-studio-tab={tab}>
        <header className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-2">
          <Button size="sm" variant="ghost" icon={<ArrowRight className={`h-4 w-4 ${dir === 'ltr' ? 'rotate-180' : ''}`} />} onClick={() => { if (tab !== 'editor' || mayLeave()) navigate('/admin'); }}>
            {w(S.backToAdmin)}
          </Button>
          <h1 className="text-sm font-bold text-text-primary">{w(S.studioTitle)}</h1>
          <div className="w-full min-w-0 overflow-x-auto sm:w-auto sm:flex-1">
            <TabStrip group="studio" items={items} value={tab} onChange={(id) => goTab(id as StudioTab)} label={w(S.studioShort)} />
          </div>
        </header>
        {brandDto && !brandDto.migrated ? <p className="bg-warning/10 px-3 py-1.5 text-sm text-warning" role="status">{w(S.notMigrated)}</p> : null}
        {loadError ? <p className="bg-danger/10 px-3 py-1.5 text-sm text-danger" role="alert">{loadError}</p> : null}
        <main className={`min-h-0 flex-1 ${tab === 'editor' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          {tab === 'home' ? <Home /> : null}
          {tab === 'new' ? <NewDesign key={newKey} prefill={prefill} /> : null}
          {tab === 'editor' && docId ? <Editor key={docId} docId={docId} /> : null}
          {tab === 'editor' && !docId ? <p className="p-6 text-sm text-text-muted">{w(S.editorEmpty)}</p> : null}
          {tab === 'brand' ? <BrandTab /> : null}
          {tab === 'assets' ? <AssetsTab /> : null}
          {tab === 'archive' ? <ArchiveTab /> : null}
          {tab === 'settings' ? <SettingsTab /> : null}
        </main>
      </div>
    </StudioContext.Provider>
  );
}
