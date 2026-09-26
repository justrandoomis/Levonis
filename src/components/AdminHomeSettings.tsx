import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, uploadFile } from '../lib/api';
import type { BentoPosition, SiteMediaEntry } from '../lib/api';
import { GripVertical, Plus, Settings, Eye, EyeOff, Save, Trash2, LayoutTemplate, Megaphone, Image as ImageIcon, ArrowLeft, ArrowRight, ChevronUp, ChevronDown, Upload, Check, AlertTriangle, RotateCcw, Pin, LayoutGrid, Search, PackageSearch, Wrench, Sparkles } from 'lucide-react';
import AdminAds from './AdminAds';
import {
  HERO_SLIDE_GROUPS,
  HOME_SECTIONS,
  normalizeHomeSections,
  serializeHomeSections,
  slideGroupVisible,
  type HeroSlideGroup,
  type HomeSectionId,
  type HomeSectionRow,
} from '../lib/homeSections';
import { BENTO_DEFAULTS, BENTO_POSITIONS } from '../lib/homeLayout';
import { encodeProductRasterAsWebp, prepareProductImage } from '../lib/imagePreprocess';

/**
 * «إعدادات الصفحة الرئيسية».
 *
 * FOLLOWS THE HOME PAGE AS IT IS NOW (owner, 2026-09-26: «أجعل القسم يتبع
 * التقسيم الحالي»). The tabs are the sections src/pages/Home.tsx actually
 * draws — src/lib/homeSections.ts is the one list both sides read — plus the
 * pictures tab. The editors for the shelves the old home page stacked
 * (coupons, discounts, top brands, best sellers, combos…) are gone: none of
 * them is mounted any more, so their switches and cards controlled nothing.
 */

interface LocalizedText { ar: string; en: string; ckb: string }
interface Banner {
  id: string;
  image: string;
  link: string;
  // Hero copy, one string per language. NEVER machine-translated: the owner
  // writes each one, and the storefront falls back to whichever language they
  // actually filled in (worker/lib/homeContent.ts → pickText).
  title?: LocalizedText;
  subtitle?: LocalizedText;
  cta?: LocalizedText;
}

const EMPTY_TEXT: LocalizedText = { ar: '', en: '', ckb: '' };
const asText = (t: LocalizedText | undefined): LocalizedText => t ?? EMPTY_TEXT;

