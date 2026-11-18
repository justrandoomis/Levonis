import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Edit2 } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { IconButton } from '../components/ui/Button';
import { api, uploadFile } from '../lib/api';
import { COUNTRIES, countryNames, flagOf } from '../components/auth/PhoneField';
import { MotionCharacterHome } from '../components/bloub/MotionCharacterAnchor';
import VariantImg from '../components/ui/VariantImg';

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

  const [avatarPreview, setAvatarPreview] = useState<string | null>(user?.avatar_key ? `/files/${user.avatar_key}` : null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Re-sync the form when the user loads/refreshes.
  const loadedUserId = useRef<string | null>(user?.id ?? null);
  useEffect(() => {
    if (!user || loadedUserId.current === user.id) return;
    loadedUserId.current = user.id;
    setUsername(user.username || '');
    setCountry(user.country || '');
    setFullName(user.name || '');
    setBio(user.bio || '');
    setAvatarPreview(user.avatar_key ? `/files/${user.avatar_key}` : null);
  }, [user]);

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
      // ONLY WHAT THIS SCREEN SHOWS IS SENT. Website, socials and the public
      // creator page were taken off this page for ordinary customers
      // (owner, 2026-11-18); the server keeps every field a PATCH leaves
      // out, so anything an account saved there before stays as it was.
      const body: Record<string, unknown> = { name: fullName, bio };
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
                <VariantImg sizes="112px" referrerPolicy="no-referrer" src={avatarPreview} alt="Profile" className="w-full h-full object-cover" />
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

        {/* WHAT THIS PAGE NO LONGER CARRIES (owner, 2026-11-18): «Manage my
            store», Website, «My public page» and Socials — none of them is for
            an ordinary customer. Merchants reach /merchant from the dashboard
            and the store CTA. The printer boxes went earlier: «طابعاتي» lives in
            the merchant dashboard's Printers tab, as facts the matcher reads.
            NOTHING STORED IS DELETED: `handleSave` no longer sends the website,
            profile or creator_public, and the server keeps every field a
            PATCH leaves out. */}

        </div>
    </div>
  );
}
