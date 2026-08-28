import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Edit2, Printer } from 'lucide-react';
import { useAuth } from '../AuthContext';
import MerchantDashboard from '../components/MerchantDashboard';
import { Store } from 'lucide-react';

const XIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
  </svg>
);

const TikTokIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.04-.1z" />
  </svg>
);

const FacebookIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.469h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.469h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
  </svg>
);

const InstagramIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect>
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path>
    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line>
  </svg>
);

export default function EditProfile() {
  const navigate = useNavigate();
  const { user } = useAuth();
  
  const [username, setUsername] = useState(user?.username || 'alex.smith');
  const [fullName, setFullName] = useState('Alex Smith');
  const [bio, setBio] = useState('Designing my life');
  const [website, setWebsite] = useState('mobbin.com');
  const [printer1, setPrinter1] = useState('Creality Ender 3 V2');
  const [printer2, setPrinter2] = useState('Prusa i3 MK3S+');
  const [printer3, setPrinter3] = useState('');
  const [printer4, setPrinter4] = useState('');
  
  const [instagram, setInstagram] = useState('@slmobbin');
  const [xAccount, setXAccount] = useState('@salmobbin');
  const [tiktok, setTiktok] = useState('');
  const [facebook, setFacebook] = useState('');

  const [profileImage, setProfileImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [lastUsernameChangeDate, setLastUsernameChangeDate] = useState<Date | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [merchantMode, setMerchantMode] = useState(user?.isAdmin || true); // Assuming admin or default true for demo

  useEffect(() => {
    const savedDate = localStorage.getItem('lastUsernameChangeDate');
    if (savedDate) setLastUsernameChangeDate(new Date(savedDate));
    
    // Load other mock data
    const savedData = localStorage.getItem('profileData');
    if (savedData) {
      try {
        const data = JSON.parse(savedData);
        if (data.username) setUsername(data.username);
        if (data.fullName) setFullName(data.fullName);
        if (data.bio) setBio(data.bio);
        if (data.website) setWebsite(data.website);
        if (data.printer1) setPrinter1(data.printer1);
        if (data.printer2) setPrinter2(data.printer2);
        if (data.printer3) setPrinter3(data.printer3);
        if (data.printer4) setPrinter4(data.printer4);
        if (data.instagram) setInstagram(data.instagram);
        if (data.xAccount) setXAccount(data.xAccount);
        if (data.tiktok) setTiktok(data.tiktok);
        if (data.facebook) setFacebook(data.facebook);
        if (data.profileImage) setProfileImage(data.profileImage);
      } catch (e) {}
    } else if (user) {
      if (user.username) setUsername(user.username);
      if (user.name) setFullName(user.name);
    }
  }, [user]);

  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (lastUsernameChangeDate) {
      const daysSinceChange = (new Date().getTime() - lastUsernameChangeDate.getTime()) / (1000 * 3600 * 24);
      if (daysSinceChange < 14) {
        alert(`You can only change your username once every 14 days. Days remaining: ${Math.ceil(14 - daysSinceChange)}`);
        return;
      }
    }
    setUsername(e.target.value);
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setProfileImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const handleSave = async () => {
    setIsSaving(true);
    
    if (username !== user?.username) {
      // Only record change date if username actually changed from initial state
      // Actually we should check if username is different from loaded. We will just set it if it changed.
      const savedData = localStorage.getItem('profileData');
      let oldUsername = user?.username;
      if (savedData) {
        try {
          oldUsername = JSON.parse(savedData).username;
        } catch(e) {}
      }
      if (username !== oldUsername) {
        localStorage.setItem('lastUsernameChangeDate', new Date().toISOString());
        setLastUsernameChangeDate(new Date());
      }
    }

    const dataToSave = {
      username, fullName, bio, website,
      printer1, printer2, printer3, printer4,
      instagram, xAccount, tiktok, facebook,
      profileImage
    };
    localStorage.setItem('profileData', JSON.stringify(dataToSave));

    // Simulate API delay
    await new Promise(r => setTimeout(r, 600));
    
    setIsSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white w-full font-sans pb-16">
      {/* Header */}
      {/* Merchant Mode Toggle (Demo) */}
      <div className="flex justify-center pt-8 bg-[#0a0a0a]">
        <button 
          onClick={() => setMerchantMode(!merchantMode)}
          className={`flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold transition-colors ${merchantMode ? 'bg-gold/20 text-gold border border-gold/30' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}
        >
          <Store className="w-4 h-4" />
          {merchantMode ? 'Merchant Mode: ON' : 'Merchant Mode: OFF'}
        </button>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between p-4 pt-4 bg-[#0a0a0a]/80 backdrop-blur-md sticky top-0 z-10 border-b border-zinc-800/50">
        <button 
          onClick={() => navigate(-1)} 
          className="w-11 h-11 bg-white/5 rounded-full flex items-center justify-center shadow-sm hover:bg-white/10 active:scale-95 transition-all border border-white/5"
        >
          <ChevronLeft className="w-6 h-6 text-white" />
        </button>
        <h1 className="text-[18px] font-bold absolute left-1/2 -translate-x-1/2 text-gold">Edit profile</h1>
        <button 
          onClick={handleSave}
          disabled={isSaving}
          className={`px-5 py-2.5 rounded-full text-[15px] font-bold shadow-sm transition-all ${saved ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-olive/20 text-gold border border-olive/30 hover:bg-olive/30 active:scale-95'}`}
        >
          {isSaving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
        </button>
      </div>

      {merchantMode ? (
        <MerchantDashboard />
      ) : (
        <div className="px-4 pb-8 pt-4 space-y-6 max-w-md mx-auto">
        {/* Avatar */}
        <div className="flex justify-center mb-8">
          <div className="relative cursor-pointer" onClick={triggerFileInput}>
            <div className="w-[100px] h-[100px] rounded-full overflow-hidden bg-gradient-to-tr from-olive via-[#A1B58B] to-gold border border-olive/50 flex items-center justify-center">
              {profileImage ? (
                <img referrerPolicy="no-referrer" src={profileImage || undefined} alt="Profile" className="w-full h-full object-cover" />
              ) : (
                <div className="text-zinc-800 font-bold text-2xl">AS</div>
              )}
            </div>
            <button className="absolute bottom-0 right-0 w-8 h-8 bg-zinc-800 rounded-full flex items-center justify-center shadow-md active:scale-95 transition-transform border border-zinc-700 pointer-events-none">
              <Edit2 className="w-4 h-4 text-white" />
            </button>
            <input 
              type="file" 
              ref={fileInputRef} 
              className="hidden" 
              accept="image/*" 
              onChange={handleImageChange} 
            />
          </div>
        </div>

        {/* Username */}
        <div>
          <div className="flex justify-between items-end mb-2 ml-1">
            <h3 className="text-gold text-[13px] font-bold">Username</h3>
            <span className="text-zinc-500 text-[11px] font-medium">Change once per 14 days</span>
          </div>
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-2xl shadow-sm p-4 flex items-center justify-between cursor-pointer active:bg-zinc-800">
            <input 
              type="text"
              value={username}
              onChange={handleUsernameChange}
              className="bg-transparent font-bold text-[16px] text-white w-full outline-none"
              placeholder="Username"
            />
            <ChevronRight className="w-5 h-5 text-zinc-500 ml-2 shrink-0" />
          </div>
        </div>

        {/* Full name */}
        <div>
          <div className="flex justify-between items-end mb-2 ml-1">
            <h3 className="text-gold text-[13px] font-bold">Full name</h3>
          </div>
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-2xl shadow-sm p-4">
            <input 
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="bg-transparent font-bold text-[16px] text-white w-full outline-none"
              placeholder="Full name"
            />
          </div>
        </div>

        {/* Bio */}
        <div>
          <div className="flex justify-between items-end mb-2 ml-1">
            <h3 className="text-gold text-[13px] font-bold">Bio</h3>
            <span className="text-zinc-300 text-[13px] font-medium">{bio.length}/68</span>
          </div>
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-2xl shadow-sm p-4 min-h-[100px]">
            <textarea 
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={68}
              className="bg-transparent font-bold text-[16px] text-white w-full outline-none resize-none"
              placeholder="Bio"
            />
          </div>
        </div>

        {/* Website */}
        <div>
          <div className="flex justify-between items-end mb-2 ml-1">
            <h3 className="text-gold text-[13px] font-bold">Website</h3>
          </div>
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-2xl shadow-sm p-4">
            <input 
              type="text"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              className="bg-transparent font-bold text-[16px] text-white w-full outline-none"
              placeholder="Website"
            />
          </div>
        </div>

        {/* Printers */}
        <div>
          <div className="flex justify-between items-end mb-2 ml-1">
            <h3 className="text-gold text-[13px] font-bold">My Workshop Printers</h3>
            <span className="text-zinc-300 text-[13px] font-medium">Add your 3D printers</span>
          </div>
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-2xl shadow-sm overflow-hidden flex flex-col">
            <div className="flex items-center p-4 border-b border-zinc-800">
              <Printer className="w-5 h-5 text-zinc-300 mr-4 shrink-0" />
              <input 
                type="text"
                value={printer1}
                onChange={(e) => setPrinter1(e.target.value)}
                className="bg-transparent font-bold text-[16px] text-white w-full outline-none placeholder:font-medium placeholder:text-zinc-600"
                placeholder="e.g. Creality Ender 3"
              />
            </div>
            <div className="flex items-center p-4 border-b border-zinc-800">
              <Printer className="w-5 h-5 text-zinc-300 mr-4 shrink-0 ml-0.5" />
              <input 
                type="text"
                value={printer2}
                onChange={(e) => setPrinter2(e.target.value)}
                className="bg-transparent font-bold text-[16px] text-white w-full outline-none placeholder:font-medium placeholder:text-zinc-600 ml-0.5"
                placeholder="e.g. Prusa MK4"
              />
            </div>
            <div className="flex items-center p-4 border-b border-zinc-800">
              <Printer className="w-5 h-5 text-zinc-300 mr-4 shrink-0" />
              <input 
                type="text"
                value={printer3}
                onChange={(e) => setPrinter3(e.target.value)}
                className="bg-transparent font-bold text-[16px] text-white w-full outline-none placeholder:font-medium placeholder:text-zinc-600"
                placeholder="e.g. Bambu Lab X1C"
              />
            </div>
            <div className="flex items-center p-4">
              <Printer className="w-5 h-5 text-zinc-300 mr-4 shrink-0" />
              <input 
                type="text"
                value={printer4}
                onChange={(e) => setPrinter4(e.target.value)}
                className="bg-transparent font-bold text-[16px] text-white w-full outline-none placeholder:font-medium placeholder:text-zinc-600"
                placeholder="e.g. Anycubic Kobra"
              />
            </div>
          </div>
        </div>

        {/* Socials */}
        <div>
          <div className="flex justify-between items-end mb-2 ml-1">
            <h3 className="text-gold text-[13px] font-bold">Socials</h3>
            <span className="text-zinc-300 text-[13px] font-medium">Add up to 4 socials</span>
          </div>
          <div className="bg-zinc-900/95 backdrop-blur-md border border-zinc-800/50 rounded-2xl shadow-sm overflow-hidden flex flex-col">
            <div className="flex items-center p-4 border-b border-zinc-800">
              <InstagramIcon className="w-6 h-6 text-white mr-4 shrink-0" />
              <input 
                type="text"
                value={instagram}
                onChange={(e) => setInstagram(e.target.value)}
                className="bg-transparent font-bold text-[16px] text-white w-full outline-none placeholder:font-medium placeholder:text-zinc-600"
                placeholder="@username"
              />
            </div>
            <div className="flex items-center p-4 border-b border-zinc-800">
              <XIcon className="w-5 h-5 text-white mr-4 shrink-0 ml-0.5" />
              <input 
                type="text"
                value={xAccount}
                onChange={(e) => setXAccount(e.target.value)}
                className="bg-transparent font-bold text-[16px] text-white w-full outline-none placeholder:font-medium placeholder:text-zinc-600 ml-0.5"
                placeholder="@username"
              />
            </div>
            <div className="flex items-center p-4 border-b border-zinc-800">
              <TikTokIcon className="w-6 h-6 text-white mr-4 shrink-0" />
              <input 
                type="text"
                value={tiktok}
                onChange={(e) => setTiktok(e.target.value)}
                className="bg-transparent font-bold text-[16px] text-white w-full outline-none placeholder:font-medium placeholder:text-zinc-600"
                placeholder="@username"
              />
            </div>
            <div className="flex items-center p-4">
              <FacebookIcon className="w-6 h-6 text-white mr-4 shrink-0" />
              <input 
                type="text"
                value={facebook}
                onChange={(e) => setFacebook(e.target.value)}
                className="bg-transparent font-bold text-[16px] text-white w-full outline-none placeholder:font-medium placeholder:text-zinc-600"
                placeholder="Facebook Link"
              />
            </div>
          </div>
        </div>

        </div>
      )}
    </div>
  );
}
