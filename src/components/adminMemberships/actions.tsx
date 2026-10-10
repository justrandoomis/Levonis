/**
 * THE TWO THINGS AN ADMIN DOES *TO* A MEMBER FROM THE PROFILE WINDOW, and the
 * one control both of them need: a written reason.
 *
 * Moved out of AdminMemberships.tsx with the member detail itself. Nothing
 * about the grant or the restriction case changed in the move except where the
 * reason is typed — see ReasonPrompt, which is the one deliberate behavioural
 * change and has its own header.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, newIdempotencyKey } from '../../lib/api';
import { BENEFIT_LABELS, CASE_TYPES, benefitLabel, type S } from './strings';

/**
 * THE REASON IS TYPED INSIDE THE WINDOW THAT ASKED FOR IT — not in a second
 * window on top of it, and never in a browser `prompt()`.
 *
 * It used to be `ReasonWindow`, an `Overlay` of its own. That was right while
 * the member detail was a block at the foot of the page; it stopped being
 * right the moment the detail became a modal, because a dialog opened over a
 * dialog breaks all three of the things the outer window promises:
 *
 *   ESCAPE. Both overlays listen for Escape on `document`. The inner one calls
 *   `stopPropagation`, which does nothing to a sibling listener on the SAME
 *   node — so one Escape would close the reason window AND the profile behind
 *   it, throwing away the reason and the member together.
 *
 *   THE FOCUS TRAP. `useModalFocus` keeps Tab inside the PROFILE panel, and an
 *   Overlay portals its panel to `document.body`, so the reason window is not
 *   inside that panel: the first Shift+Tab in it would pull focus back out
 *   into the profile underneath.
 *
 *   THE STACK. `Overlay`'s z is lifted above the app chrome by `overlayLayer`,
 *   so an inner window with the default z would render BELOW a profile opened
 *   at z=50. The reason field would be present, announced, and invisible.
 *
 * Inline, none of those exist: focus never leaves the panel, Escape still
 * means "close the profile", and the reason sits under the control that asked
 * for it, which is also where the eye already is.
 */
