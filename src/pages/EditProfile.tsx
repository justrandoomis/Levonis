import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Edit2, Store } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { Switch } from '../components/ui/Switch';
import { IconButton } from '../components/ui/Button';
import { useProjectStrings } from '../components/community/projects/strings';
import { api, uploadFile } from '../lib/api';
import { COUNTRIES, countryNames, flagOf } from '../components/auth/PhoneField';
import { MotionCharacterHome } from '../components/bloub/MotionCharacterAnchor';

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

/** A list the profile keeps (printers, materials) as the comma-separated text the box edits. */
function profileList(profile: Record<string, unknown> | undefined, key: string): string {
  const v = profile?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').join(', ') : '';
}
/** The box's text back into a list: trimmed, de-duplicated, at most ten. */
function splitList(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[,،\n]/)
    .map((x) => x.trim().slice(0, 40))
    .filter((x) => x && !seen.has(x.toLowerCase()) && (seen.add(x.toLowerCase()), true))
    .slice(0, 10);
}
function profileStr(profile: Record<string, unknown> | undefined, key: string): string {
  const v = profile?.[key];
  return typeof v === 'string' ? v : '';
}

export default function EditProfile() {
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();

  // Country names come from the platform's locale data rather than a
  // hand-written table, so the list is in the reader's language without
  // anyone maintaining 245 names in three of them.
  const countryLabel = useMemo(() => countryNames(user?.locale === 'ar' ? 'ar' : user?.locale === 'ku' ? 'ckb' : 'en'), [user?.locale]);
  const [username, setUsername] = useState(user?.username || '');
  const [country, setCountry] = useState(user?.country || '');
  const [fullName, setFullName] = useState(user?.name || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [website, setWebsite] = useState(user?.website || '');

  const [instagram, setInstagram] = useState(profileStr(user?.profile, 'instagram'));
  const [xAccount, setXAccount] = useState(profileStr(user?.profile, 'xAccount'));
  const [tiktok, setTiktok] = useState(profileStr(user?.profile, 'tiktok'));
  const [facebook, setFacebook] = useState(profileStr(user?.profile, 'facebook'));
  // THE CREATOR PAGE (0153): the switch, and the two lists /u/<username> shows.
  const [creatorPublic, setCreatorPublic] = useState(!!user?.creator_public);
  const [printers, setPrinters] = useState(profileList(user?.profile, 'printers'));
  const [materials, setMaterials] = useState(profileList(user?.profile, 'materials'));
  const projectStrings = useProjectStrings();

  const [avatarPreview, setAvatarPreview] = useState<string | null>(user?.avatar_key ? `/files/${user.avatar_key}` : null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [canMerchant, setCanMerchant] = useState(user?.role === 'merchant' || user?.role === 'admin');
  const { loc } = useLanguage();

  // Re-sync the form when the user loads/refreshes.
  const loadedUserId = useRef<string | null>(user?.id ?? null);
  useEffect(() => {
    if (!user || loadedUserId.current === user.id) return;
    loadedUserId.current = user.id;
    setUsername(user.username || '');
    setCountry(user.country || '');
    setFullName(user.name || '');
    setBio(user.bio || '');
    setWebsite(user.website || '');
    setInstagram(profileStr(user.profile, 'instagram'));
    setCreatorPublic(!!user.creator_public);
    setPrinters(profileList(user.profile, 'printers'));
    setMaterials(profileList(user.profile, 'materials'));
    setXAccount(profileStr(user.profile, 'xAccount'));
    setTiktok(profileStr(user.profile, 'tiktok'));
    setFacebook(profileStr(user.profile, 'facebook'));
    setAvatarPreview(user.avatar_key ? `/files/${user.avatar_key}` : null);
  }, [user]);

  // The merchant toggle is only offered when the user actually has a
  // community store, or a merchant/admin role.
  useEffect(() => {
    let cancelled = false;
    if (!user) { setCanMerchant(false); return; }
    if (user.role === 'merchant' || user.role === 'admin') { setCanMerchant(true); return; }
    api
      .get<{ merchant: unknown }>('/api/community/my-store')
      .then((data) => { if (!cancelled) setCanMerchant(data.merchant !== null); })
      .catch(() => { if (!cancelled) setCanMerchant(false); });
    return () => { cancelled = true; };
  }, [user?.id, user?.role]);

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isUploadingAvatar) return;
    setIsUploadingAvatar(true);
    setSaveError('');
    try {
      const { key, url } = await uploadFile(file, 'avatar');
      await api.patch('/api/profile', { avatarKey: key });
      setAvatarPreview(url);
      await refreshUser();
    } catch (err: any) {
      setSaveError(err?.message || 'Avatar upload failed');
    } finally {
      setIsUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const handleSave = async () => {
    if (isSaving || !user) return;
    setIsSaving(true);
    setSaveError('');
    try {
      const body: Record<string, unknown> = {
        name: fullName,
        bio,
        website,
        profile: {
          ...user.profile,
          // printer1..4 are NOT sent any more, and are NOT lost: the spread
          // above carries whatever this account already had straight back.
          // See the note where the four boxes used to be.
          instagram, xAccount, tiktok, facebook,
          printers: splitList(printers),
          materials: splitList(materials),
        },
      };
      // Sent only when it changed, like the country below.
      if (creatorPublic !== !!user.creator_public) body.creator_public = creatorPublic;
      // The server enforces the 14-day username cooldown — just attempt it.
      if (username !== (user.username || '')) body.username = username;
      // Sent only when it changed, so an untouched field can never clear a
      // value the person set somewhere else.
      if (country !== (user.country || '')) body.country = country;
      await api.patch('/api/profile', body);
      await refreshUser();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save profile');
    } finally {
      setIsSaving(false);
    }
  };

  const initials = (fullName || username || '?')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="min-h-screen text-text-primary w-full font-sans pb-16">
      {/* THE STORE LIVES IN ONE PLACE (audit 01 B10). This used to be a
          «Merchant Mode» toggle that swapped this page for a second, legacy
          store editor writing products through /api/community/my-store —
          store-less, entitlement-free, any image URL, hard deletes. That API
          now hands every write to the store API, and this is the way there. */}
      {canMerchant && (
        <div className="flex justify-center pt-8 px-4">
          <Link
            to="/merchant"
            data-edit-profile-store-link
            className="lv-button lv-button-secondary lv-button-sm"
          >
            <Store className="w-4 h-4" aria-hidden="true" />
            {loc('إدارة متجري', 'Manage my store') /* OWNER: Sorani to be written by hand. */}
          </Link>
        </div>
      )}

      {/* Header */}
      {/* ONE BAR, AND A TITLE THAT CANNOT LAND ON ANYTHING.
          The title used to be `absolute left-1/2 -translate-x-1/2`, which is
          centred on the VIEWPORT rather than on the space left between the
          back button and Save — so at 360px it sat on top of both, and in RTL
          it centred against the wrong edge entirely. A grid gives the title a
          real column that the two buttons cannot enter, and `truncate` ends it
          before the column does.
          The character anchor is what stops the shell printing a SECOND strip
          above this bar: MotionCharacterFallbackHeader suppresses itself as
          soon as a page registers an anchor of its own. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 p-4 pt-4 bg-canvas sticky top-0 z-10 border-b border-border-subtle">
        <IconButton
          variant="secondary"
          onClick={() => {
            navigate(-1);
          }}
          label="Back"
          icon={<ChevronLeft className="w-6 h-6 rtl:rotate-180" />}
        />
        <h1 className="text-[18px] font-bold text-text-primary text-center truncate">Edit profile</h1>
        <MotionCharacterHome kind="top-header" compact />
        <button
          onClick={handleSave}
          disabled={isSaving || !user}
          className={`lv-button ${saved ? 'lv-button-secondary text-success' : 'lv-button-accent'} px-5 text-[15px]`}
        >
          {isSaving ? 'Saving...' : saved ? 'Saved!' : 'Save'}
        </button>
      </div>

      {saveError && (
        <div className="max-w-md mx-auto px-4 pt-4">
          <div className="lv-alert lv-alert-danger text-[13px] font-medium text-text-primary text-center">
            {saveError}
          </div>
        </div>
      )}

        <div className="px-4 pb-8 pt-4 space-y-6 max-w-md mx-auto">
        {/* Avatar */}
        <div className="flex justify-center mb-8">
          <div className="relative cursor-pointer" onClick={triggerFileInput}>
            <div className="w-[100px] h-[100px] rounded-full overflow-hidden bg-gradient-to-tr from-olive via-[#A1B58B] to-gold border border-olive/50 flex items-center justify-center">
              {avatarPreview ? (
                <img referrerPolicy="no-referrer" src={avatarPreview} alt="Profile" className="w-full h-full object-cover" />
              ) : (
                <div className="text-onyx font-bold text-2xl">{initials}</div>
              )}
              {isUploadingAvatar && (
                <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
                </div>
              )}
            </div>
            <button className="absolute bottom-0 end-0 w-8 h-8 bg-surface-raised rounded-full flex items-center justify-center shadow-1 border border-border-subtle pointer-events-none">
              <Edit2 className="w-4 h-4 text-text-primary" />
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
          <div className="flex justify-between items-end mb-1.5 ms-1">
            <h3 className="text-text-secondary text-[13px] font-semibold">Username</h3>
            <span className="text-text-muted text-[11px] font-medium">Change once per 14 days</span>
          </div>
          <div className="relative">
            <input
              className="lv-input min-h-[52px] pe-10 font-bold text-[16px]"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
            />
            <ChevronRight className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted rtl:rotate-180" />
          </div>
        </div>

        {/* Country. It is here because the profile-completion prompt asks for
            it and sends people to this page — a prompt whose CTA leads
            somewhere the field does not exist is worse than no prompt. */}
        <div>
          <div className="flex justify-between items-end mb-1.5 ms-1">
            <h3 className="text-text-secondary text-[13px] font-semibold">Country</h3>
          </div>
          <div className="relative">
            <select
              className="lv-input min-h-[52px] appearance-none pe-10 font-bold text-[16px]"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              aria-label="Country"
            >
              <option value="" className="bg-surface">—</option>
              {COUNTRIES.map((c) => (
                <option key={c.iso} value={c.iso} className="bg-surface">
                  {flagOf(c.iso)} {countryLabel(c.iso)}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          </div>
        </div>

        {/* Full name */}
        <div>
          <div className="flex justify-between items-end mb-1.5 ms-1">
            <h3 className="text-text-secondary text-[13px] font-semibold">Full name</h3>
          </div>
          <input
            className="lv-input min-h-[52px] font-bold text-[16px]"
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Full name"
          />
        </div>

        {/* Bio */}
        <div>
          <div className="flex justify-between items-end mb-1.5 ms-1">
            <h3 className="text-text-secondary text-[13px] font-semibold">Bio</h3>
            <span className="text-text-secondary text-[13px] font-medium tabular-nums">{bio.length}/68</span>
          </div>
          <textarea
            className="lv-input min-h-[100px] py-3 font-bold text-[16px] leading-relaxed resize-none"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={68}
            placeholder="Bio"
          />
        </div>

        {/* Website */}
        <div>
          <div className="flex justify-between items-end mb-1.5 ms-1">
            <h3 className="text-text-secondary text-[13px] font-semibold">Website</h3>
          </div>
          <input
            className="lv-input min-h-[52px] font-bold text-[16px]"
            type="text"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="Website"
          />
        </div>

        {/*
          «طابعاتي» IS A MERCHANT FEATURE NOW, AND IT LIVES WHERE THE FACTS DO.

          «الشخص عنده اكثر من طابعه يظهر له خيار فقط أربعة، وهذه المشكلة يجب
           جعل زر طابعاتي لدى التاجر وليس في تعديل الملف الشخصي للشخص العادي،
           وفي تاجر يجب أن يكون عبارة عنصر يستطيع وضع أكثر من طابعه».

          What stood here was four fixed text boxes holding four free-form
          strings — «e.g. Creality Ender 3» — in the `profile` JSON blob. A
          printer shop with six machines could name four of them, and naming
          them bought nothing: the strings decide no eligibility, match no
          print request and are read by nothing.

          The merchant dashboard's Printers tab already holds the real thing,
          unlimited, and as FACTS rather than free text — technology, build
          volume, nozzle, materials, colours, enclosure — because that is what
          the request matcher reads to decide which jobs a shop is eligible
          for. Adding a fifth text box here would have been a fifth string
          nothing consults.

          NOTHING STORED IS DELETED. `handleSave` spreads `...user.profile`
          before writing, so `printer1`–`printer4` survive every save made from
          this screen untouched. A visitor who becomes a merchant tomorrow
          still has what they typed, and the fields can be read back into the
          real printer records whenever that migration is written.
        */}

        {/* The creator page — a choice, off until the person says yes. */}
        <div>
          <div className="flex justify-between items-end mb-1.5 ms-1">
            <h3 className="text-text-secondary text-[13px] font-semibold">{projectStrings.creatorPage}</h3>
          </div>
          <div className="lv-surface overflow-hidden flex flex-col">
            <div className="p-4 border-b border-border-subtle">
              <Switch
                checked={creatorPublic}
                onChange={setCreatorPublic}
                label={projectStrings.creatorPage}
                description={
                  creatorPublic ? (
                    <span>
                      {projectStrings.creatorPageDesc.replace('{username}', username || '…')}{' '}
                      {user?.creator_public && username && (
                        <a href={`/u/${encodeURIComponent(username)}`} className="text-sage underline underline-offset-2">
                          /u/{username}
                        </a>
                      )}
                    </span>
                  ) : (
                    projectStrings.creatorPageOff
                  )
                }
                id="creator-public"
              />
            </div>
            <label className="flex flex-col gap-1.5 p-4 border-b border-border-subtle">
              <span className="text-text-secondary text-[12px] font-semibold">{projectStrings.printersYouUse}</span>
              <input
                className="lv-input font-bold text-[16px] placeholder:font-medium"
                type="text"
                value={printers}
                onChange={(e) => setPrinters(e.target.value)}
                placeholder="Bambu Lab A1, Ender 3 V3"
                data-profile-printers
              />
              <span className="text-text-muted text-[11px]">{projectStrings.printersHint}</span>
            </label>
            <label className="flex flex-col gap-1.5 p-4">
              <span className="text-text-secondary text-[12px] font-semibold">{projectStrings.materialsYouUse}</span>
              <input
                className="lv-input font-bold text-[16px] placeholder:font-medium"
                type="text"
                value={materials}
                onChange={(e) => setMaterials(e.target.value)}
                placeholder="PLA, PETG, TPU"
                data-profile-materials
              />
            </label>
          </div>
        </div>

        {/* Socials */}
        <div>
          <div className="flex justify-between items-end mb-1.5 ms-1">
            <h3 className="text-text-secondary text-[13px] font-semibold">Socials</h3>
            <span className="text-text-muted text-[13px] font-medium">Add up to 4 socials</span>
          </div>
          <div className="lv-surface overflow-hidden flex flex-col">
            <div className="flex items-center gap-3 p-3 border-b border-border-subtle">
              <InstagramIcon className="w-6 h-6 text-text-primary shrink-0" />
              <input
                className="lv-input font-bold text-[16px] placeholder:font-medium"
                type="text"
                value={instagram}
                onChange={(e) => setInstagram(e.target.value)}
                placeholder="@username"
              />
            </div>
            <div className="flex items-center gap-3 p-3 border-b border-border-subtle">
              <XIcon className="w-5 h-5 mx-0.5 text-text-primary shrink-0" />
              <input
                className="lv-input font-bold text-[16px] placeholder:font-medium"
                type="text"
                value={xAccount}
                onChange={(e) => setXAccount(e.target.value)}
                placeholder="@username"
              />
            </div>
            <div className="flex items-center gap-3 p-3 border-b border-border-subtle">
              <TikTokIcon className="w-6 h-6 text-text-primary shrink-0" />
              <input
                className="lv-input font-bold text-[16px] placeholder:font-medium"
                type="text"
                value={tiktok}
                onChange={(e) => setTiktok(e.target.value)}
                placeholder="@username"
              />
            </div>
            <div className="flex items-center gap-3 p-3">
              <FacebookIcon className="w-6 h-6 text-text-primary shrink-0" />
              <input
                className="lv-input font-bold text-[16px] placeholder:font-medium"
                type="text"
                value={facebook}
                onChange={(e) => setFacebook(e.target.value)}
                placeholder="Facebook Link"
              />
            </div>
          </div>
        </div>

        </div>
    </div>
  );
}
