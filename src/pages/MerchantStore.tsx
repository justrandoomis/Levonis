import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { queryDb } from '../lib/db';
import { 
  ArrowLeft, ArrowRight, Share, Search, Menu, 
  Instagram, Twitter, Link as LinkIcon, Plus, Star,
  MapPin, Phone, Mail, Clock, ShieldCheck, Globe,
  Layers, Zap, Cpu, Printer, Wrench
} from 'lucide-react';

export default function MerchantStore() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { dir, lang } = useLanguage();
  const [activeTab, setActiveTab] = useState('products');
  const [activeSection, setActiveSection] = useState('UI Kits');
  const [merchant, setMerchant] = useState<any>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [isFollowing, setIsFollowing] = useState(false);

  const handleTabClick = (tab: string) => {
    setActiveTab(tab);
  };

  useEffect(() => {
    // Check follow state
    const followedStores = JSON.parse(localStorage.getItem('followed_stores') || '[]');
    if (followedStores.some((s: any) => s.id === id)) {
      setIsFollowing(true);
    }
    
    // Mock data for now
    setMerchant(null);

    setProducts([]);
  }, [id]);

  const toggleFollow = () => {
    let followedStores = JSON.parse(localStorage.getItem('followed_stores') || '[]');
    if (isFollowing) {
      followedStores = followedStores.filter((s: any) => s.id !== id);
      setIsFollowing(false);
    } else {
      if (merchant) {
        followedStores.push({
          id: merchant.id,
          name: merchant.name,
          username: merchant.username,
          avatar: merchant.avatar
        });
      }
      setIsFollowing(true);
    }
    localStorage.setItem('followed_stores', JSON.stringify(followedStores));
  };

  if (!merchant) return <div className="min-h-screen bg-black"></div>;

  return (
    <div className="w-full min-h-screen bg-black text-white font-sans">
      {/* Header */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-black/90 backdrop-blur-md px-4 py-3 flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          <Share className="w-5 h-5 text-white" />
        </button>
        <div className="flex gap-2">
          <button className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
            <Search className="w-5 h-5 text-white" />
          </button>
          <button className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
            <Menu className="w-5 h-5 text-white" />
          </button>
        </div>
      </div>

      <div className="px-5 pt-[76px] pb-32">
        {/* Profile Info */}
        <div className="flex items-center gap-4 mb-4">
          <img referrerPolicy="no-referrer" src={merchant.avatar} alt={merchant.name} className="w-20 h-20 rounded-full object-cover" />
          <div className="relative z-0">
            <h1 className="text-2xl font-bold">{merchant.name}</h1>
            <p className="text-zinc-400 text-sm">{merchant.username}</p>
          </div>
        </div>

        <h2 className="text-lg font-medium mb-1 text-white">{merchant.bio}</h2>
        <a href={`https://${merchant.website}`} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-white mb-2 block">
          {merchant.website}
        </a>

        <div className="flex flex-wrap gap-2 mb-5 mt-3">
          <div className="flex items-center gap-1.5 bg-black/40 backdrop-blur-md border border-zinc-700/50 px-2.5 py-1 rounded-full shadow-sm">
            <Layers className="w-3.5 h-3.5 text-[#ff5000]" />
            <span className="text-xs font-medium text-white">{dir === 'rtl' ? 'طباعة FDM' : 'FDM Printing'}</span>
          </div>
          <div className="flex items-center gap-1.5 bg-black/40 backdrop-blur-md border border-zinc-700/50 px-2.5 py-1 rounded-full shadow-sm">
            <Zap className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-xs font-medium text-white">{dir === 'rtl' ? 'طباعة Resin' : 'Resin Printing'}</span>
          </div>
          <div className="flex items-center gap-1.5 bg-black/40 backdrop-blur-md border border-zinc-700/50 px-2.5 py-1 rounded-full shadow-sm">
            <Printer className="w-3.5 h-3.5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-300">Bambu Lab X1C</span>
          </div>
          <div className="flex items-center gap-1.5 bg-black/40 backdrop-blur-md border border-zinc-700/50 px-2.5 py-1 rounded-full shadow-sm">
            <Printer className="w-3.5 h-3.5 text-zinc-400" />
            <span className="text-xs font-medium text-zinc-300">Elegoo Saturn 3</span>
          </div>
        </div>

        <div className="flex items-center gap-1 text-sm font-medium mb-6 text-zinc-300">
          <div className="w-4 h-4 rounded-full border border-zinc-700 flex items-center justify-center mr-1">
            <div className="w-2 h-2 rounded-full bg-zinc-500"></div>
          </div>
          <span>{merchant.followers} {dir === 'rtl' ? 'متابعين' : 'followers'}</span>
          <span className="text-zinc-600 mx-1">·</span>
          <span>{merchant.sales} {dir === 'rtl' ? 'مبيعات' : 'sales'}</span>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 mb-8">
          <button 
            onClick={toggleFollow}
            className={`flex-1 rounded-full py-3 font-bold transition-colors ${isFollowing ? 'border border-zinc-700 bg-black text-white hover:bg-zinc-900' : 'bg-white text-black hover:bg-zinc-200'}`}
          >
            {isFollowing ? (dir === 'rtl' ? 'تمت المتابعة' : 'Following') : (dir === 'rtl' ? 'متابعة' : 'Follow')}
          </button>
          <button className="flex-1 border border-zinc-700 bg-zinc-900 text-white rounded-full py-3 font-bold hover:bg-zinc-800 transition-colors">
            {dir === 'rtl' ? 'مراسلة' : 'Message'}
          </button>
          <button className="w-12 h-12 border border-zinc-700 bg-zinc-900 rounded-full flex items-center justify-center hover:bg-zinc-800 transition-colors shrink-0">
            <Instagram className="w-5 h-5 text-white" />
          </button>
          <button className="w-12 h-12 border border-zinc-700 bg-zinc-900 rounded-full flex items-center justify-center hover:bg-zinc-800 transition-colors shrink-0">
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path></svg>
          </button>
        </div>
        
        {/* Tabs */}
        <div className="flex border-b border-zinc-800 mb-6 overflow-x-auto hide-scrollbar sticky top-[60px] z-40 bg-black pt-2">
          <button 
            onClick={() => handleTabClick('products')}
            className={`flex-none px-4 pb-3 text-center font-bold text-sm border-b-2 transition-colors flex items-center justify-center gap-2 ${activeTab === 'products' ? 'border-white text-white' : 'border-transparent text-zinc-500 hover:text-zinc-400'}`}
          >
            {dir === 'rtl' ? 'المنتجات' : 'Products'} <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${activeTab === 'products' ? 'bg-zinc-800 text-white' : 'bg-zinc-900 text-zinc-400'}`}>{products.length}</span>
          </button>
          <button 
            onClick={() => handleTabClick('sections')}
            className={`flex-none px-4 pb-3 text-center font-bold text-sm border-b-2 transition-colors ${activeTab === 'sections' ? 'border-white text-white' : 'border-transparent text-zinc-500 hover:text-zinc-400'}`}
          >
            {dir === 'rtl' ? 'الاقسام' : 'Sections'}
          </button>
          <button 
            onClick={() => handleTabClick('reviews')}
            className={`flex-none px-4 pb-3 text-center font-bold text-sm border-b-2 transition-colors ${activeTab === 'reviews' ? 'border-white text-white' : 'border-transparent text-zinc-500 hover:text-zinc-400'}`}
          >
            {dir === 'rtl' ? 'التقييمات' : 'Reviews'}
          </button>
          <button 
            onClick={() => handleTabClick('about')}
            className={`flex-none px-4 pb-3 text-center font-bold text-sm border-b-2 transition-colors ${activeTab === 'about' ? 'border-white text-white' : 'border-transparent text-zinc-500 hover:text-zinc-400'}`}
          >
            {dir === 'rtl' ? 'حول' : 'About'}
          </button>
        </div>

        {/* Tab Content */}
        <div className="relative z-0">
          {activeTab === 'products' && (
            <div className="columns-2 gap-3 space-y-3">
            {products.map((p, i) => (
              <Link to={`/product/merchant-item-${p.id}`} key={i} className="block break-inside-avoid">
                {p.title ? (
                  <div className="bg-zinc-900 border border-zinc-800 p-4 rounded-xl aspect-square flex flex-col justify-center">
                    <h3 className="font-bold text-xl leading-tight text-white">{p.title}</h3>
                  </div>
                ) : (
                  <div className="rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800">
                    <img referrerPolicy="no-referrer" src={p.url || undefined} alt="" className="w-full h-auto object-cover" />
                  </div>
                )}
              </Link>
            ))}
          </div>
        )}
        
        {activeTab === 'sections' && (
          <div className="flex -mx-5 -mt-6 border-t border-zinc-800 items-start">
            {/* Sidebar */}
            <div className="w-24 bg-zinc-900/50 overflow-y-auto hide-scrollbar flex flex-col shrink-0 sticky top-[102px] pb-32" style={{ height: 'calc(100dvh - 102px)' }}>
              {[
                { id: 's1', name: dir === 'rtl' ? 'تصميم واجهات' : 'UI Kits' },
                { id: 's2', name: dir === 'rtl' ? 'ايقونات' : 'Icons' },
                { id: 's3', name: dir === 'rtl' ? 'رسومات' : 'Illustrations' },
                { id: 's4', name: dir === 'rtl' ? 'ثلاثية الابعاد' : '3D Assets' },
                { id: 's5', name: dir === 'rtl' ? 'قوالب' : 'Templates' },
                { id: 's6', name: dir === 'rtl' ? 'نماذج' : 'Mockups' },
                { id: 's7', name: dir === 'rtl' ? 'خطوط' : 'Fonts' },
                { id: 's8', name: dir === 'rtl' ? 'مؤثرات' : 'Effects' },
                { id: 's9', name: dir === 'rtl' ? 'اضافات' : 'Plugins' },
                { id: 's10', name: dir === 'rtl' ? 'اخرى' : 'Other' }
              ].map((sec, i) => (
                <button 
                  key={i} 
                  onClick={() => setActiveSection(sec.id)}
                  className={`py-4 px-2 text-center text-sm font-medium transition-colors ${activeSection === sec.id ? 'bg-black text-white relative before:absolute rtl:before:right-0 ltr:before:left-0 before:top-1/2 before:-translate-y-1/2 before:w-1 before:h-6 before:bg-[#ff5000] rtl:before:rounded-l-full ltr:before:rounded-r-full' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  {sec.name}
                </button>
              ))}
            </div>
            
            {/* Products List */}
            <div className="flex-1 p-4 space-y-4">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((item) => (
                <Link to={`/product/merchant-sec-${item}`} key={item} className="flex gap-3 bg-zinc-900/30 rounded-xl p-2 border border-zinc-800/50 hover:bg-zinc-800 transition-colors">
                  <div className="w-24 h-24 rounded-lg overflow-hidden shrink-0 bg-zinc-800">
                    <img referrerPolicy="no-referrer" src={`https://images.unsplash.com/photo-1518770660439-4636190af475?w=200&sig=${item + (activeSection as string).charCodeAt(1)}`} alt="" className="w-full h-full object-cover" />
                  </div>
                  <div className="flex flex-col flex-1 py-1">
                    <h3 className="text-white font-bold text-sm leading-tight mb-1 line-clamp-2">Premium Asset Pack - {activeSection} Item {item}</h3>
                    <div className="text-zinc-500 text-xs mb-auto">{dir === 'rtl' ? 'المبيعات 1000+' : 'Sales 1000+'}</div>
                    <div className="flex justify-between items-end mt-2">
                      <div className="text-[#ff5000] font-bold"><span className="text-xs mr-0.5">$</span>3.50</div>
                      <button className="w-6 h-6 rounded-full bg-[#ff5000]/20 text-[#ff5000] flex items-center justify-center hover:bg-[#ff5000]/30 transition-colors">
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
        
        {activeTab === 'reviews' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between mb-4">
               <div className="relative z-0">
                 <div className="text-2xl font-bold text-white mb-1">4.9</div>
                 <div className="flex gap-1">
                   {[1,2,3,4,5].map(star => <Star key={star} className="w-4 h-4 fill-yellow-500 text-yellow-500" />)}
                 </div>
               </div>
               <div className="text-sm text-zinc-400">Based on 124 reviews</div>
            </div>
            {[
              { name: 'Sarah M.', date: '2 days ago', text: 'Amazing quality! The UI kits saved me weeks of work.', rating: 5 },
              { name: 'David K.', date: '1 week ago', text: 'Very clean design system, easy to customize.', rating: 5 },
              { name: 'Elena R.', date: '2 weeks ago', text: 'Good variety of icons, but some formats were missing.', rating: 4 },
              { name: 'Michael T.', date: '1 month ago', text: 'Absolutely stellar 3D assets. Will buy again!', rating: 5 },
              { name: 'Jessica W.', date: '2 months ago', text: 'Helpful seller, great communication when I had questions.', rating: 5 }
            ].map((review, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                 <div className="flex justify-between items-start mb-2">
                   <div className="flex items-center gap-2">
                     <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center font-bold">{review.name.charAt(0)}</div>
                     <div className="relative z-0">
                       <div className="font-bold text-sm text-white">{review.name}</div>
                       <div className="text-xs text-zinc-500">{review.date}</div>
                     </div>
                   </div>
                   <div className="flex gap-0.5">
                     {Array.from({length: 5}).map((_, j) => (
                        <Star key={j} className={`w-3 h-3 ${j < review.rating ? 'fill-yellow-500 text-yellow-500' : 'text-zinc-700'}`} />
                     ))}
                   </div>
                 </div>
                 <p className="text-sm text-zinc-300 mt-2">{review.text}</p>
              </div>
            ))}
          </div>
        )}
        
        {activeTab === 'about' && (
          <div className="space-y-6">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h3 className="font-bold text-white mb-2">{dir === 'rtl' ? 'عن التاجر' : 'About the Merchant'}</h3>
              <p className="text-sm text-zinc-400 leading-relaxed mb-4">
                 We create premium, high-quality design assets for modern product teams. Our focus is on accessibility, clean aesthetics, and ready-to-use components that speed up your workflow. 
              </p>
              
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
              {/* Specialties Card */}
              <div className="bg-gradient-to-br from-zinc-900 to-black border border-zinc-800/80 rounded-xl p-5 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                  <Wrench className="w-24 h-24" />
                </div>
                <div className="flex items-center gap-2 mb-4 relative z-10">
                  <div className="w-8 h-8 rounded-full bg-[#ff5000]/10 flex items-center justify-center">
                    <Wrench className="w-4 h-4 text-[#ff5000]" />
                  </div>
                  <h4 className="font-bold text-white">{dir === 'rtl' ? 'التخصص الأساسي' : 'Core Specialties'}</h4>
                </div>
                <div className="flex flex-col gap-2 relative z-10">
                  <div className="flex items-center gap-2.5 bg-black/40 border border-zinc-800/80 px-3 py-2 rounded-lg">
                    <Layers className="w-4 h-4 text-[#ff5000]" />
                    <span className="text-xs font-medium text-zinc-300">FDM 3D Printing</span>
                  </div>
                  <div className="flex items-center gap-2.5 bg-black/40 border border-zinc-800/80 px-3 py-2 rounded-lg">
                    <Zap className="w-4 h-4 text-blue-400" />
                    <span className="text-xs font-medium text-zinc-300">Resin (SLA)</span>
                  </div>
                  <div className="flex items-center gap-2.5 bg-black/40 border border-zinc-800/80 px-3 py-2 rounded-lg">
                    <Cpu className="w-4 h-4 text-purple-400" />
                    <span className="text-xs font-medium text-zinc-300">CNC Machining</span>
                  </div>
                </div>
              </div>

              {/* Printers Card */}
              <div className="bg-gradient-to-br from-zinc-900 to-black border border-zinc-800/80 rounded-xl p-5 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                  <Printer className="w-24 h-24" />
                </div>
                <div className="flex items-center gap-2 mb-4 relative z-10">
                  <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center">
                    <Printer className="w-4 h-4 text-blue-400" />
                  </div>
                  <h4 className="font-bold text-white">{dir === 'rtl' ? 'المعدات والطابعات' : 'Equipment & Printers'}</h4>
                </div>
                <div className="flex flex-col gap-2 relative z-10">
                  <div className="flex items-center justify-between bg-black/40 border border-zinc-800/80 px-3 py-2 rounded-lg">
                    <span className="text-xs font-medium text-zinc-300">Bambu Lab X1-Carbon</span>
                    <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></span>
                  </div>
                  <div className="flex items-center justify-between bg-black/40 border border-zinc-800/80 px-3 py-2 rounded-lg">
                    <span className="text-xs font-medium text-zinc-300">Prusa i3 MK3S+</span>
                    <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></span>
                  </div>
                  <div className="flex items-center justify-between bg-black/40 border border-zinc-800/80 px-3 py-2 rounded-lg">
                    <span className="text-xs font-medium text-zinc-300">Elegoo Saturn 3</span>
                    <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></span>
                  </div>
                  <div className="flex items-center justify-between bg-black/40 border border-zinc-800/80 px-3 py-2 rounded-lg">
                    <span className="text-xs font-medium text-zinc-300">Anycubic Photon Mono M5s</span>
                    <span className="w-2 h-2 rounded-full bg-zinc-600"></span>
                  </div>
                </div>
              </div>
            </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h3 className="font-bold text-white mb-4">{dir === 'rtl' ? 'معلومات التواصل' : 'Contact Information'}</h3>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <MapPin className="w-5 h-5 text-zinc-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-medium text-white">{dir === 'rtl' ? 'العنوان' : 'Address'}</div>
                    <div className="text-sm text-zinc-400 mt-1">{dir === 'rtl' ? 'بغداد، العراق - المنصور' : 'Baghdad, Iraq - Al Mansour'}</div>
                  </div>
                </div>
                
                <div className="flex items-start gap-3">
                  <Phone className="w-5 h-5 text-zinc-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-medium text-white">{dir === 'rtl' ? 'رقم الهاتف' : 'Phone Number'}</div>
                    <div className="text-sm text-zinc-400 mt-1" dir="ltr">+964 770 123 4567</div>
                  </div>
                </div>
                
                <div className="flex items-start gap-3">
                  <Mail className="w-5 h-5 text-zinc-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-medium text-white">{dir === 'rtl' ? 'البريد الإلكتروني' : 'Email Address'}</div>
                    <div className="text-sm text-zinc-400 mt-1">contact@alexsmith.design</div>
                  </div>
                </div>
                
                <div className="flex items-start gap-3">
                  <Clock className="w-5 h-5 text-zinc-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-medium text-white">{dir === 'rtl' ? 'ساعات العمل' : 'Working Hours'}</div>
                    <div className="text-sm text-zinc-400 mt-1">{dir === 'rtl' ? 'من الأحد إلى الخميس (9 ص - 5 م)' : 'Sunday to Thursday (9 AM - 5 PM)'}</div>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-center">
                <div className="text-zinc-500 text-xs mb-1">{dir === 'rtl' ? 'انضم' : 'Joined'}</div>
                <div className="font-bold text-white">October 2022</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-center">
                <div className="text-zinc-500 text-xs mb-1">{dir === 'rtl' ? 'المبيعات' : 'Total Sales'}</div>
                <div className="font-bold text-white">12,450+</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-center">
                <div className="text-zinc-500 text-xs mb-1">{dir === 'rtl' ? 'المنتجات' : 'Products'}</div>
                <div className="font-bold text-white">143</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-center">
                <div className="text-zinc-500 text-xs mb-1">{dir === 'rtl' ? 'الاستجابة' : 'Response Time'}</div>
                <div className="font-bold text-white">&lt; 24 {dir === 'rtl' ? 'ساعة' : 'hours'}</div>
              </div>
            </div>
            
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 mb-8">
              <h3 className="font-bold text-white mb-3">{dir === 'rtl' ? 'الروابط' : 'Links'}</h3>
              <div className="space-y-3">
                <a href="#" className="flex items-center gap-3 text-zinc-300 hover:text-white transition-colors">
                  <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center">
                    <Globe className="w-4 h-4" />
                  </div>
                  <span className="text-sm font-medium">mobbin.com</span>
                </a>
                <a href="#" className="flex items-center gap-3 text-zinc-300 hover:text-white transition-colors">
                  <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center">
                    <Twitter className="w-4 h-4" />
                  </div>
                  <span className="text-sm font-medium">@alex.smith</span>
                </a>
                <a href="#" className="flex items-center gap-3 text-zinc-300 hover:text-white transition-colors">
                  <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center">
                    <Instagram className="w-4 h-4" />
                  </div>
                  <span className="text-sm font-medium">@alex.design</span>
                </a>
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