/** One field, three languages. Any of them may be left blank. */
function LocalizedField({
  label,
  hint,
  value,
  onChange,
  multiline,
}: {
  label: string;
  hint?: string;
  value: LocalizedText;
  onChange: (v: LocalizedText) => void;
  multiline?: boolean;
}) {
  const langs: Array<{ key: keyof LocalizedText; label: string; dir: 'rtl' | 'ltr' }> = [
    { key: 'ar', label: 'العربية', dir: 'rtl' },
    { key: 'en', label: 'English', dir: 'ltr' },
    { key: 'ckb', label: 'کوردی', dir: 'rtl' },
  ];
  const cls =
    'w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-iris outline-none min-h-[44px]';
  return (
    <div>
      <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">{label}</label>
      {hint && <p className="text-[11px] text-zinc-500 mb-2">{hint}</p>}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {langs.map((l) => (
          <div key={l.key} className="min-w-0">
            <span className="block text-[10px] text-zinc-600 mb-1">{l.label}</span>
            {multiline ? (
              <textarea
                dir={l.dir}
                rows={2}
                value={value[l.key]}
                onChange={(e) => onChange({ ...value, [l.key]: e.target.value })}
                className={`${cls} resize-y`}
              />
            ) : (
              <input
                type="text"
                dir={l.dir}
                value={value[l.key]}
                onChange={(e) => onChange({ ...value, [l.key]: e.target.value })}
                className={cls}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function SaveStatusLabel({ state, error, dir }: { state: SaveState; error: string | null; dir: string }) {
  if (state === 'saved') {
    return (
      <span className="text-xs font-bold text-mint flex items-center gap-1">
        <Check className="w-3.5 h-3.5" /> {dir === 'rtl' ? 'تم الحفظ' : 'Saved'}
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="text-xs font-bold text-red-400 flex items-center gap-1">
        <AlertTriangle className="w-3.5 h-3.5" /> {error || (dir === 'rtl' ? 'فشل الحفظ' : 'Save failed')}
      </span>
    );
  }
  return null;
}

/** URL input + real upload option for an image field. */
function ImageField({ value, onChange, dir }: { value: string; onChange: (url: string) => void; dir: string }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  return (
    <div>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-iris outline-none"
          placeholder="https://..."
        />
        <label className={`flex items-center justify-center gap-1.5 px-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg cursor-pointer transition-colors border border-zinc-700 text-xs font-bold ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
          <Upload className="w-3.5 h-3.5" />
          {uploading ? (dir === 'rtl' ? 'جارٍ الرفع...' : 'Uploading...') : (dir === 'rtl' ? 'رفع' : 'Upload')}
          <input type="file" className="hidden" accept="image/*" onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setUploading(true);
            setUploadError(null);
            try {
              const result = await uploadFile(file, 'product');
              onChange(result.url);
            } catch (err) {
              setUploadError(err instanceof ApiError ? err.message : 'Upload failed');
            } finally {
              setUploading(false);
            }
          }} />
        </label>
      </div>
      {uploadError && <div className="text-xs text-red-400 mt-1">{uploadError}</div>}
    </div>
  );
}

// The icon lookup stays client-side by id — icons are never sent to the server.
const SECTION_ICONS: Record<HomeSectionId, React.ElementType> = {
  hero: Sparkles,
  ads_panel: Megaphone,
  categories: LayoutGrid,
  printer_finder: Search,
  latest_products: PackageSearch,
  editorial_banners: ImageIcon,
  services: Wrench,
};

type Tab = 'layout' | 'site-media' | HomeSectionId;

const ALL_VISIBLE: Record<HeroSlideGroup, boolean> = { first_banner: true, second_banner: true };

export default function AdminHomeSettings() {
  const { dir } = useLanguage();
  const [sections, setSections] = useState<HomeSectionRow[]>(() => normalizeHomeSections([]));
  const [slideGroups, setSlideGroups] = useState<Record<HeroSlideGroup, boolean>>(ALL_VISIBLE);
  const [banners, setBanners] = useState<Record<string, Banner[]>>({});
  const [bento, setBento] = useState<BentoDraft>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('layout');
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const [layoutState, setLayoutState] = useState<SaveState>('idle');
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [bannersState, setBannersState] = useState<SaveState>('idle');
  const [bannersError, setBannersError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await api.get<{ settings: {
          homeSections: unknown;
          homeBanners: Record<string, Banner[]>;
          homeBento?: BentoDraft;
        } }>('/api/admin/settings');
        if (cancelled) return;
        setSections(normalizeHomeSections(data.settings.homeSections));
        setSlideGroups({
          first_banner: slideGroupVisible(data.settings.homeSections, 'first_banner'),
          second_banner: slideGroupVisible(data.settings.homeSections, 'second_banner'),
        });
        setBanners(data.settings.homeBanners && typeof data.settings.homeBanners === 'object' ? data.settings.homeBanners : {});
        setBento(data.settings.homeBento && typeof data.settings.homeBento === 'object' ? data.settings.homeBento : {});
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof ApiError ? e.message : 'Failed to load home settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.setData('text/plain', index.toString());
  };

  /** Pinned rows (the hero, the ticker) neither move nor let anything above them. */
  const firstMovable = sections.findIndex((s) => !s.pinned);
  const moveSection = (from: number, to: number) => {
    if (to < firstMovable || to >= sections.length || from === to || sections[from]?.pinned) return;
    const newSections = [...sections];
    const [moved] = newSections.splice(from, 1);
    newSections.splice(to, 0, moved);
    setSections(newSections);
    setLayoutState('idle');
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    const dragIndex = parseInt(e.dataTransfer.getData('text/plain'));
    moveSection(dragIndex, dropIndex);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const toggleVisibility = (id: string) => {
    setSections(sections.map(s => s.id === id ? { ...s, isVisible: !s.isVisible } : s));
    setLayoutState('idle');
  };

  const saveLayout = async (
    nextSections: HomeSectionRow[] = sections,
    nextGroups: Record<HeroSlideGroup, boolean> = slideGroups
  ) => {
    setLayoutState('saving');
    setLayoutError(null);
    try {
      // Only plain data goes to the server (no icon components).
      await api.put('/api/admin/settings/homeSections', { value: serializeHomeSections(nextSections, nextGroups) });
      setLayoutState('saved');
    } catch (e) {
      setLayoutState('error');
      setLayoutError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  /** A slide group's switch is a layout setting; it saves with the layout at once. */
  const setSlideGroup = (group: HeroSlideGroup, visible: boolean) => {
    const next = { ...slideGroups, [group]: visible };
    setSlideGroups(next);
    void saveLayout(sections, next);
  };

  const saveBanners = async (next: Record<string, Banner[]>) => {
    setBannersState('saving');
    setBannersError(null);
    try {
      await api.put('/api/admin/settings/homeBanners', { value: next });
      setBannersState('saved');
    } catch (e) {
      setBannersState('error');
      setBannersError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const scrollTabs = (direction: 'left' | 'right') => {
    if (scrollContainerRef.current) {
      const scrollAmount = 200;
      scrollContainerRef.current.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth'
      });
    }
  };

  if (loading) {
    return <div className="text-center text-zinc-500 py-16">{dir === 'rtl' ? 'جارٍ التحميل...' : 'Loading home settings...'}</div>;
  }

  const rtl = dir === 'rtl';
  const tabButton = (id: Tab, Icon: React.ElementType, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setActiveTab(id)}
      aria-pressed={activeTab === id}
      className={`flex items-center gap-2 whitespace-nowrap px-4 py-2.5 rounded-xl font-bold transition-all shrink-0 ${
        activeTab === id ? 'bg-[#6B46FF] text-snow shadow-lg' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'
      }`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-black text-white">{rtl ? 'إعدادات الصفحة الرئيسية' : 'Home Settings'}</h2>
      </div>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 mb-6 text-sm font-medium">
          {loadError}
        </div>
      )}

      {/* Horizontal Tabs */}
      <div className="relative mb-8 bg-zinc-900/50 p-2 rounded-2xl border border-zinc-800 flex items-center">
        <button type="button" aria-label={rtl ? 'تمرير' : 'Scroll'} onClick={() => scrollTabs('left')} className="p-2 text-zinc-400 hover:text-white transition-colors z-10 shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div ref={scrollContainerRef} className="flex-1 overflow-x-auto hide-scrollbar flex items-center gap-2 px-2 scroll-smooth">
          {tabButton('layout', LayoutTemplate, rtl ? 'ترتيب وإظهار الأقسام' : 'Layout & Visibility')}
          {tabButton('site-media', ImageIcon, rtl ? 'صور وأيقونات الصفحة الرئيسية' : 'Main page images')}
          {HOME_SECTIONS.map((section) => tabButton(section.id, SECTION_ICONS[section.id], rtl ? section.titleAr : section.titleEn))}
        </div>

        <button type="button" aria-label={rtl ? 'تمرير' : 'Scroll'} onClick={() => scrollTabs('right')} className="p-2 text-zinc-400 hover:text-white transition-colors z-10 shrink-0">
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1">
        {activeTab === 'layout' && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
            <div className="flex justify-between items-center mb-6 gap-4">
              <p className="text-zinc-400 text-sm">
                {rtl
                  ? 'هذه أقسام الصفحة الرئيسية كما تظهر الآن. اسحب الأقسام أو استخدم الأسهم لإعادة ترتيبها، والعين لإخفائها أو إظهارها. الواجهة الرئيسية والشريط المتحرك مثبّتان في الأعلى.'
                  : 'These are the home page sections as it draws them now. Drag or use the arrows to reorder, the eye to hide or show. The hero and the ticker are pinned to the top.'}
              </p>
              <div className="flex items-center gap-3 shrink-0">
                <SaveStatusLabel state={layoutState} error={layoutError} dir={dir} />
                <button
                  type="button"
                  onClick={() => void saveLayout()}
                  disabled={layoutState === 'saving'}
                  className="flex items-center gap-2 bg-[#2CE59B] hover:bg-[#06D6A0] text-onyx px-5 py-2.5 rounded-xl transition-all font-bold shadow-lg disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  {layoutState === 'saving' ? (rtl ? 'جارٍ الحفظ...' : 'Saving...') : rtl ? 'حفظ الترتيب' : 'Save Layout'}
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {sections.map((section, index) => {
                const Icon = SECTION_ICONS[section.id];
                return (
                  <div
                    key={section.id}
                    data-home-layout-row={section.id}
                    draggable={!section.pinned}
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDrop={(e) => handleDrop(e, index)}
                    onDragOver={handleDragOver}
                    className={`flex items-center justify-between p-4 bg-zinc-800/50 border ${section.isVisible ? 'border-zinc-700' : 'border-zinc-800 opacity-50'} rounded-2xl ${section.pinned ? '' : 'cursor-move'} hover:bg-zinc-800 transition-colors group`}
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="p-2 text-zinc-500 group-hover:text-zinc-300 transition-colors">
                        {section.pinned ? <Pin className="w-5 h-5" aria-hidden="true" /> : <GripVertical className="w-5 h-5" aria-hidden="true" />}
                      </div>
                      <Icon className="w-5 h-5 text-zinc-400 shrink-0" aria-hidden="true" />
                      <div className="flex flex-col min-w-0">
                        <span className="font-bold text-white text-base">
                          {rtl ? section.titleAr : section.titleEn}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {section.pinned ? (rtl ? 'مثبّت في الأعلى' : 'Pinned to the top') : <span className="font-mono">{section.id}</span>}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      {!section.pinned && (
                        <>
                          <button
                            type="button"
                            onClick={() => moveSection(index, index - 1)}
                            disabled={index <= firstMovable}
                            className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors disabled:opacity-30"
                            title={rtl ? 'تحريك للأعلى' : 'Move up'}
                            aria-label={`${rtl ? 'تحريك للأعلى' : 'Move up'} — ${rtl ? section.titleAr : section.titleEn}`}
                          >
                            <ChevronUp className="w-5 h-5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSection(index, index + 1)}
                            disabled={index === sections.length - 1}
                            className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors disabled:opacity-30"
                            title={rtl ? 'تحريك للأسفل' : 'Move down'}
                            aria-label={`${rtl ? 'تحريك للأسفل' : 'Move down'} — ${rtl ? section.titleAr : section.titleEn}`}
                          >
                            <ChevronDown className="w-5 h-5" />
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => toggleVisibility(section.id)}
                        className={`p-2 rounded-xl transition-colors ${section.isVisible ? 'text-mint hover:bg-mint/10' : 'text-zinc-500 hover:bg-zinc-700'}`}
                        title={section.isVisible ? (rtl ? 'إخفاء القسم' : 'Hide section') : (rtl ? 'إظهار القسم' : 'Show section')}
                        aria-pressed={section.isVisible}
                      >
                        {section.isVisible ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveTab(section.id)}
                        title={rtl ? 'إعدادات القسم' : 'Section settings'}
                        aria-label={`${rtl ? 'إعدادات القسم' : 'Section settings'} — ${rtl ? section.titleAr : section.titleEn}`}
                        className="p-2 text-zinc-400 hover:text-iris hover:bg-iris/10 rounded-xl transition-colors"
                      >
                        <Settings className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'hero' && (
          <div className="space-y-6">
            <InfoPanel
              dir={dir}
              ar="بدون شرائح، تظهر الواجهة الرئيسية بعنوان المتجر وزرّين وصورة على الجانب الآخر: الصورة التي ترفعها (للثيم الفاتح والداكن) من تبويب الصور، وإلا صورة طابعة من المتجر. أضف شرائح هنا لتظهر بدلها كعرض متحرك."
              en="With no slides, the hero shows the shop's headline, two buttons and a picture on the other side: the one you upload (light and dark) in the images tab, else a printer from the shop. Add slides here to show a carousel instead."
              action={{ ar: 'صورة الواجهة الرئيسية', en: 'Hero picture', onClick: () => setActiveTab('site-media') }}
            />
            {HERO_SLIDE_GROUPS.map((group, i) => (
              <div key={group} className="space-y-3">
                <label className="flex items-center gap-3 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    className="w-5 h-5 accent-iris"
                    checked={slideGroups[group]}
                    onChange={(e) => setSlideGroup(group, e.target.checked)}
                  />
                  {rtl ? `إظهار شرائح المجموعة ${i === 0 ? 'الأولى' : 'الثانية'}` : `Show slide group ${i + 1}`}
                  <SaveStatusLabel state={layoutState} error={layoutError} dir={dir} />
                </label>
                <BannerSettings
                  id={group}
                  titleEn={`Hero slides — group ${i + 1}`}
                  titleAr={`شرائح الواجهة الرئيسية — المجموعة ${i === 0 ? 'الأولى' : 'الثانية'}`}
                  banners={banners[group] || []}
                  onChange={(list) => { setBanners(prev => ({ ...prev, [group]: list })); setBannersState('idle'); }}
                  onSave={() => saveBanners(banners)}
                  saveState={bannersState}
                  saveError={bannersError}
                />
              </div>
            ))}
          </div>
        )}

        {activeTab === 'ads_panel' && (
          <AdminAds />
        )}

        {activeTab === 'categories' && (
          <BentoSettings dir={dir} value={bento} onSaved={setBento} onImages={() => setActiveTab('site-media')} />
        )}

        {activeTab === 'editorial_banners' && (
          <div className="space-y-6">
            <InfoPanel
              dir={dir}
              ar="بدون بانرات هنا، يظهر البانران الافتراضيان «اطبع بأكثر من لون» و«مواد الطباعة» بصورتيهما من تبويب الصور (فاتح وداكن)، وإلا بصورة منتج حقيقي. أول بانرين تضيفهما هنا يحلّان محلّهما بصورتك ونصّك ورابطك."
              en="With none here, the two built-in banners are drawn with their pictures from the images tab (light and dark), else a real product photo. The first two you add here replace them with your picture, copy and link."
              action={{ ar: 'صور البانرات', en: 'Banner pictures', onClick: () => setActiveTab('site-media') }}
            />
            <BannerSettings
              id="editorial_banners"
              titleEn="Editorial banners — the first two are shown"
              titleAr="البانرات التحريرية — يظهر أول اثنين"
              banners={banners.editorial_banners || []}
              onChange={(list) => { setBanners(prev => ({ ...prev, editorial_banners: list })); setBannersState('idle'); }}
              onSave={() => saveBanners(banners)}
              saveState={bannersState}
              saveError={bannersError}
            />
          </div>
        )}

        {activeTab === 'printer_finder' && (
          <InfoPanel
            dir={dir}
            ar="شريط «محتار أي طابعة تناسبك؟» يفتح مساعد اختيار الطابعة. لا يحتوي على شيء يُحرَّر هنا؛ يمكنك تحريكه أو إخفاؤه من تبويب الترتيب."
            en="The “Which printer suits you?” band opens the printer advisor. Nothing to edit here; move or hide it from the Layout tab."
          />
        )}
        {activeTab === 'latest_products' && (
          <InfoPanel
            dir={dir}
            ar="«أحدث المنتجات» تُملأ تلقائيًا بأحدث المنتجات المنشورة، المتوفرة للبيع المباشر أولًا. يمكنك تحريكها أو إخفاؤها من تبويب الترتيب."
            en="“Latest products” fills itself with the newest published products, those available for direct sale first. Move or hide it from the Layout tab."
          />
        )}
        {activeTab === 'services' && (
          <InfoPanel
            dir={dir}
            ar="بطاقات الخدمات ثابتة الروابط، وأيقوناتها تُستبدل من تبويب الصور («أيقونات الخدمات»)."
            en="The service cards have fixed links; their icons are replaced from the images tab (“Service icons”)."
            action={{ ar: 'أيقونات الخدمات', en: 'Service icons', onClick: () => setActiveTab('site-media') }}
          />
        )}

        {activeTab === 'site-media' && <SiteMediaSettings dir={dir} />}
      </div>
    </div>
  );
}

/** A section with nothing to type in says so, and names the screen that controls it. */
function InfoPanel({
  dir,
  ar,
  en,
  action,
}: {
  dir: string;
  ar: string;
  en: string;
  action?: { ar: string; en: string; onClick: () => void };
}) {
  const rtl = dir === 'rtl';
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
      <p className="text-sm text-zinc-300 leading-relaxed">{rtl ? ar : en}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="inline-flex items-center gap-2 min-h-[44px] px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm font-bold border border-zinc-700"
        >
          <ImageIcon className="w-4 h-4" aria-hidden="true" />
          {rtl ? action.ar : action.en}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------- the bento squares

type BentoDraft = Partial<Record<BentoPosition, { category: string; title: LocalizedText }>>;

/** The admin taxonomy list, only the fields this picker reads. */
interface CatalogOption {
  id: string;
  parent_id: string | null;
  name_ar: string;
  name_en: string;
  active: boolean | number;
  product_count: number;
}

const POSITION_LABELS: Record<BentoPosition, { ar: string; en: string }> = {
  large: { ar: 'المربع الكبير (على اليسار)', en: 'Large square (left in Arabic)' },
  'top-1': { ar: 'المستطيل العلوي الأول (يمين)', en: 'Top wide tile 1' },
  'top-2': { ar: 'المستطيل العلوي الثاني', en: 'Top wide tile 2' },
  'bottom-1': { ar: 'المربع السفلي الأول (يمين)', en: 'Bottom tile 1' },
  'bottom-2': { ar: 'المربع السفلي الثاني', en: 'Bottom tile 2' },
  'bottom-3': { ar: 'المربع السفلي الثالث', en: 'Bottom tile 3' },
};

const DEFAULT_LABELS: Record<string, { ar: string; en: string }> = {
  printers: { ar: 'الطابعات ثلاثية الأبعاد', en: '3D printers' },
  filament: { ar: 'Filament', en: 'Filament' },
  resin: { ar: 'Resin', en: 'Resin' },
  parts: { ar: 'قطع الغيار والمستلزمات', en: 'Spare parts & supplies' },
  accessories: { ar: 'الإكسسوارات والأدوات', en: 'Accessories & tools' },
  used: { ar: 'المنتجات المستعملة', en: 'Pre-owned' },
};

/**
 * «تسوق حسب الفئة» — WHICH SECTION GOES IN WHICH SQUARE (owner, 2026-09-26:
 * «يقرر ماذا يضع على اليسار في المربع الكبير وماذا يضع في المربعات الخمسة على
 * اليمين اثنين فوق وثلاثة في الأسفل»).
 *
 * One row per square: a section of the taxonomy (any depth) or the used
 * shelf, and an optional title per language. «تلقائي» keeps the built-in
 * section for that square, so a partial assignment is fine. The server
 * refuses a square or a section it does not know (worker/lib/homeBento.ts);
 * a section with no products is simply not drawn on the page.
 */
function BentoSettings({
  dir,
  value,
  onSaved,
  onImages,
}: {
  dir: string;
  value: BentoDraft;
  onSaved: (v: BentoDraft) => void;
  onImages: () => void;
}) {
  const rtl = dir === 'rtl';
  const [draft, setDraft] = useState<BentoDraft>(value);
  const [catalogs, setCatalogs] = useState<CatalogOption[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ catalogs: CatalogOption[] }>('/api/admin/taxonomy/catalogs')
      .then((d) => { if (!cancelled) setCatalogs(d.catalogs || []); })
      .catch((e) => { if (!cancelled) setCatalogError(e instanceof ApiError ? e.message : 'Failed to load sections'); });
    return () => { cancelled = true; };
  }, []);

  // The picker lists sections as a tree: each one after its parent, indented.
  const byParent = new Map<string | null, CatalogOption[]>();
  for (const c of catalogs) {
    if (!c.active) continue;
    const key = c.parent_id ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), c]);
  }
  const options: Array<{ c: CatalogOption; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of byParent.get(parent) ?? []) {
      if (options.length > 500 || depth > 8) return;
      options.push({ c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);

  const set = (position: BentoPosition, category: string) => {
    setState('idle');
    setDraft((prev) => {
      const next = { ...prev };
      if (!category) delete next[position];
      else next[position] = { category, title: prev[position]?.title ?? EMPTY_TEXT };
      return next;
    });
  };

  const save = async () => {
    setState('saving');
    setError(null);
    try {
      await api.put('/api/admin/settings/homeBento', { value: draft });
      setState('saved');
      onSaved(draft);
    } catch (e) {
      setState('error');
      setError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
      <div className="flex flex-wrap justify-between items-start mb-5 gap-4">
        <div className="min-w-0 max-w-2xl">
          <h3 className="text-xl font-bold text-white">{rtl ? 'تسوق حسب الفئة — ماذا يظهر في كل مربع' : 'Shop by category — what each square shows'}</h3>
          <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
            {rtl
              ? 'اختر لكل مربع قسمًا (رئيسيًا أو فرعيًا) أو «المنتجات المستعملة»، واكتب عنوانًا إن أردت. «تلقائي» يُبقي القسم الافتراضي. القسم الذي لا يحتوي على منتجات لا يظهر على الصفحة. صورة كل مربع (فاتح وداكن) تُرفع من تبويب الصور.'
              : 'Pick a section (main or sub) or “Pre-owned” for each square, and a title if you want one. “Automatic” keeps the built-in section. A section with no products is not drawn. Each square’s picture (light and dark) is uploaded in the images tab.'}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <SaveStatusLabel state={state} error={error} dir={dir} />
          <button
            type="button"
            onClick={onImages}
            className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-2 rounded-xl transition-colors font-bold border border-zinc-700"
          >
            <ImageIcon className="w-4 h-4" /> {rtl ? 'صور المربعات' : 'Square pictures'}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={state === 'saving'}
            className="flex items-center gap-2 bg-[#6B46FF] hover:bg-iris-deep text-snow px-4 py-2 rounded-xl transition-all font-bold disabled:opacity-50"
          >
            <Save className="w-4 h-4" /> {state === 'saving' ? (rtl ? 'جارٍ الحفظ...' : 'Saving...') : rtl ? 'حفظ' : 'Save'}
          </button>
        </div>
      </div>

      {catalogError && (
        <div role="alert" className="mb-4 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" /> {catalogError}
        </div>
      )}

      {/* A map of the six squares, as the page draws them in Arabic: the
          large square on the left, the two wide and three small on the right. */}
      <div dir="rtl" aria-hidden="true" className="mb-6 grid h-28 max-w-sm grid-cols-[58fr_42fr] gap-1.5 text-[10px] font-bold text-zinc-300">
        <div className="grid grid-rows-[1fr_1.08fr] gap-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            <span className="grid place-items-center rounded-md bg-zinc-800">1</span>
            <span className="grid place-items-center rounded-md bg-zinc-800">2</span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <span className="grid place-items-center rounded-md bg-zinc-800">3</span>
            <span className="grid place-items-center rounded-md bg-zinc-800">4</span>
            <span className="grid place-items-center rounded-md bg-zinc-800">5</span>
          </div>
        </div>
        <span className="grid place-items-center rounded-md bg-zinc-700">{rtl ? 'الكبير' : 'Large'}</span>
      </div>

      <div className="space-y-4">
        {BENTO_POSITIONS.map((position, i) => {
          const entry = draft[position];
          const preset = DEFAULT_LABELS[BENTO_DEFAULTS[position]];
          const chosen = entry ? catalogs.find((c) => c.id === entry.category) : undefined;
          const label = POSITION_LABELS[position];
          return (
            <div key={position} data-bento-admin={position} className="bg-zinc-800/50 p-4 rounded-2xl border border-zinc-700 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-zinc-700 text-xs font-bold text-white">
                  {position === 'large' ? '★' : i}
                </span>
                <span className="font-bold text-white">{rtl ? label.ar : label.en}</span>
                <select
                  value={entry?.category ?? ''}
                  onChange={(e) => set(position, e.target.value)}
                  aria-label={`${rtl ? 'القسم' : 'Section'} — ${rtl ? label.ar : label.en}`}
                  className="ms-auto min-h-[44px] min-w-[220px] max-w-full bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 text-sm text-white focus:border-iris outline-none"
                >
                  <option value="">{rtl ? `تلقائي (${preset.ar})` : `Automatic (${preset.en})`}</option>
                  <option value="used">{rtl ? 'المنتجات المستعملة (Open Box)' : 'Pre-owned (Open Box)'}</option>
                  {options.map(({ c, depth }) => (
                    <option key={c.id} value={c.id}>
                      {`${'— '.repeat(depth)}${rtl ? c.name_ar || c.name_en : c.name_en || c.name_ar} (${c.product_count})`}
                    </option>
                  ))}
                </select>
              </div>
              {chosen && chosen.product_count === 0 && (
                <p className="text-[12px] text-amber-400">
                  {rtl ? 'هذا القسم لا يحتوي على منتجات الآن، لذلك لن يظهر هذا المربع حتى تُضاف له منتجات.' : 'This section has no products now, so the square stays hidden until it does.'}
                </p>
              )}
              {entry && (
                <LocalizedField
                  label={rtl ? 'عنوان المربع' : 'Square title'}
                  hint={rtl ? 'اتركه فارغًا لاستخدام اسم القسم. لا يُترجم آليًا — اكتب كل لغة بنفسك.' : 'Leave empty to use the section’s name. Nothing is auto-translated.'}
                  value={asText(entry.title)}
                  onChange={(v) => {
                    setState('idle');
                    setDraft((prev) => ({ ...prev, [position]: { category: entry.category, title: v } }));
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The long edge a home photograph is re-encoded to before upload — sharp on a 1920 px screen at 2x for a half-width picture. */
const HOME_PHOTO_EDGE = 2_400;

/**
 * THE HOME PAGE'S PICTURES, ONE PAIR PER PICTURE (owner, 2026-09-26: «يضع
 * صورتين تناسب الثيم الفاتح والثيم الداكن»).
 *
 * One row per picture the page draws full-bleed — the hero, the six squares
 * of «تسوق حسب الفئة» and the two editorial banners — each with a light-theme
 * and a dark-theme cell: a live preview, an upload and a clear. The slots are
 * the server's allow-list (worker/lib/siteMedia.ts HOME_PHOTO_SLOTS), so this
 * list is built from what `/api/admin/site-media` answers, never typed here.
 *
 * The preview plates are FIXED colours — the cream of the light page and the
 * near-black of the dark one — not theme roles, because the question each
 * cell answers is "how does this look on THAT theme", whatever theme the admin
 * panel itself is in. The frame is the same wide proportion as a banner and
 * the picture is cropped with `object-cover` from the centre, as the page
 * draws it; a square or a tall tile shows the middle of the same picture.
 */
function HomePhotoPairs({
  rtl,
  media,
  busySlot,
  slotError,
  onUpload,
  onClear,
}: {
  rtl: boolean;
  media: SiteMediaEntry[];
  busySlot: string | null;
  slotError: Record<string, string>;
  onUpload: (slot: string, file: File) => void;
  onClear: (slot: string) => void;
}) {
  const rows = media.filter((m) => m.group === 'home' && m.target);
  if (rows.length === 0) return null;
  const targets = [...new Set(rows.map((m) => m.target!))];
  const labelOf = (m: SiteMediaEntry) => m.label.replace(/ — الثيم (الفاتح|الداكن)$/, '');

  return (
    <div className="mb-7">
      <h4 className="text-sm font-bold text-white mb-1">{rtl ? 'صور الصفحة الرئيسية — فاتح وداكن' : 'Home page pictures — light and dark'}</h4>
      <p className="text-xs text-zinc-500 mb-3 leading-relaxed">
        {rtl
          ? 'لكل صورة نسختان: للثيم الفاتح وللثيم الداكن. إن رفعت واحدة فقط تُستخدم للثيمين، وإن لم ترفع شيئًا تظهر صورة منتج تلقائيًا. الصورة تملأ البطاقة وتُقصّ من المنتصف، فاجعل الموضوع في وسطها واترك الزاوية السفلية لجهة النص هادئة. PNG أو JPEG أو WebP.'
          : 'Each picture has two versions, for the light and the dark theme. Upload only one and it is used for both; upload none and a product photo is used. The picture fills its card and is cropped from the centre, so keep the subject central and the bottom corner on the reading side calm. PNG, JPEG or WebP.'}
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        {targets.map((target) => {
          const pair = (['light', 'dark'] as const).map((theme) => rows.find((m) => m.target === target && m.theme === theme));
          const title = pair[0] ? labelOf(pair[0]) : target;
          return (
            <div key={target} data-home-photo={target} className="bg-zinc-950/60 border border-zinc-800 rounded-2xl p-3">
              <div className="text-sm font-bold text-white mb-2">{title}</div>
              <div className="grid grid-cols-2 gap-2">
                {pair.map((m, i) => {
                  if (!m) return <div key={i} />;
                  const busy = busySlot === m.slot;
                  const light = m.theme === 'light';
                  return (
                    <div key={m.slot} className="min-w-0">
                      <div
                        data-plate={light ? 'light' : 'dark'}
                        className="lv-preview-plate relative aspect-[16/10] overflow-hidden rounded-xl border"
                      >
                        {m.url ? (
                          <img src={m.url} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                        ) : (
                          <span className="absolute inset-0 grid place-items-center text-[11px]">
                            {rtl ? 'تلقائي' : 'Automatic'}
                          </span>
                        )}
                        <span className="lv-preview-tag absolute top-1.5 start-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold">
                          {light ? (rtl ? 'فاتح' : 'Light') : (rtl ? 'داكن' : 'Dark')}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        {/* `sr-only`, not `hidden`: the input stays in the focus order (see the rows below). */}
                        <label
                          className={`has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus flex flex-1 items-center justify-center gap-1.5 px-2 py-2 min-h-[44px] bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg cursor-pointer transition-colors border border-zinc-700 text-xs font-bold ${busy ? 'opacity-50 pointer-events-none' : ''}`}
                        >
                          <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                          {busy ? (rtl ? 'جارٍ الرفع…' : 'Uploading…') : (rtl ? 'رفع' : 'Upload')}
                          <span className="sr-only">{` — ${m.label}`}</span>
                          <input
                            type="file"
                            className="sr-only"
                            accept="image/webp,image/png,image/jpeg,.webp,.png,.jpg,.jpeg"
                            disabled={busy}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.target.value = '';
                              if (file) onUpload(m.slot, file);
                            }}
                          />
                        </label>
                        {m.custom && (
                          <button
                            type="button"
                            onClick={() => onClear(m.slot)}
                            disabled={busy}
                            aria-label={`${rtl ? 'مسح الصورة' : 'Clear the picture'} — ${m.label}`}
                            title={rtl ? 'مسح الصورة' : 'Clear the picture'}
                            className="px-2.5 py-2 min-h-[44px] bg-zinc-800 hover:bg-red-500/10 text-zinc-400 hover:text-red-400 rounded-lg border border-zinc-700 text-xs font-bold disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      {slotError[m.slot] && (
                        <span role="alert" className="block text-[11px] text-red-400 mt-1">{slotError[m.slot]}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * THE BRAND MARKS AND SERVICE ICONS ON THE FIRST SCREEN.
 *
 * Unlike every other panel here, this one does NOT stage edits and save them
 * in a batch. An upload is a write to R2 that either happened or did not, so
 * there is nothing meaningful to hold in a draft and nothing to "discard" —
 * the server returns the new resolved list and that IS the state. Each row is
 * therefore independently live, and a failed upload leaves the other rows
 * untouched instead of poisoning a whole-form save.
 *
 * WebP is refused CLIENT-side as well as on the server. The server's check is
 * the one that counts (it sniffs magic bytes; a renamed .png will not pass),
 * but telling someone their PNG is wrong before a 2 MB round trip is the
 * difference between a rule and an obstacle.
 */
function SiteMediaSettings({ dir }: { dir: string }) {
  const rtl = dir === 'rtl';
  const [media, setMedia] = useState<SiteMediaEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [slotError, setSlotError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<{ media: SiteMediaEntry[] }>('/api/admin/site-media');
      setMedia(data.media || []);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const upload = async (slot: string, file: File, photo = false) => {
    setSlotError((p) => ({ ...p, [slot]: '' }));
    // A home PHOTOGRAPH may be a PNG or JPEG: it is re-encoded to WebP here
    // when the browser can (the upload shrinks on the way), and the server
    // converts whatever still is not. Brand marks and service icons keep the
    // owner's WebP-only rule.
    if (!photo && !/\.webp$/i.test(file.name) && file.type !== 'image/webp') {
      setSlotError((p) => ({ ...p, [slot]: rtl ? 'الصيغة يجب أن تكون WebP فقط' : 'The file must be a WebP image' }));
      return;
    }
    setBusySlot(slot);
    try {
      if (photo) file = (await prepareProductImage(file, (f) => encodeProductRasterAsWebp(f, HOME_PHOTO_EDGE))).file;
      const form = new FormData();
      form.append('file', file);
      form.append('originalName', file.name);
      const data = await api.post<{ media: SiteMediaEntry[] }>(`/api/admin/site-media/${encodeURIComponent(slot)}`, form);
      setMedia(data.media || []);
    } catch (err) {
      setSlotError((p) => ({ ...p, [slot]: err instanceof ApiError ? err.message : 'Upload failed' }));
    } finally {
      setBusySlot(null);
    }
  };

  const reset = async (slot: string) => {
    setBusySlot(slot);
    setSlotError((p) => ({ ...p, [slot]: '' }));
    try {
      const data = await api.delete<{ media: SiteMediaEntry[] }>(`/api/admin/site-media/${encodeURIComponent(slot)}`);
      setMedia(data.media || []);
    } catch (err) {
      setSlotError((p) => ({ ...p, [slot]: err instanceof ApiError ? err.message : 'Reset failed' }));
    } finally {
      setBusySlot(null);
    }
  };

  const GROUPS: Array<{ group: SiteMediaEntry['group']; titleAr: string; titleEn: string; noteAr: string; noteEn: string }> = [
    {
      group: 'brand',
      titleAr: 'شعارات العلامات التجارية', titleEn: 'Brand logos',
      noteAr:
        'تظهر في قسم «أبرز العلامات» على الصفحة الرئيسية — بدون إطار وبدون اسم. ' +
        'ارفع الشعار بخلفية شفافة: الشعار الذي خلفيته بيضاء سيظهر كمربّع أبيض على الصفحة السوداء. ' +
        'المعاينة هنا بخلفية داكنة لأنها ما سيراه الزبون.',
      noteEn:
        'Shown in the “Top brands” section on the home page — no frame, no caption. ' +
        'Upload the logo on a TRANSPARENT background: one exported on white will show as a white ' +
        'box on the black page. The preview here is dark because that is what a shopper sees.',
    },
    {
      /**
       * TWO SENTENCES THAT STOPPED BEING TRUE, AND ONE THAT IS THE OPPOSITE OF
       * WHAT THIS GROUP NEEDS.
       *
       * 1. «اتركها فارغة لإبقاء الأيقونة الحالية» was true while every service
       *    slot had an EMPTY default. Every one of the eleven now seeds a real
       *    object in worker/lib/siteMedia.ts, so clearing a slot restores the
       *    seeded artwork rather than keeping whatever is on screen.
       *
       * 2. THE BACKGROUND RULE IS THE REVERSE OF THE BRAND-LOGO RULE ABOVE, and
       *    the two sit side by side on one screen. A service tile composites
       *    its icon with `mix-blend-screen`, and screen(0, b) = b exactly —
       *    which is why a pure-black background disappears into the card. The
       *    same blend has screen(white, b) = white, so an icon exported on a
       *    WHITE background turns the tile into a solid white square. The
       *    transparent-background warning next to this one is written for brand
       *    marks, which are drawn normally; repeating it here would tell the
       *    owner to do the one thing that breaks these.
       */
      group: 'service',
      titleAr: 'أيقونات الخدمات', titleEn: 'Service icons',
      noteAr:
        'تستبدل الأيقونة المرسومة في شريط الخدمات. مسح الخانة يرجّعها للأيقونة الأصلية المرفوعة، مو يخليها فارغة. ' +
        'مهم: صدّر أيقونة الخدمة بخلفية سوداء نقية (#000000) أو بشفافية حقيقية — البلاطة تدمج الصورة بطريقة تُخفي الأسود تماماً، ' +
        'أما الخلفية البيضاء فتتحول إلى مربّع أبيض كامل.',
      noteEn:
        'Replaces the drawn icon on the services rail. Clearing a slot restores the seeded artwork, it does not leave it empty. ' +
        'Important: export a service icon on a PURE BLACK background (#000000) or with real transparency — the tile blends the ' +
        'image in a way that makes black vanish into the card, while a white background becomes a solid white square.',
    },
    {
      /**
       * THE OLD SINGLE-PICTURE SLOTS. `banner-1` / `banner-2` were the one
       * picture of each editorial banner before the light/dark pairs above;
       * they are still honoured as a fallback when a banner has no pair, and
       * `banner-3` was never drawn. Listed only when one is actually set, so
       * the owner can clear it — never offered for a new upload.
       */
      group: 'banner',
      titleAr: 'صور قديمة (غير مستخدمة إلا كاحتياط)', titleEn: 'Old single images (fallback only)',
      noteAr: 'صورة واحدة قديمة لكل بانر تحريري. صور «فاتح/داكن» أعلاه تحلّ محلّها؛ امسحها إن لم تعد تريدها.',
      noteEn: 'The older one-picture slots for the editorial banners. The light/dark pairs above take precedence; clear these if you no longer want them.',
    },
  ];

  if (loading) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 text-zinc-400 text-sm">
        {rtl ? 'جارٍ التحميل…' : 'Loading…'}
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
      <div className="mb-5">
        <h3 className="text-lg font-bold text-white">{rtl ? 'صور وأيقونات الصفحة الرئيسية' : 'Main page images & icons'}</h3>
        <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
          {rtl
            ? 'تُحفظ كلها في مجلد UiUx/MainPage داخل التخزين العام بصيغة WebP (صور الصفحة تُحوَّل تلقائيًا من PNG/JPEG). كل رفع ينشئ ملفًا جديدًا حتى لا تبقى النسخة القديمة محفوظة في ذاكرة المتصفحات.'
            : 'All of these live in UiUx/MainPage in public storage as WebP (page photographs are converted from PNG/JPEG for you). Every upload writes a NEW file, so browsers and edge caches cannot keep serving the old one.'}
        </p>
      </div>

      {loadError && (
        <div role="alert" className="mb-4 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" /> {loadError}
          <button onClick={() => void load()} className="underline font-bold">{rtl ? 'إعادة المحاولة' : 'Retry'}</button>
        </div>
      )}

      <HomePhotoPairs
        rtl={rtl}
        media={media}
        busySlot={busySlot}
        slotError={slotError}
        onUpload={(slot, file) => void upload(slot, file, true)}
        onClear={(slot) => void reset(slot)}
      />

      {GROUPS.map((g) => {
        const rows = media.filter((m) => m.group === g.group && (g.group !== 'banner' || m.custom));
        if (rows.length === 0) return null;
        return (
          <div key={g.group} className="mb-7 last:mb-0">
            <h4 className="text-sm font-bold text-white mb-1">{rtl ? g.titleAr : g.titleEn}</h4>
            <p className="text-xs text-zinc-500 mb-3">{rtl ? g.noteAr : g.noteEn}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {rows.map((m) => (
                <div key={m.slot} className="flex items-center gap-3 bg-zinc-950/60 border border-zinc-800 rounded-2xl p-3">
                  {/* A DARK PLATE, BECAUSE THE STOREFRONT IS DARK. This preview
                      used to be `bg-zinc-100`, so a logo exported on a white
                      matte looked perfect here and rendered as a white box on
                      the black home page — the one screen where the owner could
                      have spotted the problem was the one screen hiding it. The
                      owner can only fix what they can see, and the Upload button
                      that fixes it is two centimetres away. */}
                  <span className="w-12 h-12 shrink-0 rounded-xl bg-zinc-950 border border-zinc-800 grid place-items-center overflow-hidden">
                    {m.url
                      ? <img src={m.url} alt="" width={48} height={48} loading="lazy" decoding="async" className="w-full h-full object-contain p-1" />
                      : <ImageIcon className="w-5 h-5 text-zinc-500" aria-hidden="true" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-white truncate">{m.label}</span>
                    <span className="block text-[11px] text-zinc-500 truncate">
                      {m.custom
                        ? (rtl ? 'صورة مرفوعة' : 'Uploaded image')
                        : m.url
                          ? (rtl ? 'الصورة الافتراضية' : 'Default image')
                          : (rtl ? 'لا توجد صورة' : 'No image')}
                    </span>
                    {slotError[m.slot] && (
                      <span role="alert" className="block text-[11px] text-red-400 mt-0.5">{slotError[m.slot]}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {/* `sr-only`, NOT `hidden`. A file input inside a label is
                        the standard way to style an upload control, but
                        `display: none` also removes it from the focus order —
                        and since a <label> is not focusable either, the whole
                        control becomes unreachable by keyboard. Visually hidden
                        keeps it focusable, and `has-[:focus-visible]` paints
                        the ring on the part the eye can actually see. (`peer-*`
                        would be wrong here: the input is a DESCENDANT of the
                        label, not a preceding sibling.) */}
                    <label
                      className={`has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus flex items-center gap-1.5 px-3 py-2 min-h-[44px] bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg cursor-pointer transition-colors border border-zinc-700 text-xs font-bold ${busySlot === m.slot ? 'opacity-50 pointer-events-none' : ''}`}
                    >
                      <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                      {busySlot === m.slot ? (rtl ? 'جارٍ الرفع…' : 'Uploading…') : (rtl ? 'رفع' : 'Upload')}
                      <span className="sr-only">{` — ${m.label}`}</span>
                      <input
                        type="file"
                        className="sr-only"
                        accept="image/webp,.webp"
                        disabled={busySlot === m.slot}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (file) void upload(m.slot, file);
                        }}
                      />
                    </label>
                    {m.custom && (
                      <button
                        type="button"
                        onClick={() => void reset(m.slot)}
                        disabled={busySlot === m.slot}
                        aria-label={`${rtl ? 'العودة للصورة الافتراضية' : 'Back to the default image'} — ${m.label}`}
                        title={rtl ? 'العودة للصورة الافتراضية' : 'Back to the default image'}
                        className="px-2.5 py-2 min-h-[44px] bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white rounded-lg border border-zinc-700 text-xs font-bold disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Subcomponents for managing individual sections — state lives in the parent
// and is saved to the server settings, never to localStorage.
function BannerSettings({ titleEn, titleAr, banners, onChange, onSave, saveState, saveError }: {
  id: string;
  titleEn: string;
  titleAr: string;
  banners: Banner[];
  onChange: (banners: Banner[]) => void;
  onSave: () => void;
  saveState: SaveState;
  saveError: string | null;
}) {
  const { dir } = useLanguage();

  const add = () => {
    onChange([
      ...banners,
      { id: 'bn_' + Date.now(), image: '', link: '', title: EMPTY_TEXT, subtitle: EMPTY_TEXT, cta: EMPTY_TEXT },
    ]);
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
      <div className="flex justify-between items-center mb-6 gap-4">
        <h3 className="text-xl font-bold text-white">{dir === 'rtl' ? titleAr : titleEn}</h3>
        <div className="flex items-center gap-3">
          <SaveStatusLabel state={saveState} error={saveError} dir={dir} />
          <button onClick={add} className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-2 rounded-xl transition-colors font-bold">
            <Plus className="w-4 h-4" /> {dir === 'rtl' ? 'إضافة بانر' : 'Add Banner'}
          </button>
          <button onClick={onSave} disabled={saveState === 'saving'} className="flex items-center gap-2 bg-[#6B46FF] hover:bg-iris-deep text-snow px-4 py-2 rounded-xl transition-all font-bold disabled:opacity-50">
            <Save className="w-4 h-4" /> {saveState === 'saving' ? (dir === 'rtl' ? 'جارٍ الحفظ...' : 'Saving...') : dir === 'rtl' ? 'حفظ' : 'Save'}
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {banners.map((b, i) => (
          <div key={b.id} className="bg-zinc-800/50 p-4 rounded-2xl border border-zinc-700 flex flex-col md:flex-row gap-4">
            <div className="w-32 h-20 bg-zinc-900 border border-zinc-700 rounded-xl overflow-hidden flex items-center justify-center shrink-0">
              {b.image ? (
                <img src={b.image || undefined} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
              ) : (
                <ImageIcon className="w-8 h-8 text-zinc-600" />
              )}
            </div>
            <div className="flex-1 space-y-3">
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">Image URL</label>
                <ImageField
                  value={b.image}
                  onChange={(url) => {
                    const nb = banners.map((x, xi) => xi === i ? { ...x, image: url } : x);
                    onChange(nb);
                  }}
                  dir={dir}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">Link URL</label>
                <input
                  type="text"
                  value={b.link}
                  onChange={(e) => {
                    const nb = banners.map((x, xi) => xi === i ? { ...x, link: e.target.value } : x);
                    onChange(nb);
                  }}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-iris outline-none min-h-[44px]"
                  placeholder="/products?category=cat_printers"
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  {dir === 'rtl'
                    ? 'مسار داخلي يبدأ بـ / أو رابط http(s). أي شيء آخر يُهمَل.'
                    : 'An internal path starting with / or an http(s) URL. Anything else is dropped.'}
                </p>
              </div>

              {/* The hero copy. All three languages optional — leave them all
                  empty for a picture-only banner, exactly as before. */}
              <LocalizedField
                label={dir === 'rtl' ? 'العنوان' : 'Headline'}
                hint={
                  dir === 'rtl'
                    ? 'يظهر فوق الصورة. اتركه فارغًا لعرض الصورة وحدها. لا تُترجم آليًا — اكتب ما تريده بكل لغة.'
                    : 'Shown over the image. Leave empty for a picture-only banner. Nothing is auto-translated — write each language yourself.'
                }
                value={asText(b.title)}
                onChange={(v) => onChange(banners.map((x, xi) => (xi === i ? { ...x, title: v } : x)))}
              />
              <LocalizedField
                label={dir === 'rtl' ? 'الوصف' : 'Sub-line'}
                value={asText(b.subtitle)}
                onChange={(v) => onChange(banners.map((x, xi) => (xi === i ? { ...x, subtitle: v } : x)))}
                multiline
              />
              <LocalizedField
                label={dir === 'rtl' ? 'نص الزر' : 'Button label'}
                hint={
                  dir === 'rtl'
                    ? 'اتركه فارغًا ليصبح البانر كله قابلًا للنقر بدل زر منفصل.'
                    : 'Leave empty to make the whole banner clickable instead of showing a button.'
                }
                value={asText(b.cta)}
                onChange={(v) => onChange(banners.map((x, xi) => (xi === i ? { ...x, cta: v } : x)))}
              />
            </div>
            <button
              onClick={() => {
                if (!window.confirm(dir === 'rtl' ? 'حذف هذا البانر؟' : 'Delete this banner?')) return;
                onChange(banners.filter(x => x.id !== b.id));
              }}
              className="p-3 bg-zinc-900 hover:bg-red-500/10 text-zinc-500 hover:text-red-500 rounded-xl transition-colors border border-zinc-800 self-start"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        ))}
        {banners.length === 0 && (
          <div className="text-center text-zinc-500 py-8">No banners added yet.</div>
        )}
      </div>
    </div>
  );
}
