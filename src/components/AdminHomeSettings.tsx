import React, { useState, useEffect, useRef } from 'react';
import { useLanguage } from '../LanguageContext';
import { GripVertical, Plus, Settings, Eye, EyeOff, Save, Trash2, LayoutTemplate, Megaphone, Image as ImageIcon, Ticket, Tag, Star, ArrowLeft, ArrowRight } from 'lucide-react';
import AdminAds from './AdminAds';

const INITIAL_SECTIONS = [
  { id: 'ads_panel', titleEn: 'Ads Panel', titleAr: 'لوحة الاعلانات', isVisible: true, icon: Megaphone },
  { id: 'first_banner', titleEn: 'First Banner', titleAr: 'الشريط الاول', isVisible: true, icon: ImageIcon },
  { id: 'second_banner', titleEn: 'Second Banner', titleAr: 'الشريط الثاني', isVisible: true, icon: ImageIcon },
  { id: 'coupons_offers', titleEn: 'Coupons & Offers Section', titleAr: 'القسم الذي يحتوي على كوبونات وعروض', isVisible: true, icon: Ticket },
  { id: 'categories', titleEn: 'Main & Sub Categories', titleAr: 'الأقسام الرئيسية والفرعية', isVisible: true, icon: LayoutTemplate },
  { id: 'discounts_offers', titleEn: 'Discounts & Offers under categories', titleAr: 'القسم لخصومات المنتجات والعروض تحت الأقسام', isVisible: true, icon: Tag },
  { id: 'top_brands', titleEn: 'Top Brands Section', titleAr: 'قسم top brands', isVisible: true, icon: Star },
];

