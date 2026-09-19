import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, uploadFile } from '../lib/api';
import type { SiteMediaEntry } from '../lib/api';
import { GripVertical, Plus, Settings, Eye, EyeOff, Save, Trash2, LayoutTemplate, Megaphone, Image as ImageIcon, Ticket, Tag, Star, ArrowLeft, ArrowRight, ChevronUp, ChevronDown, Upload, Check, AlertTriangle, Package, PackageOpen, RotateCcw, TrendingUp, Zap, Sparkles, Boxes, Palette } from 'lucide-react';
import AdminAds from './AdminAds';

interface HomeSection {
  id: string;
  titleEn: string;
  titleAr: string;
  isVisible: boolean;
}
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
    'w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none min-h-[44px]';
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
interface SectionItem { id: string; title: string; subtitle: string; image: string; link: string }

// The icon lookup stays client-side by id — icons are never sent to the server.
const SECTION_ICONS: Record<string, React.ElementType> = {
  ads_panel: Megaphone,
  first_banner: ImageIcon,
  second_banner: ImageIcon,
  coupons_offers: Ticket,
  categories: LayoutTemplate,
  discounts_offers: Tag,
  top_brands: Star,
  open_box: PackageOpen,
  bundles: Package,
  best_sellers: TrendingUp,
  flash_deals: Zap,
  spotlight: Sparkles,
  combos: Boxes,
  filament: Palette,
};

const INITIAL_SECTIONS: HomeSection[] = [
  { id: 'ads_panel', titleEn: 'Ads Panel', titleAr: 'لوحة الاعلانات', isVisible: true },
  { id: 'first_banner', titleEn: 'First Banner', titleAr: 'الشريط الاول', isVisible: true },
  { id: 'second_banner', titleEn: 'Second Banner', titleAr: 'الشريط الثاني', isVisible: true },
  { id: 'coupons_offers', titleEn: 'Coupons & Offers Section', titleAr: 'القسم الذي يحتوي على كوبونات وعروض', isVisible: true },
  { id: 'categories', titleEn: 'Main & Sub Categories', titleAr: 'الأقسام الرئيسية والفرعية', isVisible: true },
  { id: 'discounts_offers', titleEn: 'Discounts & Offers under categories', titleAr: 'القسم لخصومات المنتجات والعروض تحت الأقسام', isVisible: true },
  { id: 'top_brands', titleEn: 'Top Brands Section', titleAr: 'قسم top brands', isVisible: true },
  // Open box / used / refurbished. Registered HERE and not only in Home.tsx:
  // `orderOf` and `sectionVisible` read settings.homeSections, which
  // mergeSections builds from this list, so a section missing from it is
  // pinned to the bottom of the page for ever and can never be hidden.
  { id: 'open_box', titleEn: 'Open Box & Used', titleAr: 'قسم المستعمل و Open Box', isVisible: true },
  // Registering the shelf in src/pages/Home.tsx is NOT enough: `orderOf` and
  // `sectionVisible` read settings.homeSections, which mergeSections builds
  // from this list. A section id missing here is pinned to the bottom of the
  // home page for ever, cannot be hidden, and never appears in the admin's
  // drag-to-reorder list (docs/BUNDLES_MYSTERY.md §13.2).
  { id: 'bundles', titleEn: 'Bundles & Offers Shelf', titleAr: 'رف الباقات والعروض', isVisible: true },
  /**
   * THE SHELVES BELOW THE FOLD, each drawn differently on purpose — the owner
   * asked for that explicitly: «لا تجعلها كلها يتبع نفس النمط وهو الشريط
   * الأفقي». They have no editable CARDS here: their contents come from the
   * catalogue itself (units sold, scheduled offers, the materials branch, the
   * `is_featured` flag), so what this panel controls is the ORDER and whether
   * each one appears at all. A shelf with nothing to show renders nothing,
   * whatever its toggle says.
   */
  { id: 'best_sellers', titleEn: 'Best sellers', titleAr: 'الأكثر مبيعًا', isVisible: true },
  { id: 'flash_deals', titleEn: 'Flash deals (scheduled offers)', titleAr: 'العروض السريعة (العروض المجدولة)', isVisible: true },
  { id: 'spotlight', titleEn: 'Selection & Super deals tiles', titleAr: 'بطاقتا «مختارات لك» و«صفقات مميّزة»', isVisible: true },
  { id: 'combos', titleEn: 'Combos', titleAr: 'الكومبو', isVisible: true },
  { id: 'filament', titleEn: 'Filament picks', titleAr: 'مختارات الفيلمنت', isVisible: true },
];

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function mergeSections(saved: HomeSection[]): HomeSection[] {
  // Preserve the saved order/visibility; refresh titles from INITIAL_SECTIONS
  // and append any sections added since the last save.
  const merged: HomeSection[] = saved.map((s) => {
    const found = INITIAL_SECTIONS.find(i => i.id === s.id);
    return found ? { ...found, isVisible: s.isVisible ?? true } : s;
  });
  INITIAL_SECTIONS.forEach(i => {
    if (!merged.find(m => m.id === i.id)) merged.push(i);
  });
  return merged;
}

