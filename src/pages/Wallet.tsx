import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { useWallet } from '../WalletContext';
import { uploadFile, formatUsdCents, usdCentsToIqd, iqdToUsdCents } from '../lib/api';
import {
  ChevronLeft,
  ArrowUp,
  ArrowDown,
  ScanLine,
  DollarSign,
  ArrowRight,
  ArrowDownLeft,
  X,
  Upload,
  CheckCircle,
  Clock,
  XCircle,
  Copy,
  Receipt
} from 'lucide-react';

export default function Wallet() {
  const navigate = useNavigate();
  const {
    balanceUsdCents,
    paymentMethods,
    transactions,
    currency: defaultCurrency,
    exchangeRate,
    submitDeposit,
    submitWithdrawal,
  } = useWallet();

  // Display currency is a page-local preference only; all stored amounts are USD cents.
  const [currency, setCurrency] = useState<'IQD' | 'USD'>(defaultCurrency);
  const [viewAllActivity, setViewAllActivity] = useState(false);
  const [modalType, setModalType] = useState<'deposit' | 'withdrawal' | null>(null);

  const [amount, setAmount] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [note, setNote] = useState('');
  const [selectedMethod, setSelectedMethod] = useState('');
  const [receiptKey, setReceiptKey] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value.replace(/[^0-9.]/g, '');
    const parts = val.split('.');
    if (parts.length > 2) {
      val = parts[0] + '.' + parts.slice(1).join('');
    }
    const finalParts = val.split('.');
    finalParts[0] = finalParts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    setAmount(finalParts.join('.'));
  };

  /** Format USD cents in the current display currency. */
  const formatCents = (cents: number, showSymbol: boolean = true) => {
    if (currency === 'IQD') {
      const iqd = usdCentsToIqd(cents, exchangeRate);
      const formatted = iqd.toLocaleString('en-US', { maximumFractionDigits: 0 });
      return showSymbol ? `IQD ${formatted}` : formatted;
    }
    const formatted = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return showSymbol ? `$${formatted}` : formatted;
  };

  const handleOpenModal = (type: 'deposit' | 'withdrawal') => {
    setModalType(type);
    setAmount('');
    setNote('');
    setReceiptKey('');
    setSelectedMethod('');
    setFormError('');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isUploading) return;
    setIsUploading(true);
    setFormError('');
    setReceiptKey('');
    try {
      const { key } = await uploadFile(file, 'receipt');
      setReceiptKey(key);
    } catch (err: any) {
      setFormError(err?.message || 'Receipt upload failed — please try again');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isUploading) return;
    setFormError('');

    const rawVal = amount.replace(/,/g, '');
    const numAmount = parseFloat(rawVal);
    if (!numAmount || numAmount <= 0) {
      setFormError('Enter a valid amount');
      return;
    }

    // Convert the display-currency input into USD cents.
    const amountUsdCents =
      currency === 'IQD' ? iqdToUsdCents(numAmount, exchangeRate) : Math.round(numAmount * 100);

    if (modalType === 'deposit' && !receiptKey) {
      setFormError('Receipt upload is required for deposits');
      return;
    }

    setIsSubmitting(true);
    try {
      if (modalType === 'deposit') {
        await submitDeposit({
          amount_usd_cents: amountUsdCents,
          note: note || undefined,
          paymentMethod: selectedMethod || undefined,
          receiptKey,
        });
        setModalType(null);
        setAccountNumber('');
        alert('Deposit request submitted. It is pending review by our team — your balance updates once it is approved.');
      } else {
        await submitWithdrawal({
          amount_usd_cents: amountUsdCents,
          note: note || undefined,
          accountNumber: accountNumber || undefined,
        });
        setModalType(null);
        setAccountNumber('');
        alert('Withdrawal request submitted. It is pending review by our team.');
      }
    } catch (err: any) {
      setFormError(err?.message || 'Request failed — please try again');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="w-full bg-black min-h-screen font-sans flex flex-col pb-20">
      {/* Top Section */}
      <div className="bg-[#0A1F18] rounded-b-[44px] pt-12 pb-10 px-6 flex flex-col items-center relative z-10">
        <button onClick={() => navigate(-1)} className="absolute left-6 top-12 p-2 bg-[#0F2F25]/10 hover:bg-[#0F2F25]/80 transition-colors rounded-full shadow-sm">
          <ChevronLeft className="w-5 h-5 text-gold" />
        </button>

        <button
          onClick={() => setCurrency(currency === 'USD' ? 'IQD' : 'USD')}
          className="bg-[#0F2F25]/80 hover:bg-[#184235] backdrop-blur-md px-3 py-1.5 rounded-xl flex items-center gap-1.5 mb-6 shadow-sm border border-gold/20 mt-2 transition-transform active:scale-95"
        >
           <div className="bg-gold text-[#0A1F18] rounded-[4px] p-0.5 flex items-center justify-center">
             {currency === 'USD' ? <DollarSign className="w-3 h-3" strokeWidth={3} /> : <span className="text-[10px] font-bold leading-none px-0.5 mt-0.5">ع.د</span>}
           </div>
           <span className="text-gold font-bold text-[13px] tracking-wide">{currency}</span>
        </button>

        <div className="flex items-baseline mb-5">
          {currency === 'USD' && <span className="text-[26px] font-bold text-gold/70 tracking-tight mr-1">$</span>}
          <span className="text-[48px] md:text-[56px] font-black text-gold tracking-tighter leading-none">
            {currency === 'USD'
              ? (balanceUsdCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
              : usdCentsToIqd(balanceUsdCents, exchangeRate).toLocaleString('en-US')}
          </span>
          {currency === 'IQD' && <span className="text-[26px] font-bold text-gold/70 tracking-tight ml-2">IQD</span>}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex justify-center items-center gap-3 py-6 px-5 relative z-0">
        <button onClick={() => handleOpenModal('withdrawal')} className="flex-1 bg-[#184235] hover:bg-[#205242] transition-colors text-gold py-4 rounded-[20px] flex items-center justify-center gap-2 font-bold text-[15px] shadow-lg">
          Withdraw
          <div className="w-5 h-5 rounded-full border-[1.5px] border-gold/30 flex items-center justify-center">
            <ArrowUp className="w-3 h-3" strokeWidth={3} />
          </div>
        </button>

        <button
          disabled
          title="قريباً / Coming soon"
          className="w-[72px] h-[72px] bg-[#0A1F18] text-gold/40 rounded-[24px] flex flex-col items-center justify-center shadow-lg z-10 shrink-0 cursor-not-allowed"
        >
          <ScanLine className="w-6 h-6" strokeWidth={2} />
          <span className="text-[8px] font-bold mt-1">قريباً</span>
        </button>

        <button onClick={() => handleOpenModal('deposit')} className="flex-1 bg-[#184235] hover:bg-[#205242] transition-colors text-gold py-4 rounded-[20px] flex items-center justify-center gap-2 font-bold text-[15px] shadow-lg">
          <div className="w-5 h-5 rounded-full border-[1.5px] border-gold/30 flex items-center justify-center">
            <ArrowDown className="w-3 h-3" strokeWidth={3} />
          </div>
          Add Funds
        </button>
      </div>

      {/* Bottom Section */}
      <div className="bg-[#0A1F18] flex-1 rounded-t-[44px] px-5 pt-8 pb-12 relative z-10 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
        {/* Notch */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[80px] h-4 bg-black rounded-b-[20px] flex justify-center">
           <div className="w-8 h-1 bg-gold/30 rounded-full mt-1.5"></div>
        </div>

        <div className="mt-6">
          <div className="flex justify-between items-center mb-3 px-1">
            <h3 className="text-gold font-bold text-[15px]">Recent Activity</h3>
            <button onClick={() => setViewAllActivity(!viewAllActivity)} className="p-2 -mr-2 hover:bg-gold/10 rounded-full transition-colors">
              <ArrowRight className={`w-4 h-4 text-gold transition-transform duration-300 ${viewAllActivity ? 'rotate-90' : ''}`} />
            </button>
          </div>

          <div className="space-y-3">
            {transactions.length === 0 && (
              <div className="text-gold/60 text-center py-4 text-sm">No recent activity</div>
            )}
            {(viewAllActivity ? transactions : transactions.slice(0, 5)).map(tx => (
              <div key={tx.id} className="bg-[#0F2F25] rounded-[24px] p-4 flex items-center justify-between shadow-sm border border-gold/10">
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-[14px] flex items-center justify-center bg-[#184235]">
                    {tx.type === 'deposit' ? <ArrowDownLeft className="w-5 h-5 text-gold" /> : <ArrowUp className="w-5 h-5 text-gold" />}
                  </div>
                  <div>
                    <h4 className="text-gold font-bold text-[15px] capitalize">{tx.note ? tx.note : tx.type}</h4>
                    <span className="text-gold/60 font-medium text-[12px] capitalize flex items-center gap-1.5 flex-wrap">
                      {new Date(tx.date).toLocaleDateString()}
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                        tx.status === 'pending' ? 'bg-yellow-500/10 text-yellow-500' :
                        tx.status === 'approved' ? 'bg-[#59A846]/10 text-[#59A846]' :
                        'bg-[#B03142]/10 text-[#B03142]'
                      }`}>
                        {tx.status === 'pending' && <Clock className="w-3 h-3" />}
                        {tx.status === 'approved' && <CheckCircle className="w-3 h-3" />}
                        {tx.status === 'rejected' && <XCircle className="w-3 h-3" />}
                        {tx.status}
                      </span>
                      {tx.receiptUrl && (
                        <a
                          href={tx.receiptUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-gold/70 hover:text-gold underline text-[10px] font-bold"
                        >
                          <Receipt className="w-3 h-3" /> Receipt
                        </a>
                      )}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <span className={`font-bold text-[17px] ${tx.type === 'deposit' ? 'text-[#59A846]' : 'text-[#B03142]'}`}>
                    {tx.type === 'deposit' ? '+' : '-'}{formatCents(tx.amount)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Transaction Modal */}
      {(modalType === 'deposit' || modalType === 'withdrawal') && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 transition-all">
          <div className="bg-[#0A1F18]/80 backdrop-blur-2xl border border-gold/20 rounded-[32px] w-full max-w-[400px] p-6 sm:p-8 relative shadow-[0_8px_32px_rgba(0,0,0,0.5)] animate-in zoom-in-95 duration-300 flex flex-col max-h-[90vh] overflow-y-auto custom-scrollbar">
            {/* Top Shine Effect */}
            <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent pointer-events-none rounded-[32px]"></div>

            <button type="button" onClick={() => setModalType(null)} className="absolute top-6 right-6 text-gold/50 hover:text-gold bg-white/5 hover:bg-white/10 p-2 rounded-full transition-colors z-[60]">
              <X className="w-5 h-5" />
            </button>

            <div className="relative z-10">
              <h2 className="text-2xl font-black text-gold mb-1 text-center tracking-tight">
                {modalType === 'deposit' ? 'Add Funds' : 'Withdraw'}
              </h2>
              <p className="text-gold/60 text-center text-xs mb-6">
                {modalType === 'deposit'
                  ? 'Transfer to one of the accounts below, then submit your receipt — deposits are reviewed by our team'
                  : 'Withdrawal requests are reviewed and paid out by our team'}
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                {formError && (
                  <div className="bg-[#B03142]/10 border border-[#B03142]/40 text-[#e4899a] text-xs font-medium rounded-2xl p-3 text-center">
                    {formError}
                  </div>
                )}

                {modalType === 'withdrawal' && (
                  <div className="bg-white/5 border border-gold/10 rounded-2xl p-4 flex items-center justify-between">
                    <span className="text-gold/70 font-medium text-sm">Available Balance</span>
                    <span className="text-gold font-bold text-lg">{formatCents(balanceUsdCents)}</span>
                  </div>
                )}

                {modalType === 'deposit' && (
                  <div className="bg-white/5 p-4 rounded-2xl border border-gold/10">
                    <h3 className="text-gold font-bold mb-3 text-xs uppercase tracking-wider flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-gold/70" /> Payment Methods
                    </h3>
                    {paymentMethods.length === 0 ? (
                      <p className="text-gold/50 text-xs text-center py-2">
                        No payment methods are configured yet — please contact support before depositing.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {paymentMethods.map(m => (
                          <div
                            key={m.id}
                            onClick={() => {
                              navigator.clipboard.writeText(m.details).catch(() => {});
                              setSelectedMethod(m.name);
                              setAccountNumber(m.details);
                            }}
                            className={`flex justify-between items-center p-3 rounded-xl border cursor-pointer transition-colors group ${selectedMethod === m.name ? 'bg-black/40 border-gold/40' : 'bg-black/20 hover:bg-black/40 border-white/5'}`}
                            title="Click to select this method (copies the account number)"
                          >
                            <span className="text-gold/90 font-medium text-sm flex items-center gap-1.5">
                              {selectedMethod === m.name && <CheckCircle className="w-3.5 h-3.5 text-gold" />}
                              {m.name}
                            </span>
                            <div className="flex items-center gap-2">
                              <span className="text-gold/80 font-mono bg-black/40 group-hover:bg-black/60 px-2 py-1 rounded-md text-xs transition-colors select-all">{m.details}</span>
                              <Copy className="w-3.5 h-3.5 text-gold/40 group-hover:text-gold/80 transition-colors" />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-4">
                  {modalType === 'withdrawal' && (
                    <div>
                      <label className="block text-gold/60 text-[10px] font-bold mb-1.5 uppercase tracking-wider">Account / Wallet Number</label>
                      <input
                        type="text"
                        value={accountNumber}
                        onChange={(e) => setAccountNumber(e.target.value)}
                        className="w-full bg-black/20 border border-gold/10 rounded-2xl px-4 py-3.5 text-gold text-sm placeholder-gold/30 focus:outline-none focus:border-gold/40 transition-colors shadow-inner"
                        placeholder="Where should we send the funds?"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-gold/60 text-[10px] font-bold mb-1.5 uppercase tracking-wider">{currency === 'IQD' ? 'Amount (IQD)' : 'Amount (USD)'}</label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                        {currency === 'IQD' ? <span className="text-gold/50 font-bold text-sm ml-1">ع.د</span> : <DollarSign className="w-4 h-4 text-gold/50" />}
                      </div>
                      <input
                        type="text"
                        value={amount}
                        onChange={handleAmountChange}
                        className="w-full bg-black/20 border border-gold/10 rounded-2xl pl-10 pr-4 py-3.5 text-gold font-bold text-lg placeholder-gold/30 focus:outline-none focus:border-gold/40 transition-colors shadow-inner"
                        placeholder="0.00"
                        required
                      />
                    </div>
                  </div>

                  {modalType === 'deposit' && (
                  <div>
                    <label className="block text-gold/60 text-[10px] font-bold mb-1.5 uppercase tracking-wider">Receipt / Screenshot <span className="text-[#B03142]">*</span></label>
                    <div className={`relative border-2 border-dashed rounded-2xl p-5 text-center transition-all group bg-black/10 ${isUploading ? 'border-gold/40 cursor-wait' : 'border-gold/20 hover:border-gold/40 hover:bg-white/5 cursor-pointer'}`}>
                      <input
                        type="file"
                        ref={fileInputRef}
                        accept="image/*"
                        onChange={handleFileUpload}
                        disabled={isUploading}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10 disabled:cursor-wait"
                      />
                      {isUploading ? (
                        <div className="flex flex-col items-center justify-center gap-2 text-gold/70">
                          <div className="w-8 h-8 border-2 border-gold/20 border-t-gold rounded-full animate-spin" />
                          <span className="text-xs font-bold text-gold">Uploading…</span>
                        </div>
                      ) : receiptKey ? (
                        <div className="flex flex-col items-center justify-center gap-2 text-[#59A846]">
                          <div className="w-10 h-10 bg-[#59A846]/10 rounded-full flex items-center justify-center">
                            <CheckCircle className="w-5 h-5 text-[#59A846]" />
                          </div>
                          <span className="text-xs font-bold text-gold">Receipt uploaded — tap to replace</span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center gap-1.5 text-gold/40 group-hover:text-gold/70 transition-colors">
                          <div className="w-10 h-10 bg-white/5 rounded-full flex items-center justify-center group-hover:bg-white/10 transition-colors border border-gold/5">
                            <Upload className="w-4 h-4" />
                          </div>
                          <span className="text-xs font-medium">Tap to upload image</span>
                        </div>
                      )}
                    </div>
                  </div>
                  )}

                  <div>
                    <label className="block text-gold/60 text-[10px] font-bold mb-1.5 uppercase tracking-wider">Note (Optional)</label>
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="w-full bg-black/20 border border-gold/10 rounded-2xl px-4 py-3.5 text-gold text-sm placeholder-gold/30 focus:outline-none focus:border-gold/40 transition-colors h-20 resize-none shadow-inner"
                      placeholder="Add a note..."
                    />
                  </div>
                </div>

                <div className="pt-4 flex gap-3">
                  <button type="button" onClick={() => setModalType(null)} className="flex-1 px-4 py-3.5 rounded-xl font-bold text-gold/60 hover:text-gold hover:bg-white/5 transition-colors border border-gold/10">
                    Cancel
                  </button>
                  <button type="submit" disabled={isSubmitting || isUploading} className={`flex-[2] bg-gradient-to-r from-gold to-[#BAA369] text-[#0A1F18] font-black text-sm py-3.5 rounded-xl transition-all transform active:scale-[0.98] ${(isSubmitting || isUploading) ? 'opacity-70 cursor-not-allowed' : 'hover:shadow-[0_0_20px_rgba(186,163,105,0.3)]'}`}>
                    {isSubmitting ? (
                      <span className="flex items-center justify-center gap-2">
                        <div className="w-4 h-4 border-2 border-[#0A1F18]/30 border-t-[#0A1F18] rounded-full animate-spin" />
                        Processing...
                      </span>
                    ) : 'Submit Request'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
