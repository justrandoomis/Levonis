/**
 * SETTINGS › «الشراء السريع» (docs/GIFTS_QUICK_BUY.md §3.5).
 *
 * The page's own card (Settings passes its `SectionCard`, so the heading,
 * surface and rhythm are the other seven cards' exactly) and its own row
 * grammar — the switch row, a navigation row that opens the address choice in
 * place, an information row — around four real things:
 *
 *   · the switch: PUT /api/quick-buy/profile {enabled}. Turning it ON for an
 *     account that has never accepted, whose policies moved, or whose saved
 *     address is gone opens the same sheet the product page uses, in that
 *     face, because that is where consents and the address are given; the
 *     switch never claims a state the server has not confirmed;
 *   · the default address: PUT {addressId}, chosen from the account's
 *     addresses, with the way to manage them — and, when the saved one was
 *     deleted (`address_missing`), the row says so;
 *   · the consents: the version of each policy accepted and the date, each
 *     linked to that exact version;
 *   · re-consent: when a policy moved past the accepted version, a warning
 *     and the sheet in its review face.
 *
 * A LAZY CHUNK of the settings page; the sheet is a lazy chunk of this one.
 */
import React, { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, FileText, MapPin, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { api, type ApiAddress } from '../../lib/api';
import {
  getQuickBuyProfile,
  IdempotentAction,
  updateQuickBuyProfile,
  withBusyRetry,
  type QuickBuyPolicyKey,
  type QuickBuyProfile,
} from '../../lib/quickBuy';
import { Switch } from '../ui/Switch';
import { ErrorState } from '../ui/AsyncStates';
import Spinner from '../ui/Spinner';
import { formatDate } from '../orders/format';
import { addressLine, policyHref } from './format';
import { quickBuyRefusal, quickBuyStrings } from './strings';
import type { QuickBuySheetMode } from './quickBuyActions';

const QuickBuyActivationSheet = React.lazy(() => import('./QuickBuyActivationSheet'));

type SectionCardLike = React.ComponentType<{ title: string; icon: React.ReactNode; children: React.ReactNode; id?: string }>;

const ROW =
  'w-full min-h-14 flex items-center justify-between gap-3 px-4 py-3 text-start hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus transition-colors';

const POLICY_ORDER: QuickBuyPolicyKey[] = ['terms', 'privacy', 'quick_buy'];

function acceptedVersion(profile: QuickBuyProfile, key: QuickBuyPolicyKey): number | null {
  if (key === 'terms') return profile.consent.terms_version;
  if (key === 'privacy') return profile.consent.privacy_version;
  return profile.consent.policy_version;
}

export default function QuickBuySettings({ SectionCard }: { SectionCard: SectionCardLike }) {
  const { lang } = useLanguage();
  const { user } = useAuth();
  const owner = user?.id ?? null;
  const { moneyBoth } = useMoney();
  const t = quickBuyStrings(lang);
  const pickerId = useId();
  const [profile, setProfile] = useState<QuickBuyProfile | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [draft, setDraft] = useState<boolean | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [addresses, setAddresses] = useState<ApiAddress[] | null>(null);
  const [addressesError, setAddressesError] = useState<unknown>(null);
  const [savingAddress, setSavingAddress] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<{ open: boolean; mode: QuickBuySheetMode; started: boolean }>({ open: false, mode: 'activate', started: false });
  const switchAction = useRef(new IdempotentAction());
  const addressAction = useRef(new IdempotentAction());

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setProfile(await getQuickBuyProfile(owner));
    } catch (err) {
      setLoadError(err);
    }
  }, [owner]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAddresses = useCallback(async () => {
    setAddressesError(null);
    try {
      const r = await api.get<{ addresses: ApiAddress[] }>('/api/addresses');
      setAddresses(r.addresses ?? []);
    } catch (err) {
      setAddressesError(err);
    }
  }, []);

  const openSheet = (mode: QuickBuySheetMode) => setSheet({ open: true, mode, started: true });

  const toggle = async (next: boolean) => {
    if (!profile || switchBusy) return;
    setMsg('');
    setError('');
    // The consents are given in the sheet, never by flipping a switch; an
    // address that was deleted is replaced there too.
    if (next && (!profile.consent.consented_at || profile.needs_consent)) {
      openSheet(profile.consent.consented_at ? 'reconsent' : 'activate');
      return;
    }
    if (next && !profile.address) {
      openSheet('address');
      return;
    }
    setDraft(next);
    setSwitchBusy(true);
    try {
      const p = await switchAction.current.run(`enabled:${next}`, (key) => withBusyRetry(() => updateQuickBuyProfile({ enabled: next }, key, owner)));
      setProfile(p);
      setMsg(t.saved);
    } catch (err) {
      setError(quickBuyRefusal(err, lang, moneyBoth).title || t.saveFailed);
    } finally {
      setDraft(null);
      setSwitchBusy(false);
    }
  };

  const chooseAddress = async (id: string) => {
    if (!profile || savingAddress || id === profile.address?.id) {
      if (id === profile?.address?.id) setPicking(false);
      return;
    }
    setMsg('');
    setError('');
    setSavingAddress(id);
    try {
      const p = await addressAction.current.run(`address:${id}`, (key) => withBusyRetry(() => updateQuickBuyProfile({ addressId: id }, key, owner)));
      setProfile(p);
      setPicking(false);
      setMsg(t.saved);
    } catch (err) {
      setError(quickBuyRefusal(err, lang, moneyBoth).title || t.saveFailed);
    } finally {
      setSavingAddress('');
    }
  };

  const togglePicker = () => {
    const next = !picking;
    setPicking(next);
    if (next && addresses === null) void loadAddresses();
  };

  const card = (children: React.ReactNode) => (
    <SectionCard title={t.settingsTitle} icon={<Zap aria-hidden="true" className="w-4 h-4" />} id="settings-quick-buy">
      {children}
    </SectionCard>
  );

  if (!profile) {
    return card(
      loadError ? (
        <div className="px-4 py-3">
          <ErrorState error={loadError} onRetry={() => void load()} compact />
        </div>
      ) : (
        <div className="px-4 py-3" role="status" aria-label={t.loading}>
          <div className="h-11 rounded-md bg-surface-raised animate-pulse" />
          <div className="mt-3 h-11 rounded-md bg-surface-raised animate-pulse" />
        </div>
      )
    );
  }

  const on = draft ?? profile.enabled;

  return (
    <>
      {card(
        <>
          <div className="px-4 py-3" data-quick-buy-settings-switch>
            <Switch checked={on} onChange={(next) => void toggle(next)} busy={switchBusy} label={t.switchLabel} description={on ? t.switchOn : t.switchOff} />
            {msg ? <p className="mt-1 text-[12px] text-emerald-300" role="status">{msg}</p> : null}
            {error ? (
              <p className="mt-1 text-[12px] text-amber-300" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          {profile.enabled && profile.needs_consent ? (
            <div className="px-4 py-3" data-quick-buy-reconsent>
              <div className="lv-alert lv-alert-warning text-[13px]">
                <p className="leading-relaxed">{t.reconsentNeeded}</p>
                <button type="button" onClick={() => openSheet('reconsent')} className="lv-button lv-button-secondary lv-button-sm mt-2">
                  {t.reviewAndAccept}
                </button>
              </div>
            </div>
          ) : null}

          <div>
            <button type="button" aria-expanded={picking} aria-controls={pickerId} onClick={togglePicker} className={ROW} data-quick-buy-settings-address>
              <span className="flex items-center gap-3 min-w-0">
                <span className="text-zinc-300 shrink-0">
                  <MapPin aria-hidden="true" className="w-5 h-5" />
                </span>
                <span className="min-w-0">
                  <span className="block font-bold text-[15px] text-white truncate">{t.addressRow}</span>
                  {profile.address_missing ? (
                    // The saved address was deleted since: Quick Buy waits for a new one.
                    <span className="block text-[12px] leading-relaxed text-warning" data-quick-buy-address-missing>
                      {t.addressMissing}
                    </span>
                  ) : (
                    <span className="block text-[12px] text-zinc-400">
                      {profile.address ? `${profile.address.name} · ${addressLine(profile.address, lang)}` : t.noAddressYet}
                    </span>
                  )}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[12px] font-bold text-text-secondary">
                {t.change}
                <ChevronDown aria-hidden="true" className={`w-4 h-4 transition-transform ${picking ? 'rotate-180' : ''}`} />
              </span>
            </button>
            {picking ? (
              <div id={pickerId} className="px-4 pb-3">
                {addressesError && !addresses ? (
                  <ErrorState error={addressesError} onRetry={() => void loadAddresses()} compact />
                ) : addresses === null ? (
                  <p role="status" className="flex items-center gap-2 py-2 text-[13px] text-text-muted">
                    <Spinner size="sm" delayMs={0} decorative />
                    {t.addressesLoading}
                  </p>
                ) : addresses.length === 0 ? (
                  <p className="py-2 text-[13px] text-text-secondary">{t.noAddresses}</p>
                ) : (
                  <div role="radiogroup" aria-label={t.addressRow} className="space-y-2">
                    {addresses.map((a) => {
                      const selected = a.id === profile.address?.id;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => void chooseAddress(a.id)}
                          disabled={!!savingAddress}
                          className="lv-choice flex w-full items-start gap-3 px-3 py-2.5 text-start disabled:opacity-60"
                          data-quick-buy-settings-address-option={a.id}
                        >
                          <span className="lv-choice-mark mt-0.5">
                            {savingAddress === a.id ? <Spinner size="xs" delayMs={0} decorative /> : <Check aria-hidden="true" className="w-3 h-3" strokeWidth={3} />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[14px] font-bold text-text-primary">{a.label || a.name}</span>
                            <span className="mt-0.5 block text-[12px] text-text-secondary">
                              {a.name} · <bdi dir="ltr">{a.phone}</bdi>
                            </span>
                            <span className="mt-0.5 block text-[12px] leading-relaxed text-text-muted">{addressLine(a, lang)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <Link
                  to="/addresses"
                  className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-md px-1 text-[13px] font-bold text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {t.manageAddresses}
                </Link>
              </div>
            ) : null}
          </div>

          <div className="px-4 py-3" data-quick-buy-settings-consents>
            <p className="flex items-center gap-2 font-bold text-[15px]">
              <FileText aria-hidden="true" className="w-4 h-4 text-zinc-400" />
              {t.consentsRow}
            </p>
            <ul className="mt-1">
              {POLICY_ORDER.map((key) => {
                const accepted = acceptedVersion(profile, key);
                const required = profile.required[key];
                const stale = accepted !== null && required > accepted;
                const name = key === 'terms' ? t.policyTerms : key === 'privacy' ? t.policyPrivacy : t.policyQuickBuy;
                return (
                  <li key={key} className="flex items-center justify-between gap-3">
                    <a
                      href={policyHref(key, accepted ?? required, lang)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t.readAria(name)}
                      className="inline-flex min-h-11 min-w-0 items-center rounded text-[13px] text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <span className="truncate">{name}</span>
                    </a>
                    <span className={`shrink-0 text-[12px] tabular-nums ${stale ? 'text-warning' : 'text-text-muted'}`}>
                      {accepted ? t.version(accepted) : '—'}
                      {stale ? ` · ${t.currentVersion(required)}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-[12px] text-zinc-500">
              {profile.consent.consented_at ? t.acceptedOn(formatDate(profile.consent.consented_at, lang)) : t.notAccepted}
            </p>
          </div>

          <div className="px-4 py-3">
            <p className="text-[12px] leading-relaxed text-zinc-500">{t.howItWorks}</p>
          </div>
        </>
      )}
      {sheet.started ? (
        <Suspense fallback={null}>
          <QuickBuyActivationSheet
            open={sheet.open}
            mode={sheet.mode}
            onClose={() => setSheet((s) => ({ ...s, open: false }))}
            onActivated={(p) => {
              setProfile(p);
              setSheet((s) => ({ ...s, open: false }));
              setMsg(t.saved);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