function SaveStatusLabel({ state, error, dir }: { state: SaveState; error: string | null; dir: string }) {
  if (state === 'saved') {
    return (
      <span className="text-xs font-bold text-[#2CE59B] flex items-center gap-1">
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
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none"
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

export default function AdminHomeSettings() {
  const { dir } = useLanguage();
  const [sections, setSections] = useState<HomeSection[]>(INITIAL_SECTIONS);
  const [banners, setBanners] = useState<Record<string, Banner[]>>({});
  const [sectionItems, setSectionItems] = useState<Record<string, SectionItem[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('layout');
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const [layoutState, setLayoutState] = useState<SaveState>('idle');
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [bannersState, setBannersState] = useState<SaveState>('idle');
  const [bannersError, setBannersError] = useState<string | null>(null);
  const [itemsState, setItemsState] = useState<SaveState>('idle');
  const [itemsError, setItemsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await api.get<{ settings: {
          homeSections: HomeSection[];
          homeBanners: Record<string, Banner[]>;
          homeSectionItems: Record<string, SectionItem[]>;
        } }>('/api/admin/settings');
        if (cancelled) return;
        setSections(mergeSections(Array.isArray(data.settings.homeSections) ? data.settings.homeSections : []));
        setBanners(data.settings.homeBanners && typeof data.settings.homeBanners === 'object' ? data.settings.homeBanners : {});
        setSectionItems(data.settings.homeSectionItems && typeof data.settings.homeSectionItems === 'object' ? data.settings.homeSectionItems : {});
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

  const moveSection = (from: number, to: number) => {
    if (to < 0 || to >= sections.length || from === to) return;
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

  const saveLayout = async () => {
    setLayoutState('saving');
    setLayoutError(null);
    try {
      // Only plain data goes to the server (no icon components).
      const value = sections.map(({ id, titleEn, titleAr, isVisible }) => ({ id, titleEn, titleAr, isVisible }));
      await api.put('/api/admin/settings/homeSections', { value });
      setLayoutState('saved');
    } catch (e) {
      setLayoutState('error');
      setLayoutError(e instanceof ApiError ? e.message : 'Save failed');
    }
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

  const saveSectionItems = async (next: Record<string, SectionItem[]>) => {
    setItemsState('saving');
    setItemsError(null);
    try {
      await api.put('/api/admin/settings/homeSectionItems', { value: next });
      setItemsState('saved');
    } catch (e) {
      setItemsState('error');
      setItemsError(e instanceof ApiError ? e.message : 'Save failed');
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-black text-white">{dir === 'rtl' ? 'إعدادات الصفحة الرئيسية' : 'Home Settings'}</h2>
      </div>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 mb-6 text-sm font-medium">
          {loadError}
        </div>
      )}

      {/* Horizontal Tabs */}
      <div className="relative mb-8 bg-zinc-900/50 p-2 rounded-2xl border border-zinc-800 flex items-center">
        <button onClick={() => scrollTabs('left')} className="p-2 text-zinc-400 hover:text-white transition-colors z-10 shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div ref={scrollContainerRef} className="flex-1 overflow-x-auto hide-scrollbar flex items-center gap-2 px-2 scroll-smooth">
          <button
            onClick={() => setActiveTab('layout')}
            className={`flex items-center gap-2 whitespace-nowrap px-4 py-2.5 rounded-xl font-bold transition-all shrink-0 ${
              activeTab === 'layout' ? 'bg-[#6B46FF] text-white shadow-lg' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'
            }`}
          >
            <LayoutTemplate className="w-4 h-4" />
            {dir === 'rtl' ? 'ترتيب وإظهار الأقسام' : 'Layout & Visibility'}
          </button>

          <button
            onClick={() => setActiveTab('site-media')}
            className={`flex items-center gap-2 whitespace-nowrap px-4 py-2.5 rounded-xl font-bold transition-all shrink-0 ${
              activeTab === 'site-media' ? 'bg-[#6B46FF] text-white shadow-lg' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'
            }`}
          >
            <ImageIcon className="w-4 h-4" />
            {dir === 'rtl' ? 'صور وأيقونات الصفحة الرئيسية' : 'Main page images'}
          </button>

          {INITIAL_SECTIONS.map((section) => {
            const Icon = SECTION_ICONS[section.id] || LayoutTemplate;
            return (
              <button
                key={section.id}
                onClick={() => setActiveTab(section.id)}
                className={`flex items-center gap-2 whitespace-nowrap px-4 py-2.5 rounded-xl font-bold transition-all shrink-0 ${
                  activeTab === section.id ? 'bg-[#6B46FF] text-white shadow-lg' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4" />
                {dir === 'rtl' ? section.titleAr : section.titleEn}
              </button>
            );
          })}
        </div>

        <button onClick={() => scrollTabs('right')} className="p-2 text-zinc-400 hover:text-white transition-colors z-10 shrink-0">
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1">
        {activeTab === 'layout' && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
            <div className="flex justify-between items-center mb-6 gap-4">
              <p className="text-zinc-400 text-sm">
                {dir === 'rtl' ? 'قم بسحب وإفلات الأقسام لإعادة ترتيبها في الصفحة الرئيسية. يمكنك أيضاً إخفاء أو إظهار أقسام محددة.' : 'Drag and drop sections to reorder them on the home page. You can also toggle their visibility.'}
              </p>
              <div className="flex items-center gap-3 shrink-0">
                <SaveStatusLabel state={layoutState} error={layoutError} dir={dir} />
                <button
                  onClick={saveLayout}
                  disabled={layoutState === 'saving'}
                  className="flex items-center gap-2 bg-[#2CE59B] hover:bg-[#06D6A0] text-[#09090b] px-5 py-2.5 rounded-xl transition-all font-bold shadow-lg disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  {layoutState === 'saving' ? (dir === 'rtl' ? 'جارٍ الحفظ...' : 'Saving...') : dir === 'rtl' ? 'حفظ الترتيب' : 'Save Layout'}
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {sections.map((section, index) => (
                <div
                  key={section.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragOver={handleDragOver}
                  className={`flex items-center justify-between p-4 bg-zinc-800/50 border ${section.isVisible ? 'border-zinc-700' : 'border-zinc-800 opacity-50'} rounded-2xl cursor-move hover:bg-zinc-800 transition-colors group`}
                >
                  <div className="flex items-center gap-4">
                    <div className="p-2 text-zinc-500 group-hover:text-zinc-300 transition-colors">
                      <GripVertical className="w-5 h-5" />
                    </div>
                    <div className="flex flex-col">
                      <span className="font-bold text-white text-base">
                        {dir === 'rtl' ? section.titleAr : section.titleEn}
                      </span>
                      <span className="text-xs text-zinc-500 font-mono">{section.id}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => moveSection(index, index - 1)}
                      disabled={index === 0}
                      className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors disabled:opacity-30"
                      title={dir === 'rtl' ? 'تحريك للأعلى' : 'Move up'}
                    >
                      <ChevronUp className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => moveSection(index, index + 1)}
                      disabled={index === sections.length - 1}
                      className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors disabled:opacity-30"
                      title={dir === 'rtl' ? 'تحريك للأسفل' : 'Move down'}
                    >
                      <ChevronDown className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => toggleVisibility(section.id)}
                      className={`p-2 rounded-xl transition-colors ${section.isVisible ? 'text-[#2CE59B] hover:bg-[#2CE59B]/10' : 'text-zinc-500 hover:bg-zinc-700'}`}
                      title={section.isVisible ? 'Hide section' : 'Show section'}
                    >
                      {section.isVisible ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
                    </button>
                    <button onClick={() => setActiveTab(section.id)} className="p-2 text-zinc-400 hover:text-[#6B46FF] hover:bg-[#6B46FF]/10 rounded-xl transition-colors">
                      <Settings className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'ads_panel' && (
          <AdminAds />
        )}

        {(activeTab === 'first_banner' || activeTab === 'second_banner') && (
          <BannerSettings
            id={activeTab}
            titleEn={activeTab === 'first_banner' ? 'First Banner' : 'Second Banner'}
            titleAr={activeTab === 'first_banner' ? 'الشريط الاول' : 'الشريط الثاني'}
            banners={banners[activeTab] || []}
            onChange={(list) => { setBanners(prev => ({ ...prev, [activeTab]: list })); setBannersState('idle'); }}
            onSave={() => saveBanners(banners)}
            saveState={bannersState}
            saveError={bannersError}
          />
        )}

        {(activeTab === 'coupons_offers' || activeTab === 'categories' || activeTab === 'discounts_offers' || activeTab === 'top_brands') && (
          <GenericSectionSettings
            id={activeTab}
            titleEn={
              activeTab === 'coupons_offers' ? 'Coupons & Offers' :
              activeTab === 'categories' ? 'Categories' :
              activeTab === 'discounts_offers' ? 'Discounts & Offers' : 'Top Brands'
            }
            titleAr={
              activeTab === 'coupons_offers' ? 'إدارة الكوبونات والعروض' :
              activeTab === 'categories' ? 'إدارة الأقسام الرئيسية والفرعية' :
              activeTab === 'discounts_offers' ? 'إدارة خصومات المنتجات' : 'إدارة أفضل العلامات التجارية (Brands)'
            }
            items={sectionItems[activeTab] || []}
            onChange={(list) => { setSectionItems(prev => ({ ...prev, [activeTab]: list })); setItemsState('idle'); }}
            onSave={() => saveSectionItems(sectionItems)}
            saveState={itemsState}
            saveError={itemsError}
          />
        )}

        {activeTab === 'site-media' && <SiteMediaSettings dir={dir} />}

        {DATA_DRIVEN_SECTIONS[activeTab] && (
          <DataDrivenSectionPanel dir={dir} info={DATA_DRIVEN_SECTIONS[activeTab]} />
        )}
      </div>
    </div>
  );
}

/**
 * THE SECTIONS WITH NOTHING TO TYPE IN, AND WHY THAT IS NOT A BLANK SCREEN.
 *
 * Picking «الأكثر مبيعًا» or «رف الباقات» in the tab bar used to show an empty
 * panel: none of the editors matched, so nothing rendered and the owner was
 * left wondering what they had broken. These shelves are filled by the
 * CATALOGUE — units actually sold, scheduled offers, the materials branch,
 * the featured flag — so there is nothing to author here, and saying so is
 * the panel's whole job. Each row names exactly which screen DOES control it,
 * because "it fills itself" is not an answer an owner can act on.
 */
const DATA_DRIVEN_SECTIONS: Record<string, { ar: string; en: string; controlAr: string; controlEn: string }> = {
  best_sellers: {
    ar: 'يُملأ تلقائيًا من المبيعات الفعلية: الكميات المباعة في الطلبات المؤكَّدة وما بعدها.',
    en: 'Filled automatically from real sales: units in orders that are confirmed or later.',
    controlAr: 'لا يُحرَّر يدويًا. يتغيّر مع مبيعات المتجر.',
    controlEn: 'Not editable. It follows the shop’s own sales.',
  },
  flash_deals: {
    ar: 'يعرض المنتجات التي عليها عرض مجدول فعّال، الأقرب انتهاءً أولًا.',
    en: 'Shows products with a live scheduled offer, the ones ending soonest first.',
    controlAr: 'يُدار من صفحة العروض المجدولة (Offers).',
    controlEn: 'Managed from the scheduled Offers screen.',
  },
  spotlight: {
    ar: '«صفقات مميّزة» تعرض المنتجات المعلَّمة كمميّزة. «مختارات لك» تُرتَّب في متصفح الزائر نفسه ولا تُرسل أي بيانات تتبّع.',
    en: '“Super deals” shows products marked featured. “Selection” is ranked inside the visitor’s own browser — no tracking data is sent anywhere.',
    controlAr: 'علّم المنتج كـ«مميّز» في نموذج المنتج ليظهر في صفقات مميّزة.',
    controlEn: 'Mark a product as featured in the product form to put it in Super deals.',
  },
  combos: {
    ar: 'يعرض الباقات التي تحتوي على قطعتين أو أكثر، بتصميم يوضّح القطع والسعر المجمّع.',
    en: 'Shows bundles with two or more parts, drawn to make the parts and the combined price obvious.',
    controlAr: 'يُدار من صفحة الباقات.',
    controlEn: 'Managed from the Bundles screen.',
  },
  filament: {
    ar: 'عيّنة عشوائية من قسم مواد الطباعة وما تحته، تتغيّر كل عشر دقائق.',
    en: 'A random sample from the printing-materials section and everything under it, changing every ten minutes.',
    controlAr: 'يُدار من شجرة الأقسام: كل منتج تحت «مواد الطباعة» مرشَّح.',
    controlEn: 'Managed from the taxonomy: anything under “Printing materials” is a candidate.',
  },
  open_box: {
    ar: 'يعرض المنتجات التي لها حالة (مستعمل / مفتوح العلبة / مجدَّد).',
    en: 'Shows products that carry a condition (used / open box / refurbished).',
    controlAr: 'تُحدَّد حالة المنتج في نموذج المنتج.',
    controlEn: 'The condition is set in the product form.',
  },
  bundles: {
    ar: 'يعرض الباقات والعروض المنشورة.',
    en: 'Shows published bundles and offers.',
    controlAr: 'يُدار من صفحة الباقات.',
    controlEn: 'Managed from the Bundles screen.',
  },
};

function DataDrivenSectionPanel({
  dir,
  info,
}: {
  dir: string;
  info: { ar: string; en: string; controlAr: string; controlEn: string };
}) {
  const rtl = dir === 'rtl';
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
      <p className="text-sm text-zinc-300 leading-relaxed">{rtl ? info.ar : info.en}</p>
      <p className="text-[13px] text-zinc-500 leading-relaxed">{rtl ? info.controlAr : info.controlEn}</p>
      <p className="text-[12px] text-zinc-600 leading-relaxed">
        {rtl
          ? 'من تبويب «الترتيب» يمكنك تغيير موضع هذا القسم أو إخفاؤه. القسم الذي لا يجد ما يعرضه لا يظهر أصلًا.'
          : 'Use the Layout tab to move or hide this section. A section with nothing to show does not appear at all.'}
      </p>
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

  const upload = async (slot: string, file: File) => {
    setSlotError((p) => ({ ...p, [slot]: '' }));
    if (!/\.webp$/i.test(file.name) && file.type !== 'image/webp') {
      setSlotError((p) => ({ ...p, [slot]: rtl ? 'الصيغة يجب أن تكون WebP فقط' : 'The file must be a WebP image' }));
      return;
    }
    setBusySlot(slot);
    try {
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
      group: 'banner',
      titleAr: 'صور إضافية للصفحة الرئيسية', titleEn: 'Extra main page images',
      noteAr: 'أماكن جاهزة لصور الصفحة الرئيسية غير شرائح العرض.',
      noteEn: 'Ready slots for main page artwork other than the hero carousel.',
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
            ? 'تُحفظ كلها في مجلد UiUx/MainPage داخل التخزين العام، وبصيغة WebP فقط. كل رفع ينشئ ملفًا جديدًا حتى لا تبقى النسخة القديمة محفوظة في ذاكرة المتصفحات.'
            : 'All of these live in UiUx/MainPage in public storage, and must be WebP. Every upload writes a NEW file, so browsers and edge caches cannot keep serving the old one.'}
        </p>
      </div>

      {loadError && (
        <div role="alert" className="mb-4 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" /> {loadError}
          <button onClick={() => void load()} className="underline font-bold">{rtl ? 'إعادة المحاولة' : 'Retry'}</button>
        </div>
      )}

      {GROUPS.map((g) => {
        const rows = media.filter((m) => m.group === g.group);
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
          <button onClick={onSave} disabled={saveState === 'saving'} className="flex items-center gap-2 bg-[#6B46FF] hover:bg-[#5A38E6] text-white px-4 py-2 rounded-xl transition-all font-bold disabled:opacity-50">
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
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none min-h-[44px]"
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

function GenericSectionSettings({ titleEn, titleAr, items, onChange, onSave, saveState, saveError }: {
  id: string;
  titleEn: string;
  titleAr: string;
  items: SectionItem[];
  onChange: (items: SectionItem[]) => void;
  onSave: () => void;
  saveState: SaveState;
  saveError: string | null;
}) {
  const { dir } = useLanguage();

  const add = () => {
    onChange([...items, { id: 'it_' + Date.now(), title: 'New Item', subtitle: '', image: '', link: '' }]);
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
      <div className="flex justify-between items-center mb-6 gap-4">
        <h3 className="text-xl font-bold text-white">{dir === 'rtl' ? titleAr : titleEn}</h3>
        <div className="flex items-center gap-3">
          <SaveStatusLabel state={saveState} error={saveError} dir={dir} />
          <button onClick={add} className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-2 rounded-xl transition-colors font-bold">
            <Plus className="w-4 h-4" /> {dir === 'rtl' ? 'إضافة عنصر' : 'Add Item'}
          </button>
          <button onClick={onSave} disabled={saveState === 'saving'} className="flex items-center gap-2 bg-[#6B46FF] hover:bg-[#5A38E6] text-white px-4 py-2 rounded-xl transition-all font-bold disabled:opacity-50">
            <Save className="w-4 h-4" /> {saveState === 'saving' ? (dir === 'rtl' ? 'جارٍ الحفظ...' : 'Saving...') : dir === 'rtl' ? 'حفظ' : 'Save'}
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {items.map((item, i) => (
          <div key={item.id} className="bg-zinc-800/50 p-4 rounded-2xl border border-zinc-700 flex flex-col md:flex-row gap-4">
            <div className="w-24 h-24 bg-zinc-900 border border-zinc-700 rounded-xl overflow-hidden flex items-center justify-center shrink-0">
              {item.image ? (
                <img src={item.image || undefined} className="w-full h-full object-cover" alt="" referrerPolicy="no-referrer" />
              ) : (
                <ImageIcon className="w-8 h-8 text-zinc-600" />
              )}
            </div>
            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">Title</label>
                <input
                  type="text"
                  value={item.title}
                  onChange={(e) => {
                    onChange(items.map((x, xi) => xi === i ? { ...x, title: e.target.value } : x));
                  }}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none"
                  placeholder="Title..."
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">Subtitle / Description</label>
                <input
                  type="text"
                  value={item.subtitle}
                  onChange={(e) => {
                    onChange(items.map((x, xi) => xi === i ? { ...x, subtitle: e.target.value } : x));
                  }}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none"
                  placeholder="Subtitle..."
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">Image URL</label>
                <ImageField
                  value={item.image}
                  onChange={(url) => {
                    onChange(items.map((x, xi) => xi === i ? { ...x, image: url } : x));
                  }}
                  dir={dir}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">Link URL</label>
                <input
                  type="text"
                  value={item.link}
                  onChange={(e) => {
                    onChange(items.map((x, xi) => xi === i ? { ...x, link: e.target.value } : x));
                  }}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none"
                  placeholder="/product/..."
                />
              </div>
            </div>
            <button
              onClick={() => {
                if (!window.confirm(dir === 'rtl' ? 'حذف هذا العنصر؟' : 'Delete this item?')) return;
                onChange(items.filter(x => x.id !== item.id));
              }}
              className="p-3 bg-zinc-900 hover:bg-red-500/10 text-zinc-500 hover:text-red-500 rounded-xl transition-colors border border-zinc-800 self-start"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        ))}
        {items.length === 0 && (
          <div className="text-center text-zinc-500 py-8">No items added yet. Click 'Add Item' to start.</div>
        )}
      </div>
    </div>
  );
}
