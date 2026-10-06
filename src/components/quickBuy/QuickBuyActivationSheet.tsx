/**
 * «تفعيل الشراء السريع» — THE ACTIVATION SHEET (docs/GIFTS_QUICK_BUY.md §3.5).
 *
 * Opened ON the product page the first time a customer turns Quick Buy on
 * (and from Settings), never by sending them to Settings: the purchase they
 * were about to make is still on screen behind it, and closing it puts them
 * back exactly there — ready to buy, never buying on their behalf.
 *
 * TWO STEPS ON ONE SCREEN:
 *   1. the four consents, EVERY ONE UNTICKED: the automatic hold and charge
 *      from the Levo Wallet, and the three policies at the versions the
 *      server requires today (`profile.required`), each with a link that
 *      opens that exact version in a new tab, so reading it never costs the
 *      ticks already made;
 *   2. the default delivery address, chosen from the account's own
 *      addresses — or written inline with the shop's one AddressForm when
 *      there are none (it loads only then).
 * Then one primary button, POST /api/quick-buy/activate, under one
 * idempotency key per attempt, so a retried tap after a dropped connection
 * cannot activate twice.
 *
 * TWO MORE FACES on the same frame:
 *   · `address` — on, consented, but the saved address was deleted: only
 *     step 2, saved with PUT /api/quick-buy/profile {addressId, enabled};
 *   · `printer` — a printer's standard-delivery warning, which the server
 *     asks the customer to accept once per session (the Checkout's own
 *     warning and wording): the server's Arabic text, a translation for the
 *     version it was written against, one unticked acknowledgement, and
 *     «موافقة وإضافة», after which the page sends the SAME add again.
 *
 * A LAZY CHUNK, warmed by the toggle's pointerdown/focus. Built on the shop's
 * sheet (src/components/ui/Sheet.tsx): it rises from the bottom edge on a
 * phone and is dragged from its handle only, so the long body scrolls without
 * throwing the sheet away; a centred window from `sm` up.
 */
import React, { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, Plus, X, Zap } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { api, ApiError, type ApiAddress } from '../../lib/api';
import {
  activateQuickBuy,
  getQuickBuyProfile,
  IdempotentAction,
  updateQuickBuyProfile,
  withBusyRetry,
  type QuickBuyPolicyKey,
  type QuickBuyPrinterAcceptance,
  type QuickBuyPrinterPolicy,
  type QuickBuyProfile,
} from '../../lib/quickBuy';
import { toast } from '../../lib/toastStore';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Switch';
import { ErrorState } from '../ui/AsyncStates';
import Spinner from '../ui/Spinner';
import { addressLine, policyHref } from './format';
import { PRINTER_WARNING_TRANSLATED_VERSION, quickBuyRefusal, quickBuyStrings, type QuickBuyStrings } from './strings';
import type { QuickBuySheetMode } from './quickBuyActions';

/** The shop's one address form, loaded only for an account that has no address yet. */
const AddressForm = React.lazy(() => import('../address/AddressForm'));

type ConsentKey = 'wallet' | QuickBuyPolicyKey;
const NONE_TICKED: Record<ConsentKey, boolean> = { wallet: false, terms: false, privacy: false, quick_buy: false };

export interface QuickBuyActivationSheetProps {
  open: boolean;
  mode: QuickBuySheetMode;
  onClose: () => void;
  /** Activated, consent saved or the new address saved: the sheet is done; the caller closes it. */
  onActivated?: (profile: QuickBuyProfile) => void;
  /** `printer` face: the warning the server sent with its refusal. */
  printerPolicy?: QuickBuyPrinterPolicy | null;
  /** `printer` face: accepted, explicitly — the caller sends the same add again with it. */
  onPrinterAccept?: (acceptance: QuickBuyPrinterAcceptance) => void;
}

/** The faces share one lazy chunk and one mount on the page; each keeps its own state. */
export default function QuickBuyActivationSheet(props: QuickBuyActivationSheetProps) {
  return props.mode === 'printer' ? <PrinterWarningSheet {...props} /> : <ActivationSheet {...props} />;
}