export default function AdminHomeSettings() {
  const { dir } = useLanguage();
  const [sections, setSections] = useState(INITIAL_SECTIONS);
  const [activeTab, setActiveTab] = useState('layout');
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const saved = localStorage.getItem('home_sections_order');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Merge with initial in case new ones were added
        const merged = parsed.map((pItem: any) => {
          const found = INITIAL_SECTIONS.find(i => i.id === pItem.id);
          return found ? { ...found, isVisible: pItem.isVisible ?? true } : pItem;
        });
        // Add missing
        INITIAL_SECTIONS.forEach(i => {
          if (!merged.find((m: any) => m.id === i.id)) {
            merged.push(i);
          }
        });
        setSections(merged);
      } catch (e) {
        setSections(INITIAL_SECTIONS);
      }
    }
  }, []);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.setData('text/plain', index.toString());
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    const dragIndex = parseInt(e.dataTransfer.getData('text/plain'));
    if (dragIndex === dropIndex) return;

    const newSections = [...sections];
    const [dragged] = newSections.splice(dragIndex, 1);
    newSections.splice(dropIndex, 0, dragged);
    setSections(newSections);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const toggleVisibility = (id: string) => {
    setSections(sections.map(s => s.id === id ? { ...s, isVisible: !s.isVisible } : s));
  };

  const saveSettings = () => {
    localStorage.setItem('home_sections_order', JSON.stringify(sections));
    alert(dir === 'rtl' ? 'تم الحفظ بنجاح!' : 'Settings saved successfully!');
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-black text-white">{dir === 'rtl' ? 'إعدادات الصفحة الرئيسية' : 'Home Settings'}</h2>
      </div>

      {/* Horizontal Tabs */}
      <div className="relative mb-8 bg-zinc-900/50 p-2 rounded-2xl border border-zinc-800 flex items-center">
        <button onClick={() => scrollTabs('left')} className="p-2 text-zinc-400 hover:text-white transition-colors z-10 shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </button>
        
        <div ref={scrollContainerRef} className="flex-1 overflow-x-auto no-scrollbar flex items-center gap-2 px-2 scroll-smooth">
          <button
            onClick={() => setActiveTab('layout')}
            className={`flex items-center gap-2 whitespace-nowrap px-4 py-2.5 rounded-xl font-bold transition-all shrink-0 ${
              activeTab === 'layout' ? 'bg-[#6B46FF] text-white shadow-lg' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'
            }`}
          >
            <LayoutTemplate className="w-4 h-4" />
            {dir === 'rtl' ? 'ترتيب وإظهار الأقسام' : 'Layout & Visibility'}
          </button>
          
          {INITIAL_SECTIONS.map((section) => {
            const Icon = section.icon;
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
            <div className="flex justify-between items-center mb-6">
              <p className="text-zinc-400 text-sm">
                {dir === 'rtl' ? 'قم بسحب وإفلات الأقسام لإعادة ترتيبها في الصفحة الرئيسية. يمكنك أيضاً إخفاء أو إظهار أقسام محددة.' : 'Drag and drop sections to reorder them on the home page. You can also toggle their visibility.'}
              </p>
              <button onClick={saveSettings} className="flex items-center gap-2 bg-[#2CE59B] hover:bg-[#06D6A0] text-[#09090b] px-5 py-2.5 rounded-xl transition-all font-bold shadow-lg shrink-0">
                <Save className="w-4 h-4" />
                {dir === 'rtl' ? 'حفظ الترتيب' : 'Save Layout'}
              </button>
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
                  
                  <div className="flex items-center gap-2">
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

        {activeTab === 'first_banner' && (
          <BannerSettings id="first_banner" titleEn="First Banner" titleAr="الشريط الاول" />
        )}

        {activeTab === 'second_banner' && (
          <BannerSettings id="second_banner" titleEn="Second Banner" titleAr="الشريط الثاني" />
        )}

        {activeTab === 'coupons_offers' && (
          <GenericSectionSettings id="coupons_offers" titleEn="Coupons & Offers" titleAr="إدارة الكوبونات والعروض" />
        )}

        {activeTab === 'categories' && (
          <GenericSectionSettings id="categories" titleEn="Categories" titleAr="إدارة الأقسام الرئيسية والفرعية" />
        )}

        {activeTab === 'discounts_offers' && (
          <GenericSectionSettings id="discounts_offers" titleEn="Discounts & Offers" titleAr="إدارة خصومات المنتجات" />
        )}

        {activeTab === 'top_brands' && (
          <GenericSectionSettings id="top_brands" titleEn="Top Brands" titleAr="إدارة أفضل العلامات التجارية (Brands)" />
        )}
      </div>
    </div>
  );
}

// Subcomponents for managing individual sections
function BannerSettings({ id, titleEn, titleAr }: { id: string, titleEn: string, titleAr: string }) {
  const { dir } = useLanguage();
  const [banners, setBanners] = useState<{ id: string, image: string, link: string }[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem(`levo_banner_${id}`);
    if (saved) {
      setBanners(JSON.parse(saved));
    } else {
      setBanners([{ id: '1', image: '', link: '' }]);
    }
  }, [id]);

  const save = () => {
    localStorage.setItem(`levo_banner_${id}`, JSON.stringify(banners));
    alert(dir === 'rtl' ? 'تم الحفظ بنجاح!' : 'Saved successfully!');
  };

  const add = () => {
    setBanners([...banners, { id: Date.now().toString(), image: '', link: '' }]);
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-xl font-bold text-white">{dir === 'rtl' ? titleAr : titleEn}</h3>
        <div className="flex gap-2">
          <button onClick={add} className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-2 rounded-xl transition-colors font-bold">
            <Plus className="w-4 h-4" /> {dir === 'rtl' ? 'إضافة بانر' : 'Add Banner'}
          </button>
          <button onClick={save} className="flex items-center gap-2 bg-[#6B46FF] hover:bg-[#5A38E6] text-white px-4 py-2 rounded-xl transition-all font-bold">
            <Save className="w-4 h-4" /> {dir === 'rtl' ? 'حفظ' : 'Save'}
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
                <input 
                  type="text" 
                  value={b.image}
                  onChange={(e) => {
                    const nb = [...banners]; nb[i].image = e.target.value; setBanners(nb);
                  }}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none" 
                  placeholder="https://..." 
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">Link URL</label>
                <input 
                  type="text" 
                  value={b.link}
                  onChange={(e) => {
                    const nb = [...banners]; nb[i].link = e.target.value; setBanners(nb);
                  }}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none" 
                  placeholder="/category/fashion" 
                />
              </div>
            </div>
            <button onClick={() => setBanners(banners.filter(x => x.id !== b.id))} className="p-3 bg-zinc-900 hover:bg-red-500/10 text-zinc-500 hover:text-red-500 rounded-xl transition-colors border border-zinc-800 self-start">
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

function GenericSectionSettings({ id, titleEn, titleAr }: { id: string, titleEn: string, titleAr: string }) {
  const { dir } = useLanguage();
  const [items, setItems] = useState<{ id: string, title: string, subtitle: string, image: string, link: string }[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem(`levo_section_${id}`);
    if (saved) {
      setItems(JSON.parse(saved));
    }
  }, [id]);

  const save = () => {
    localStorage.setItem(`levo_section_${id}`, JSON.stringify(items));
    alert(dir === 'rtl' ? 'تم الحفظ بنجاح!' : 'Saved successfully!');
  };

  const add = () => {
    setItems([...items, { id: Date.now().toString(), title: 'New Item', subtitle: '', image: '', link: '' }]);
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-xl font-bold text-white">{dir === 'rtl' ? titleAr : titleEn}</h3>
        <div className="flex gap-2">
          <button onClick={add} className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-2 rounded-xl transition-colors font-bold">
            <Plus className="w-4 h-4" /> {dir === 'rtl' ? 'إضافة عنصر' : 'Add Item'}
          </button>
          <button onClick={save} className="flex items-center gap-2 bg-[#6B46FF] hover:bg-[#5A38E6] text-white px-4 py-2 rounded-xl transition-all font-bold">
            <Save className="w-4 h-4" /> {dir === 'rtl' ? 'حفظ' : 'Save'}
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
                    const nb = [...items]; nb[i].title = e.target.value; setItems(nb);
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
                    const nb = [...items]; nb[i].subtitle = e.target.value; setItems(nb);
                  }}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none" 
                  placeholder="Subtitle..." 
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">Image URL</label>
                <input 
                  type="text" 
                  value={item.image}
                  onChange={(e) => {
                    const nb = [...items]; nb[i].image = e.target.value; setItems(nb);
                  }}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none" 
                  placeholder="https://..." 
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-500 uppercase mb-1">Link URL</label>
                <input 
                  type="text" 
                  value={item.link}
                  onChange={(e) => {
                    const nb = [...items]; nb[i].link = e.target.value; setItems(nb);
                  }}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-[#6B46FF] outline-none" 
                  placeholder="/product/..." 
                />
              </div>
            </div>
            <button onClick={() => setItems(items.filter(x => x.id !== item.id))} className="p-3 bg-zinc-900 hover:bg-red-500/10 text-zinc-500 hover:text-red-500 rounded-xl transition-colors border border-zinc-800 self-start">
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

