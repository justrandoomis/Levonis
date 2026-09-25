import React, { useState, useEffect, useRef } from 'react';
import { useWallet, PaymentMethod } from '../WalletContext';
import RoundingDriftTool from './adminWallet/RoundingDriftTool';
import { api, ApiError, formatIqd, type PayoutMethod } from '../lib/api';
import { Check, Edit2, Plus, Trash2, Video, DollarSign, CreditCard, Save, AlertTriangle, Truck, ArrowUpFromLine, Banknote } from 'lucide-react';

/**
 * THE OWNER TYPES A PERCENT — «عمولة سحب 3% قابلة للتغيير من لوحة الإدارة».
 *
 * The engine stores basis points (300 = 3%) so 2.5% needs no float, and that
 * stays true; what changes is what a human is asked to type. «300 bps» is a
 * unit nobody in the shop uses, and a 3 typed into a basis-point box is a
 * 0.03% commission nobody notices until the payouts are wrong. So the box
 * takes «3» or «2.5», and this converts: at most two decimals (the resolution
 * basis points have), 0 switches the commission off, 50% is the ceiling the
 * server enforces (`MAX_WITHDRAWAL_FEE_BPS`). Anything else is null — refused
 * in the form, never rounded into a number the owner did not type.
 */
export function feePercentToBps(input: string): number | null {
  const t = input.trim().replace(',', '.').replace(/%$/, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return Number.isInteger(bps) && bps >= 0 && bps <= 5000 ? bps : null;
}

/** 300 → «3», 250 → «2.5», 0 → «0» — the inverse the box is seeded with. */
export function feeBpsToPercent(bps: number): string {
  const n = Number(bps);
  if (!Number.isFinite(n) || n < 0) return '0';
  return String(Math.round(n) / 100);
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

function SaveStatus({ state, error }: { state: SaveState; error?: string | null }) {
  if (state === 'saving') {
    return <div className="text-xs font-semibold text-zinc-400 mt-2">Saving...</div>;
  }
  if (state === 'saved') {
    return (
      <div className="text-xs font-semibold text-zinc-500 flex items-center gap-1 mt-2">
        <Check className="w-3 h-3 text-mint" /> Saved
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="text-xs font-semibold text-red-400 flex items-center gap-1 mt-2">
        <AlertTriangle className="w-3 h-3" /> {error || 'Save failed'}
      </div>
    );
  }
  if (state === 'dirty') {
    return <div className="text-xs font-semibold text-yellow-400/80 mt-2">Unsaved changes</div>;
  }
  return null;
}

export default function AdminWalletSettings() {
  const {
    exchangeRate, setExchangeRate,
    codTaxPerBlockIqd, codTaxBlockIqd, setCodTaxRate,
    adVideoUrl, setAdVideoUrl,
    paymentMethods, updatePaymentMethods,
    settings, refreshSettings,
    isLoaded,
  } = useWallet();

  // Local editable copies — saved explicitly, never per keystroke.
  const [rateInput, setRateInput] = useState<string>('');
  const [rateState, setRateState] = useState<SaveState>('idle');
  const [rateError, setRateError] = useState<string | null>(null);

  const [codPerInput, setCodPerInput] = useState<string>('');
  const [codBlockInput, setCodBlockInput] = useState<string>('');
  const [codState, setCodState] = useState<SaveState>('idle');
  const [codError, setCodError] = useState<string | null>(null);

  const [urlInput, setUrlInput] = useState<string>('');
  const [urlState, setUrlState] = useState<SaveState>('idle');
  const [urlError, setUrlError] = useState<string | null>(null);

  /**
   * THE WITHDRAWAL COMMISSION — «عمولة للسحب بقدر 3% قابله للتغيير من الادارة».
   *
   * Stored in basis points so 2.5% needs no float, and read from and written
   * to /api/wallet/admin/withdrawal-fee rather than the generic settings PUT:
   * the wallet slice owns the rate, the validator and the quote that uses it,
   * so there is exactly one road in and out.
   *
   * IT IS DEDUCTED, NOT ADDED ON TOP, and the worked example under the field
   * says so in numbers — this is the point where that could be misread, and a
   * sentence alone would not settle it.
   *
   * IT IS NOT RETROACTIVE. A withdrawal stores fee_cents/net_cents/fee_policy
   * at the moment it is filed, exactly as an order stores cod_tax_iqd, so
   * raising the rate today cannot re-price a request already on the books.
   */
  const [feePctInput, setFeePctInput] = useState<string>('');
  const [feeState, setFeeState] = useState<SaveState>('idle');
  const [feeError, setFeeError] = useState<string | null>(null);

  /**
   * THE WITHDRAWAL CHANNELS — «كي كارد، الرافدين، زين كاش، استلام كاش».
   *
   * A list of their own, not the deposit methods: a deposit method is the
   * SHOP's account a customer pays into, with a number and a copy button; a
   * payout channel is where the CUSTOMER is paid, and «استلام كاش» has no
   * account at all. Each row is a name and one switch — does paying through
   * it need the customer's account or card number? The server resolves the
   * same flag from the same setting when a request is filed, and freezes the
   * name onto it (migration 0112), so renaming a channel here never rewrites
   * a request already on the books.
   */
  const [payouts, setPayouts] = useState<PayoutMethod[]>([]);
  const [payoutState, setPayoutState] = useState<SaveState>('idle');
  const [payoutError, setPayoutError] = useState<string | null>(null);

  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [methodsState, setMethodsState] = useState<SaveState>('idle');
  const [methodsError, setMethodsError] = useState<string | null>(null);
  const [editingMethodId, setEditingMethodId] = useState<string | null>(null);

  // Seed local state from the context once settings have actually loaded,
  // so an empty pre-load context never clobbers the form (stale-initializer fix).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!isLoaded || hydratedRef.current) return;
    hydratedRef.current = true;
    setRateInput(String(exchangeRate));
    setCodPerInput(String(codTaxPerBlockIqd));
    setCodBlockInput(String(codTaxBlockIqd));
    setUrlInput(adVideoUrl);
    setMethods(paymentMethods);
    setPayouts(settings?.payoutMethods ?? []);
  }, [isLoaded, exchangeRate, adVideoUrl, paymentMethods, settings]);

  // Keep untouched sections in sync when the context refreshes (e.g. after a save elsewhere).
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (rateState === 'idle' || rateState === 'saved') setRateInput(String(exchangeRate));
  }, [exchangeRate]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (codState === 'idle' || codState === 'saved') {
      setCodPerInput(String(codTaxPerBlockIqd));
      setCodBlockInput(String(codTaxBlockIqd));
    }
  }, [codTaxPerBlockIqd, codTaxBlockIqd]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (urlState === 'idle' || urlState === 'saved') setUrlInput(adVideoUrl);
  }, [adVideoUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (methodsState === 'idle' || methodsState === 'saved') setMethods(paymentMethods);
  }, [paymentMethods]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (payoutState === 'idle' || payoutState === 'saved') setPayouts(settings?.payoutMethods ?? []);
  }, [settings?.payoutMethods]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveRate = async () => {
    const parsed = parseInt(rateInput, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setRateState('error');
      setRateError('Enter a whole number of IQD per USD (at least 1)');
      return;
    }
    setRateState('saving');
    setRateError(null);
    try {
      await setExchangeRate(parsed);
      setRateState('saved');
    } catch (e) {
      setRateState('error');
      setRateError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  /**
   * THE BLOCK IS WHAT GETS DIVIDED BY, so it is the one that is guarded
   * hardest: a zero would make the charge Infinity, and a fractional one
   * would make «عن كل 500000.5» a sentence nobody can act on. A per-block of
   * exactly 0 is allowed and means the charge is switched off — a thing an
   * owner may genuinely want and should not have to delete a row to get.
   */
  const handleSaveCodTax = async () => {
    const per = parseInt(codPerInput, 10);
    const block = parseInt(codBlockInput, 10);
    if (!Number.isFinite(per) || per < 0) {
      setCodState('error');
      setCodError('Enter a whole number of IQD per block (0 disables the charge)');
      return;
    }
    if (!Number.isFinite(block) || block < 1) {
      setCodState('error');
      setCodError('The block must be a whole number of IQD, at least 1');
      return;
    }
    setCodState('saving');
    setCodError(null);
    try {
      await setCodTaxRate({ perBlockIqd: per, blockIqd: block });
      setCodState('saved');
    } catch (e) {
      setCodState('error');
      setCodError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  // The rate lives outside the settings context, so this screen fetches it
  // itself — once, on mount — and never guesses a value it has not been told.
  useEffect(() => {
    let alive = true;
    api
      .get<{ fee_bps: number }>('/api/wallet/admin/withdrawal-fee')
      .then((r) => {
        if (alive) setFeePctInput(feeBpsToPercent(Number(r.fee_bps) || 0));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const feeBpsParsed = feePctInput.trim() === '' ? null : feePercentToBps(feePctInput);
  // The worked example in DINARS, the unit the owner and the customer both
  // think in — the same floor the server applies to the typed figure.
  const SAMPLE_IQD = 100_000;
  const feeSample = feeBpsParsed !== null ? Math.floor((SAMPLE_IQD * feeBpsParsed) / 10_000) : 0;

  /**
   * 0 is a REAL value and switches the commission off, the same thing a
   * cash-on-delivery charge of 0 means. It is accepted, not treated as a
   * missing field.
   */
  const handleSaveFee = async () => {
    if (feeBpsParsed === null) {
      setFeeState('error');
      setFeeError('Enter a percent between 0 and 50, at most two decimals (3 = 3%; 0 switches the commission off)');
      return;
    }
    setFeeState('saving');
    setFeeError(null);
    try {
      await api.put('/api/wallet/admin/withdrawal-fee', { fee_bps: feeBpsParsed });
      setFeeState('saved');
    } catch (e) {
      setFeeState('error');
      setFeeError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const savePayouts = async (next: PayoutMethod[]) => {
    const cleaned = next
      .map((m) => ({ ...m, name: m.name.trim() }))
      .filter((m) => m.name !== '');
    if (cleaned.length === 0) {
      setPayoutState('error');
      setPayoutError('Keep at least one payout channel with a name — customers cannot withdraw without one.');
      return;
    }
    setPayoutState('saving');
    setPayoutError(null);
    try {
      await api.put('/api/admin/settings/payoutMethods', { value: cleaned });
      await refreshSettings();
      setPayouts(cleaned);
      setPayoutState('saved');
    } catch (e) {
      setPayoutState('error');
      setPayoutError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const updatePayout = (id: string, patch: Partial<PayoutMethod>) => {
    setPayouts((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    setPayoutState('dirty');
  };

  const addPayout = () => {
    setPayouts((ps) => [...ps, { id: `po_${Date.now().toString(36)}`, name: '', requires_account: true }]);
    setPayoutState('dirty');
  };

  const removePayout = (id: string) => {
    if (!window.confirm('Remove this payout channel? Requests already filed through it keep its name.')) return;
    setPayouts((ps) => ps.filter((p) => p.id !== id));
    setPayoutState('dirty');
  };

  const handleSaveUrl = async () => {
    setUrlState('saving');
    setUrlError(null);
    try {
      await setAdVideoUrl(urlInput.trim());
      setUrlState('saved');
    } catch (e) {
      setUrlState('error');
      setUrlError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const saveMethods = async (next: PaymentMethod[]) => {
    setMethodsState('saving');
    setMethodsError(null);
    try {
      await updatePaymentMethods(next);
      setMethodsState('saved');
      setEditingMethodId(null);
    } catch (e) {
      setMethodsState('error');
      setMethodsError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const handleUpdateMethod = (id: string, field: 'name' | 'details', value: string) => {
    setMethods(ms => ms.map(m => m.id === id ? { ...m, [field]: value } : m));
    setMethodsState('dirty');
  };

  const handleAddMethod = () => {
    const newId = 'pm_' + Date.now();
    setMethods(ms => [...ms, { id: newId, name: 'New Method', details: '' }]);
    setMethodsState('dirty');
    setEditingMethodId(newId);
  };

  const handleDeleteMethod = (id: string) => {
    if (!window.confirm('Are you sure you want to delete this payment method?')) return;
    const next = methods.filter(m => m.id !== id);
    setMethods(next);
    saveMethods(next);
  };

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-white">Wallet Settings</h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-green-500" />
            </div>
            <h3 className="text-lg font-bold text-white">Exchange Rate</h3>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-zinc-400">1 USD = IQD</label>
            <div className="flex items-center gap-3">
              <div className="flex-1 relative">
                <input
                  type="number"
                  value={rateInput}
                  onChange={(e) => { setRateInput(e.target.value); setRateState('dirty'); }}
                  disabled={!isLoaded}
                  className="w-full bg-zinc-800 border-none text-white px-4 py-3 rounded-2xl font-bold focus:ring-2 focus:ring-iris/50 disabled:opacity-50"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-bold text-sm">IQD</span>
              </div>
              <button
                onClick={handleSaveRate}
                disabled={rateState === 'saving' || !isLoaded}
                className="flex items-center gap-2 bg-[#2CE59B] hover:bg-[#06D6A0] text-onyx px-4 py-3 rounded-2xl font-bold transition-colors disabled:opacity-50"
              >
                <Save className="w-4 h-4" /> Save
              </button>
            </div>
            <p className="text-[11px] text-zinc-500">
              Product prices are stored in IQD and are not affected by rate changes; the rate only converts wallet USD at checkout.
            </p>
            <SaveStatus state={rateState} error={rateError} />
          </div>
        </div>

        {/* THE DELIVERY COMPANY'S CASH-HANDLING CHARGE — «قابله للتغير من قبل
            الادارة». It was compiled into packages/shipping until the owner
            halved it and asked for it to be theirs.

            IT IS NOT RETROACTIVE, and the note says so: every order stores the
            figure it was charged in `orders.cod_tax_iqd` at placement, so
            lowering this today cannot rewrite last month's invoices. */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
              <Truck className="w-5 h-5 text-amber-500" />
            </div>
            <h3 className="text-lg font-bold text-white">Cash-on-Delivery Charge</h3>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="text-sm font-bold text-zinc-400">Charge</label>
                <div className="relative">
                  <input
                    type="number"
                    value={codPerInput}
                    onChange={(e) => { setCodPerInput(e.target.value); setCodState('dirty'); }}
                    disabled={!isLoaded}
                    className="w-full bg-zinc-800 border-none text-white px-4 py-3 rounded-2xl font-bold focus:ring-2 focus:ring-iris/50 disabled:opacity-50"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-bold text-sm">IQD</span>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-zinc-400">For every</label>
                <div className="relative">
                  <input
                    type="number"
                    value={codBlockInput}
                    onChange={(e) => { setCodBlockInput(e.target.value); setCodState('dirty'); }}
                    disabled={!isLoaded}
                    className="w-full bg-zinc-800 border-none text-white px-4 py-3 rounded-2xl font-bold focus:ring-2 focus:ring-iris/50 disabled:opacity-50"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-bold text-sm">IQD</span>
                </div>
              </div>
            </div>
            <button
              onClick={handleSaveCodTax}
              disabled={codState === 'saving' || !isLoaded}
              className="w-full flex items-center justify-center gap-2 bg-[#2CE59B] hover:bg-[#06D6A0] text-onyx px-4 py-3 rounded-2xl font-bold transition-colors disabled:opacity-50"
            >
              <Save className="w-4 h-4" /> Save
            </button>
            <p className="text-[11px] text-zinc-500">
              Charged only on cash-on-delivery orders sent to an address — never on store pickup,
              wallet or advance payment. Orders already placed keep the charge they were quoted;
              changing this affects new orders only. Set the charge to 0 to switch it off.
            </p>
            <SaveStatus state={codState} error={codError} />
          </div>
        </div>

        {/* THE WITHDRAWAL COMMISSION. Deducted from the requested amount —
            the worked example below is there so that cannot be read the other
            way — and never retroactive: a filed request keeps the fee it was
            quoted, the same contract `orders.cod_tax_iqd` carries. */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-rose-500/10 flex items-center justify-center">
              <ArrowUpFromLine className="w-5 h-5 text-rose-500" />
            </div>
            <h3 className="text-lg font-bold text-white">Withdrawal Commission</h3>
          </div>
          <div className="space-y-2">
            <label htmlFor="withdrawal-fee-percent" className="text-sm font-bold text-zinc-400">Commission (percent of the requested amount)</label>
            <div className="flex items-center gap-3">
              <div className="flex-1 relative">
                <input
                  id="withdrawal-fee-percent"
                  type="text"
                  inputMode="decimal"
                  value={feePctInput}
                  onChange={(e) => { setFeePctInput(e.target.value); setFeeState('dirty'); }}
                  className="w-full bg-zinc-800 border-none text-white px-4 py-3 rounded-2xl font-bold focus:ring-2 focus:ring-iris/50"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-bold text-sm">%</span>
              </div>
              <button
                onClick={handleSaveFee}
                disabled={feeState === 'saving'}
                className="flex items-center gap-2 bg-[#2CE59B] hover:bg-[#06D6A0] text-onyx px-4 py-3 rounded-2xl font-bold transition-colors disabled:opacity-50"
              >
                <Save className="w-4 h-4" /> Save
              </button>
            </div>
            <p className="text-[11px] text-zinc-400 tabular-nums" dir="ltr">
              {formatIqd(SAMPLE_IQD)} requested → commission {formatIqd(feeSample)}, net {formatIqd(SAMPLE_IQD - feeSample)} reaches
              the customer, {formatIqd(SAMPLE_IQD)} leaves their balance.
            </p>
            <p className="text-[11px] text-zinc-500">
              Deducted from the requested amount, never added on top. Requests already filed keep
              the commission they were quoted; changing this affects new requests only. Set it to 0
              to switch the commission off.
            </p>
            <SaveStatus state={feeState} error={feeError} />
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
              <Video className="w-5 h-5 text-blue-500" />
            </div>
            <h3 className="text-lg font-bold text-white">Ad Video Config</h3>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-bold text-zinc-400">Video URL (Direct link to mp4)</label>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => { setUrlInput(e.target.value); setUrlState('dirty'); }}
                disabled={!isLoaded}
                placeholder="e.g. https://www.w3schools.com/html/mov_bbb.mp4"
                className="flex-1 bg-zinc-800 border-none text-white px-4 py-3 rounded-2xl font-medium focus:ring-2 focus:ring-iris/50 disabled:opacity-50"
              />
              <button
                onClick={handleSaveUrl}
                disabled={urlState === 'saving' || !isLoaded}
                className="flex items-center gap-2 bg-[#2CE59B] hover:bg-[#06D6A0] text-onyx px-4 py-3 rounded-2xl font-bold transition-colors disabled:opacity-50"
              >
                <Save className="w-4 h-4" /> Save
              </button>
            </div>
            <SaveStatus state={urlState} error={urlError} />
          </div>
        </div>
      </div>

      {/* WITHDRAWAL PAYOUT CHANNELS — where a customer's withdrawal is paid.
          Not the deposit methods below: those are the shop's own accounts. */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm" data-admin="payout-methods">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
              <Banknote className="w-5 h-5 text-emerald-500" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">Withdrawal Payout Channels</h3>
              <p className="text-xs text-zinc-400">
                What a customer can choose to be paid through when they withdraw. Names are shown to customers exactly as typed.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={addPayout}
              disabled={!isLoaded}
              className="flex items-center gap-1 bg-white hover:bg-zinc-200 text-black px-4 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50"
            >
              <Plus className="w-4 h-4" /> Add Channel
            </button>
            <button
              onClick={() => savePayouts(payouts)}
              disabled={payoutState === 'saving' || !isLoaded || payoutState === 'idle' || payoutState === 'saved'}
              className="flex items-center gap-1 bg-[#2CE59B] hover:bg-[#06D6A0] text-onyx px-4 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50"
            >
              <Save className="w-4 h-4" /> Save
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {payouts.map((p) => (
            <div
              key={p.id}
              className="flex flex-col sm:flex-row sm:items-center gap-3 bg-zinc-800/50 border border-zinc-700/50 p-3 rounded-2xl"
            >
              <input
                type="text"
                value={p.name}
                onChange={(e) => updatePayout(p.id, { name: e.target.value })}
                placeholder="Channel name, e.g. زين كاش"
                aria-label="Channel name"
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 text-white px-3 py-2 rounded-lg"
              />
              <label className="flex items-center gap-2 text-sm text-zinc-300 shrink-0 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={p.requires_account}
                  onChange={(e) => updatePayout(p.id, { requires_account: e.target.checked })}
                  className="w-4 h-4 accent-mint"
                />
                Needs the customer&apos;s account / card number
              </label>
              <button
                onClick={() => removePayout(p.id)}
                aria-label={`Remove ${p.name || 'channel'}`}
                className="p-2 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-500 transition-colors self-end sm:self-auto"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {payouts.length === 0 && (
            <div className="text-center text-zinc-500 py-6 text-sm">{isLoaded ? 'No payout channels.' : 'Loading...'}</div>
          )}
        </div>
        <p className="text-[11px] text-zinc-500 mt-3">
          Untick the account box for a channel paid without one, such as cash pickup («استلام كاش»). Each request keeps
          the channel name it was filed with, so renaming or removing a channel does not change requests already filed.
        </p>
        <SaveStatus state={payoutState} error={payoutError} />
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-sm">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
              <CreditCard className="w-5 h-5 text-purple-500" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">Deposit Methods</h3>
              <p className="text-xs text-zinc-400">Manage manual payment options available to users.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {methodsState === 'dirty' && (
              <button
                onClick={() => saveMethods(methods)}
                className="flex items-center gap-1 bg-[#2CE59B] hover:bg-[#06D6A0] text-onyx px-4 py-2 rounded-xl text-sm font-bold transition-all"
              >
                <Save className="w-4 h-4" /> Save All
              </button>
            )}
            <button
              onClick={handleAddMethod}
              disabled={!isLoaded}
              className="flex items-center gap-1 bg-white hover:bg-zinc-200 text-black px-4 py-2 rounded-xl text-sm font-bold transition-all disabled:opacity-50"
            >
              <Plus className="w-4 h-4" /> Add Method
            </button>
          </div>
        </div>

        <SaveStatus state={methodsState} error={methodsError} />

        <div className="space-y-4 mt-4">
          {methods.map(method => (
            <div key={method.id} className="bg-zinc-800/50 border border-zinc-700/50 p-4 rounded-2xl">
              {editingMethodId === method.id ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-zinc-500 mb-1">Method Name</label>
                      <input
                        type="text"
                        value={method.name}
                        onChange={e => handleUpdateMethod(method.id, 'name', e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-700 text-white px-3 py-2 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-zinc-500 mb-1">Account Details / Numbers</label>
                      <input
                        type="text"
                        value={method.details}
                        onChange={e => handleUpdateMethod(method.id, 'details', e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-700 text-white px-3 py-2 rounded-lg"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      onClick={() => saveMethods(methods)}
                      disabled={methodsState === 'saving'}
                      className="bg-[#2CE59B] text-onyx px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-1 hover:bg-[#06D6A0] disabled:opacity-50"
                    >
                      <Check className="w-4 h-4" /> {methodsState === 'saving' ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-bold text-white">{method.name}</h4>
                    <p className="text-sm text-zinc-400">{method.details}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEditingMethodId(method.id)}
                      className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-zinc-300 transition-colors"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteMethod(method.id)}
                      className="p-2 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-red-500 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {methods.length === 0 && (
            <div className="text-center text-zinc-500 py-8 text-sm">
              {isLoaded ? 'No deposit methods configured.' : 'Loading...'}
            </div>
          )}
        </div>
      </div>
      <RoundingDriftTool />
    </div>
  );
}