/** The close button every face carries in its header. */
function CloseButton({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <X aria-hidden="true" className="w-5 h-5" />
    </button>
  );
}

/**
 * «تحذير التوصيل العادي للطابعات» — the server's warning, accepted once per
 * session before a printer joins it. Nothing is ticked; the button stays off
 * until it is; closing adds nothing.
 */
function PrinterWarningSheet({ open, onClose, printerPolicy, onPrinterAccept }: QuickBuyActivationSheetProps) {
  const { lang } = useLanguage();
  const t = quickBuyStrings(lang);
  const uid = useId();
  const titleId = `${uid}-title`;
  const [ticked, setTicked] = useState(false);
  const version = printerPolicy?.version ?? 0;

  // Every opening — and a newer version of the text — starts unticked.
  useEffect(() => {
    if (open) setTicked(false);
  }, [open, version]);

  const translation = version === PRINTER_WARNING_TRANSLATED_VERSION ? t.printerTranslation : '';
  const accept = () => {
    if (!ticked || !printerPolicy) return;
    onPrinterAccept?.({ accepted: true, version: printerPolicy.version });
  };

  const header = (
    <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-1 sm:pt-5">
      <div className="min-w-0">
        <h2 id={titleId} className="flex items-center gap-2 text-[17px] font-bold text-text-primary">
          <AlertTriangle aria-hidden="true" className="w-5 h-5 shrink-0 text-warning" />
          {t.printerTitle}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{t.printerIntro}</p>
      </div>
      <CloseButton onClose={onClose} label={t.close} />
    </div>
  );

  const footer = (
    <div className="space-y-2">
      <p className="text-[12px] text-text-muted" aria-live="polite">
        {ticked ? ' ' : t.printerHint}
      </p>
      <Button
        variant="primary"
        block
        className="min-h-[50px] text-[15px]"
        disabled={!ticked || !printerPolicy}
        onClick={accept}
        icon={<Zap aria-hidden="true" className="w-5 h-5 fill-current" strokeWidth={1.9} />}
        data-quick-buy-printer-accept
      >
        {t.printerAdd}
      </Button>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} labelledBy={titleId} dragHandle header={header} footer={footer} panelClassName="sm:max-w-lg" testId="quick-buy-printer-sheet">
      <div className="space-y-4 px-4 pb-4">
        <div className="lv-alert lv-alert-warning space-y-2" data-printer-standard-warning>
          {translation ? <p className="text-[14px] leading-relaxed text-text-primary">{translation}</p> : null}
          {translation ? <p className="text-[12px] text-text-muted">{t.printerOriginal}</p> : null}
          {/* The text as the server sent it — the one the Checkout shows. */}
          <p lang="ar" dir="rtl" className="text-[14px] font-medium leading-7 text-text-primary">
            {printerPolicy?.text_ar}
          </p>
        </div>
        <div className="lv-surface px-3 py-1.5" data-quick-buy-printer-tick>
          <Checkbox
            checked={ticked}
            onChange={setTicked}
            className="py-1"
            label={<span className="block text-[14px] leading-relaxed text-text-primary">{t.printerAccept}</span>}
          />
        </div>
      </div>
    </Sheet>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold text-[12px] font-black tabular-nums">
      {n}
    </span>
  );
}

function ConsentRow({
  id,
  checked,
  onChange,
  label,
  help,
  version,
  href,
  name,
  t,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  help?: string;
  version?: number;
  href?: string;
  name?: string;
  t: QuickBuyStrings;
}) {
  return (
    <div className="px-3 py-1.5" data-quick-buy-consent={id}>
      <div className="flex items-center gap-2">
        <Checkbox
          checked={checked}
          onChange={onChange}
          className="flex-1 py-1"
          aria-describedby={help ? `${id}-help` : undefined}
          label={
            <span className="block text-[14px] leading-relaxed text-text-primary">
              {label}
              {version ? <span className="block text-[12px] text-text-muted">{t.version(version)}</span> : null}
            </span>
          }
        />
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={t.readAria(name ?? label)}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-bold text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {t.read}
            <ExternalLink aria-hidden="true" className="w-3.5 h-3.5" />
          </a>
        ) : null}
      </div>
      {help ? (
        <p id={`${id}-help`} className="pb-1.5 text-[12px] leading-relaxed text-text-muted" style={{ paddingInlineStart: 30 }}>
          {help}
        </p>
      ) : null}
    </div>
  );
}