export function ReasonPrompt({
  open,
  busy,
  title,
  body,
  confirmLabel,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  error?: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { loc } = useLanguage();
  const [reason, setReason] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason('');
    // The caret goes where the answer is expected. `preventScroll` because the
    // profile body is the scroller here: without it the browser would jump the
    // whole section to the top of the window and the admin would lose the card
    // they pressed.
    fieldRef.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;
  const ready = reason.trim().length >= 3 && !busy;

  return (
    <div className="mt-3 rounded-lg border border-border-subtle p-3">
      <p className="text-[12px] font-bold leading-5 text-text-primary">{title}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">{body}</p>
      <label className="mt-2 block">
        <span className="mb-1 block text-[11px] leading-4 text-text-muted">
          {loc('السبب (٣ محارف على الأقل)', 'Reason (at least 3 characters)', 'هۆکار (لانیکەم ٣ پیت)')}
        </span>
        <textarea
          className="lv-input resize-none py-2 text-[13px] leading-5"
          ref={fieldRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          disabled={busy}
          dir="auto"
        />
      </label>
      {error && (
        <p role="alert" className="mt-2 text-[12px] leading-5 text-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="lv-button lv-button-secondary"
        >
          {loc('إلغاء', 'Cancel', 'پاشگەزبوونەوە')}
        </button>
        <button
          type="button"
          onClick={() => ready && onConfirm(reason.trim())}
          disabled={!ready}
          className="lv-button lv-button-primary"
        >
          {busy ? loc('جارٍ…', 'Working…', 'خەریکە…') : confirmLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Give an account a membership without a payment.
 *
 * The schema has allowed `source = 'admin'` since the beginning and nothing
 * ever wrote one, so until now the only way to hold PLUS was to buy it. That
 * left an admin unable to comp a member whose payment failed, restore a
 * subscription cancelled by mistake, or set up a merchant — without pushing
 * real money through a real wallet to do it.
 *
 * It is an ENTITLEMENT, not a transaction: `price_paid_iqd` is 0 and no
 * wallet row moves. A reason is required, because a membership somebody
 * cannot explain later is one that gets revoked by whoever asks loudest.
 */
export function GrantMembership({ userId, onGranted }: { userId: string; onGranted: () => void }) {
  const { loc } = useLanguage();
  const [plans, setPlans] = useState<Array<{ id: string; tier: string; duration_months: number; purchasable: boolean }>>([]);
  const [planId, setPlanId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    api
      .get<{ plans: Array<{ id: string; tier: string; duration_months: number; purchasable: boolean }> }>(
        '/api/memberships/plans'
      )
      .then((d) => {
        setPlans(d.plans);
        // Default to the shortest PLUS term: a comp should be the smallest
        // thing that solves the problem, not the largest.
        const plus = d.plans.filter((p) => p.tier === 'plus').sort((a, b) => a.duration_months - b.duration_months);
        setPlanId(plus[0]?.id ?? d.plans[0]?.id ?? '');
      })
      .catch(() => setPlans([]));
  }, []);

  const [askOpen, setAskOpen] = useState(false);

  async function grant(reason: string) {
    setBusy(true);
    setError('');
    setDone('');
    try {
      const r = await api.post<{ replayed: boolean; tier?: string; active?: boolean; note?: string }>(
        '/api/memberships/admin/grant',
        { userId, planId, reason, idempotencyKey: newIdempotencyKey() }
      );
      setAskOpen(false);
      setDone(
        r.replayed
          ? loc('هذا المنح مسجّل مسبقًا.', 'That grant was already recorded.', 'ئەم پێدانە پێشتر تۆمارکراوە.')
          : r.note ?? loc('تم المنح.', 'Granted.', 'پێدرا.')
      );
      onGranted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر المنح', 'Could not grant it', 'نەتوانرا بدرێت'));
    } finally {
      setBusy(false);
    }
  }

  if (!plans.length) return null;

  return (
    <div className="mt-3 border-t border-border-subtle pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="lv-input w-auto min-h-9 px-2 text-[12px] leading-4"
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
          aria-label={loc('خطة الاشتراك', 'Membership plan', 'پلانی ئەندامێتی')}
        >
          {plans.map((p) => (
            <option key={p.id} value={p.id} className="bg-surface">
              {p.tier.toUpperCase()} · {p.duration_months}mo
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setAskOpen(true)}
          disabled={busy || !planId || askOpen}
          className="lv-button lv-button-primary lv-button-sm"
        >
          {busy
            ? loc('جارٍ…', 'Working…', 'خەریکە…')
            : loc('منح اشتراك بدون دفع', 'Grant without payment', 'بەخشینی بەشداری')}
        </button>
      </div>
      <ReasonPrompt
        open={askOpen}
        busy={busy}
        title={loc('منح اشتراك بدون دفع', 'Grant without payment', 'بەخشینی بەشداری')}
        body={loc(
          'سبب المنح مطلوب ويُسجَّل في سجل التدقيق. لا تُسجَّل أي حركة في المحفظة.',
          'The reason for the grant is required and is kept in the audit log. No wallet movement is recorded.',
          'هۆکاری پێدان پێویستە و لە تۆماری وردبینی هەڵدەگیرێت. هیچ جووڵەیەکی جزدان تۆمار ناکرێت.'
        )}
        confirmLabel={loc('منح', 'Grant', 'پێدان')}
        error={error}
        onCancel={() => setAskOpen(false)}
        onConfirm={(reason) => void grant(reason)}
      />
      <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
        {loc(
          'منح صلاحية وليس عملية مالية — لا تُسجَّل أي حركة في المحفظة، والسبب يُحفظ في سجل التدقيق.',
          'An entitlement, not a transaction — no wallet movement is recorded, and the reason is kept in the audit log.',
          'مافێکە نەک کارێکی دارایی — هیچ جووڵەیەکی جزدان تۆمار ناکرێت.'
        )}
      </p>
      {done && <p className="mt-1 text-[11.5px] leading-5 text-success">{done}</p>}
      {error && !askOpen && <p className="mt-1 text-[11.5px] leading-5 text-danger">{error}</p>}
    </div>
  );
}

export function RestrictionForm({
  userId,
  s,
  lang,
  onDone,
}: {
  userId: string;
  s: S;
  lang: 'ar' | 'en' | 'ckb';
  onDone: () => void;
}) {
  const [caseType, setCaseType] = useState<string>('dropshipping_suspected');
  const [evidence, setEvidence] = useState('');
  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState<'pause' | 'revoke'>('pause');
  const [flags, setFlags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggleFlag = (f: string) => {
    setFlags((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));
  };

  const submit = async () => {
    if (evidence.trim().length < 5 || reason.trim().length < 3) {
      setError(s.required);
      return;
    }
    if (flags.length === 0) {
      setError(s.selectFlag);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/support/admin/members/${userId}/restrictions`, {
        case_type: caseType,
        evidence: evidence.trim(),
        reason: reason.trim(),
        decision,
        benefit_flags: flags,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.loadError);
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-red-500/20 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[11px] leading-4 text-text-muted" htmlFor="restriction-case-type">
            {s.caseType}
          </label>
          <div className="relative">
            <select
              className="lv-input appearance-none pe-8 text-[12px] leading-4"
              id="restriction-case-type"
              value={caseType}
              onChange={(e) => setCaseType(e.target.value)}
            >
              {CASE_TYPES.map((ct) => (
                <option key={ct} value={ct}>
                  {(s as Record<string, unknown>)[`ct_${ct}`] as string}
                </option>
              ))}
            </select>
            {/* `end-2`, not `ltr:right-2 rtl:left-2`: the chevron belongs at the
                trailing edge of the field, and a logical property is the only
                spelling that stays there in all three languages. */}
            <ChevronDown className="pointer-events-none absolute top-1/2 -translate-y-1/2 end-3 h-3.5 w-3.5 text-text-muted" />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11px] leading-4 text-text-muted" htmlFor="restriction-decision">
            {s.decision}
          </label>
          <div className="relative">
            <select
              className="lv-input appearance-none pe-8 text-[12px] leading-4"
              id="restriction-decision"
              value={decision}
              onChange={(e) => setDecision(e.target.value as 'pause' | 'revoke')}
            >
              <option value="pause">{s.d_pause}</option>
              <option value="revoke">{s.d_revoke}</option>
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 -translate-y-1/2 end-3 h-3.5 w-3.5 text-text-muted" />
          </div>
        </div>
      </div>
      <div>
        <span className="mb-1 block text-[11px] leading-4 text-text-muted">{s.flags}</span>
        <div className="flex flex-wrap gap-1.5">
          {Object.keys(BENEFIT_LABELS).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={flags.includes(f)}
              onClick={() => toggleFlag(f)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-bold leading-4 transition-colors ${
                flags.includes(f)
                  ? 'border-transparent bg-[var(--clay-well-bg)] text-danger shadow-press'
                  : 'border-border-subtle bg-surface-raised text-text-secondary shadow-xs hover:text-text-primary'
              }`}
            >
              {benefitLabel(f, lang)}
            </button>
          ))}
        </div>
      </div>
      <textarea
        className="lv-input resize-none py-2 text-[12px] leading-5"
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        rows={2}
        maxLength={4000}
        dir="auto"
        placeholder={s.evidence}
        aria-label={s.evidence}
      />
      <input
        className="lv-input text-[12px] leading-5"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={1000}
        dir="auto"
        placeholder={s.reason}
        aria-label={s.reason}
      />
      {error && (
        <div role="alert" className="text-[12px] leading-5 text-danger">
          {error}
        </div>
      )}
      <button
        onClick={submit}
        disabled={busy}
        className="lv-button lv-button-danger lv-button-sm"
      >
        {busy ? s.creating : s.submitCase}
      </button>
    </div>
  );
}