function ActivationSheet({ open, mode, onClose, onActivated }: QuickBuyActivationSheetProps) {
  const { lang, dir } = useLanguage();
  const { user } = useAuth();
  const owner = user?.id ?? null;
  const { moneyBoth } = useMoney();
  const t = quickBuyStrings(lang);
  const uid = useId();
  const titleId = `${uid}-title`;
  const step2Id = `${uid}-step2`;

  const [profile, setProfile] = useState<QuickBuyProfile | null>(null);
  const [profileError, setProfileError] = useState<unknown>(null);
  const [addresses, setAddresses] = useState<ApiAddress[] | null>(null);
  const [addressesError, setAddressesError] = useState<unknown>(null);
  const [ticks, setTicks] = useState<Record<ConsentKey, boolean>>(NONE_TICKED);
  const [addressId, setAddressId] = useState('');
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const action = useRef(new IdempotentAction());
  const radios = useRef<Array<HTMLButtonElement | null>>([]);

  const loadProfile = useCallback(async (fresh: boolean) => {
    setProfileError(null);
    try {
      const p = await getQuickBuyProfile(owner, { maxAgeMs: fresh ? 0 : 15_000 });
      setProfile(p);
      return p;
    } catch (err) {
      setProfileError(err);
      return null;
    }
  }, [owner]);

  const loadAddresses = useCallback(async (select?: string) => {
    setAddressesError(null);
    try {
      const r = await api.get<{ addresses: ApiAddress[] }>('/api/addresses');
      const list = r.addresses ?? [];
      setAddresses(list);
      if (select && list.some((a) => a.id === select)) setAddressId(select);
      return list;
    } catch (err) {
      setAddressesError(err);
      return null;
    }
  }, []);

  // Every opening starts with nothing ticked and fresh data.
  useEffect(() => {
    if (!open) return;
    setTicks(NONE_TICKED);
    setError('');
    setWriting(false);
    action.current.settle();
    let alive = true;
    void Promise.all([loadProfile(false), loadAddresses()]).then(([p, list]) => {
      if (!alive || !list) return;
      // The address is a choice, not a consent, so the likely one is offered:
      // the profile's own, else the account's default, else the first.
      const pick = list.find((a) => a.id === p?.address?.id) ?? list.find((a) => a.is_default === 1) ?? list[0];
      setAddressId(pick?.id ?? '');
    });
    return () => {
      alive = false;
    };
  }, [open, loadProfile, loadAddresses]);

  // The address face asks only for the address: the consents on file stand.
  const addressOnly = mode === 'address';
  const required = profile?.required;
  const missing = addressOnly ? 0 : (Object.keys(ticks) as ConsentKey[]).filter((k) => !ticks[k]).length;
  const chosen = !!addressId && !!addresses?.some((a) => a.id === addressId);
  const ready = !!profile && missing === 0 && chosen;
  const hint = !profile ? '' : [missing > 0 ? t.consentsLeft(missing) : '', chosen ? '' : t.chooseAddress].filter(Boolean).join(' · ') || t.readyToActivate;

  const activate = async () => {
    if (!profile || !ready || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = addressOnly
        ? await action.current.run(JSON.stringify(['address', addressId]), (key) =>
            withBusyRetry(() => updateQuickBuyProfile({ addressId, enabled: true }, key, owner))
          )
        : await action.current.run(JSON.stringify([addressId, profile.required]), (key) =>
            withBusyRetry(() => activateQuickBuy({ addressId, required: profile.required, idempotencyKey: key, owner }))
          );
      toast.success(addressOnly ? t.addressSaved : mode === 'reconsent' ? t.reconsented : t.activated, {
        id: 'quick-buy',
        description: mode === 'activate' ? t.activatedHint : undefined,
      });
      onActivated?.(next);
    } catch (err) {
      const code = err instanceof ApiError ? err.code ?? '' : '';
      if (code === 'POLICY_ACCEPTANCE_REQUIRED') {
        // A version moved while the sheet was open: the new one has to be read and ticked.
        await loadProfile(true);
        setTicks((now) => ({ ...now, terms: false, privacy: false, quick_buy: false }));
        setError(t.policyChanged);
      } else if (code === 'QUICK_BUY_ADDRESS_INVALID') {
        setAddressId('');
        await loadAddresses();
        setError(quickBuyRefusal(err, lang, moneyBoth).title);
      } else {
        setError(quickBuyRefusal(err, lang, moneyBoth).title);
      }
    } finally {
      setBusy(false);
    }
  };

  /** Arrow keys move the choice within the group, in the writing direction. */
  const onRadioKey = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const list = addresses ?? [];
    if (!list.length) return;
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === forward) next = (index + 1) % list.length;
    else if (e.key === 'ArrowUp' || e.key === back) next = (index - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setAddressId(list[next].id);
    radios.current[next]?.focus();
  };

  const title = addressOnly ? t.sheetAddressTitle : mode === 'reconsent' ? t.sheetReconsentTitle : t.sheetTitle;
  const intro = addressOnly ? t.sheetAddressIntro : mode === 'reconsent' ? t.sheetReconsentIntro : t.sheetIntro;
  const tick = (k: ConsentKey) => (next: boolean) => setTicks((now) => ({ ...now, [k]: next }));
  const selectedIndex = addresses ? Math.max(0, addresses.findIndex((a) => a.id === addressId)) : 0;

  const header = (
    <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-1 sm:pt-5">
      <div className="min-w-0">
        <h2 id={titleId} className="flex items-center gap-2 text-[17px] font-bold text-text-primary">
          <Zap aria-hidden="true" className="w-5 h-5 text-gold fill-current" strokeWidth={1.9} />
          {title}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{intro}</p>
      </div>
      <CloseButton onClose={onClose} label={t.close} />
    </div>
  );

  const footer = (
    <div className="space-y-2">
      {error ? (
        <p role="alert" className="lv-alert lv-alert-danger text-[13px]">
          {error}
        </p>
      ) : null}
      <p className="text-[12px] text-text-muted" aria-live="polite" data-quick-buy-sheet-hint>
        {hint}
      </p>
      <Button
        variant="primary"
        block
        className="min-h-[50px] text-[15px]"
        loading={busy}
        loadingLabel={t.activating}
        disabled={!ready}
        onClick={activate}
        icon={<Zap aria-hidden="true" className="w-5 h-5 fill-current" strokeWidth={1.9} />}
        data-quick-buy-activate
      >
        {addressOnly ? t.saveAddress : mode === 'reconsent' ? t.saveConsent : t.activate}
      </Button>
    </div>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      header={header}
      footer={footer}
      panelClassName="sm:max-w-lg"
      testId="quick-buy-sheet"
    >
      <div className="space-y-5 px-4 pb-4">
        {profileError && !profile ? (
          <ErrorState error={profileError} onRetry={() => void loadProfile(true)} compact />
        ) : addressOnly ? null : (
          <section aria-labelledby={`${uid}-step1`}>
            <h3 id={`${uid}-step1`} className="flex items-center gap-2 text-[14px] font-bold text-text-primary">
              <StepNumber n={1} />
              {t.stepConsents}
            </h3>
            <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{t.stepConsentsHint}</p>
            <div className="mt-2 lv-surface overflow-hidden divide-y divide-border-subtle">
              <ConsentRow id={`${uid}-wallet`} checked={ticks.wallet} onChange={tick('wallet')} label={t.consentWallet} help={t.consentWalletHelp} t={t} />
              <ConsentRow
                id={`${uid}-terms`}
                checked={ticks.terms}
                onChange={tick('terms')}
                label={t.consentTerms}
                name={t.policyTerms}
                version={required?.terms}
                href={policyHref('terms', required?.terms ?? null, lang)}
                t={t}
              />
              <ConsentRow
                id={`${uid}-privacy`}
                checked={ticks.privacy}
                onChange={tick('privacy')}
                label={t.consentPrivacy}
                name={t.policyPrivacy}
                version={required?.privacy}
                href={policyHref('privacy', required?.privacy ?? null, lang)}
                t={t}
              />
              <ConsentRow
                id={`${uid}-quick-buy`}
                checked={ticks.quick_buy}
                onChange={tick('quick_buy')}
                label={t.consentPolicy}
                name={t.policyQuickBuy}
                version={required?.quick_buy}
                href={policyHref('quick_buy', required?.quick_buy ?? null, lang)}
                t={t}
              />
            </div>
          </section>
        )}

        <section aria-labelledby={step2Id}>
          <h3 id={step2Id} className="flex items-center gap-2 text-[14px] font-bold text-text-primary">
            {addressOnly ? null : <StepNumber n={2} />}
            {t.stepAddress}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{t.stepAddressHint}</p>
          <div className="mt-2">
            {addressesError && !addresses ? (
              <ErrorState error={addressesError} onRetry={() => void loadAddresses()} compact />
            ) : addresses === null ? (
              <p role="status" className="flex items-center gap-2 py-3 text-[13px] text-text-muted">
                <Spinner size="sm" delayMs={0} decorative />
                {t.addressesLoading}
              </p>
            ) : addresses.length === 0 || writing ? (
              <div className="lv-surface p-3" data-quick-buy-address-form>
                {addresses.length === 0 ? <p className="mb-3 text-[13px] text-text-secondary">{t.noAddresses}</p> : null}
                <Suspense
                  fallback={
                    <p role="status" className="flex items-center gap-2 py-3 text-[13px] text-text-muted">
                      <Spinner size="sm" delayMs={0} decorative />
                      {t.loading}
                    </p>
                  }
                >
                  <AddressForm
                    dense
                    defaultWhenFirst={addresses.length === 0}
                    onSaved={(id) => {
                      setWriting(false);
                      void loadAddresses(id);
                    }}
                    onCancel={addresses.length > 0 ? () => setWriting(false) : undefined}
                  />
                </Suspense>
              </div>
            ) : (
              <>
                <div role="radiogroup" aria-labelledby={step2Id} className="space-y-2">
                  {addresses.map((a, i) => {
                    const selected = a.id === addressId;
                    return (
                      <button
                        key={a.id}
                        ref={(el) => {
                          radios.current[i] = el;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={i === selectedIndex ? 0 : -1}
                        onClick={() => setAddressId(a.id)}
                        onKeyDown={(e) => onRadioKey(e, i)}
                        data-quick-buy-address={a.id}
                        className="lv-choice flex w-full items-start gap-3 px-3 py-2.5 text-start"
                      >
                        <span className="lv-choice-mark mt-0.5">
                          <Check aria-hidden="true" className="w-3 h-3" strokeWidth={3} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-[14px] font-bold text-text-primary">{a.label || a.name}</span>
                            {a.is_default === 1 ? (
                              <span className="shrink-0 rounded-full bg-gold/10 px-2 py-0.5 text-[11px] font-bold text-gold">{t.defaultTag}</span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 block text-[12px] text-text-secondary">
                            {a.name} · <bdi dir="ltr">{a.phone}</bdi>
                          </span>
                          <span className="mt-0.5 block text-[12px] leading-relaxed text-text-muted">{addressLine(a, lang)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => setWriting(true)}
                  className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-md px-1 text-[13px] font-bold text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <Plus aria-hidden="true" className="w-4 h-4" />
                  {t.addAddress}
                </button>
              </>
            )}
          </div>
        </section>
      </div>
    </Sheet>
  );
}
