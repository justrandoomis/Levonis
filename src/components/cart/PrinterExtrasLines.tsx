/**
 * «خصص طابعتك» phase 2 (0235) on the cart and the checkout: the membership
 * chosen with a printer and the owner's filament kit, drawn UNDER their
 * printer line. Every figure is the server's (`printer_extras.membership.quote`,
 * `item.kit.total_iqd`, the checkout quote's `membership`); nothing is added up
 * here. The kit lines are locked — no quantity or remove of their own: their
 * quantity follows the printer and removing the printer removes them. No icons
 * here: an icon shared by two lazy chunks moves into vendor-icons, which the
 * product page opens with (its gzip budget).
 */
import { tierLabel } from '../subscription/tierMeta';
import { PS_STRINGS, servicesErrorText, type PsLang } from '../product/printerServicesStrings';
import type { CartMembershipQuote, CartMembershipRefusal } from '../../lib/api';

export interface KitLineView {
  id: string;
  name: string;
  name_ar?: string | null;
  variant?: string | null;
  qty: number;
  /** The door would refuse this line now (stock, route): said on the kit. */
  blocked?: boolean;
}

export interface PrinterExtrasLinesProps {
  lang: PsLang;
  money: (iqd: number) => string;
  /** The membership chosen with THIS printer, as the server quotes it now. */
  membership?: CartMembershipQuote | null;
  /** The printer's kit: its title, the server's total, whether it still matches the owner's kit. */
  kit?: { title: { ar: string; en: string; ckb: string } | null; total_iqd: number | null; current: boolean } | null;
  kitLines?: KitLineView[];
  onRemoveMembership?: () => void;
  onRemoveKit?: () => void;
  /** Opens the printer's sheet to choose the kit (or the membership) again. */
  onRechoose?: () => void;
  busy?: boolean;
}

export default function PrinterExtrasLines({ lang, money, membership = null, kit = null, kitLines = [], onRemoveMembership, onRemoveKit, onRechoose, busy = false }: PrinterExtrasLinesProps) {
  const s = PS_STRINGS[lang];
  if (!membership && !kit && !kitLines.length) return null;
  // The full sentence (it names the fix: remove it, or choose a higher tier), else the short reason.
  const refused = (code: string) => servicesErrorText(code, lang) || s.memberBlocked[code] || s.unavailable;
  const refusal = membership && !membership.ok ? (membership as CartMembershipRefusal) : null;
  const plan = membership ? (refusal ? refusal.plan ?? null : membership.plan) : null;
  const planId = plan?.id ?? refusal?.plan_id ?? '';
  const kitBlocked = kit && !kit.current ? servicesErrorText('KIT_CHANGED', lang) : kitLines.some((l) => l.blocked) ? servicesErrorText('KIT_UNAVAILABLE', lang) : '';
  const action = (label: string, onClick: (() => void) | undefined, data: string) =>
    onClick ? (
      <button type="button" disabled={busy} onClick={onClick} className="inline-flex min-h-11 items-center text-[12px] font-semibold text-text-primary underline disabled:opacity-50" data-extras-action={data}>
        {label}
      </button>
    ) : null;
  return (
    <div className="mb-2 space-y-2" data-printer-extras>
      {membership ? (
        <div className="rounded-xl border border-border-subtle p-2.5" data-extras-membership={planId} data-extras-membership-ok={membership.ok ? 'true' : 'false'}>
          <p className="flex items-center justify-between gap-3 text-[12px] font-bold text-text-primary">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{plan ? s.memberLine(tierLabel(plan.tier), s.months(plan.duration_months)) : s.membership}</span>
            </span>
            <span className="shrink-0 tabular-nums" dir="auto">{membership.ok ? `+${money(membership.charge_iqd)}` : '—'}</span>
          </p>
          {membership.ok ? (
            <>
              <p className="mt-0.5 text-[11px] leading-snug text-text-secondary tabular-nums" dir="auto">
                {membership.kind === 'upgrade' ? s.memberUpgrade : s.memberNew}
                {membership.credit_iqd > 0 ? ` · ${money(membership.price_iqd)} · ${s.memberCredit(money(membership.credit_iqd))}` : ''}
              </p>
            </>
          ) : (
            <p role="alert" className="mt-0.5 text-[11px] text-text-primary" data-extras-membership-refused={refusal?.code}>{refused(refusal?.code ?? '')}</p>
          )}
          <p className="mt-1 text-[11px] leading-snug text-text-secondary">{s.memberStarts}</p>
          <p className="text-[11px] leading-snug text-text-secondary">{s.memberFinal}</p>
          {membership.ok ? <p className="text-[11px] leading-snug text-text-secondary">{s.memberAtCheckout}</p> : null}
          {action(s.removeMembership, onRemoveMembership, 'remove-membership')}
        </div>
      ) : null}
      {kit || kitLines.length ? (
        <div className="rounded-xl border border-border-subtle p-2.5" data-extras-kit>
          <p className="flex items-center justify-between gap-3 text-[12px] font-bold text-text-primary">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{kit?.title ? kit.title[lang] || kit.title.ar : s.filament}</span>
            </span>
            {kit && kit.total_iqd !== null ? <span className="shrink-0 tabular-nums" dir="auto">+{money(kit.total_iqd)}</span> : null}
          </p>
          <ul className="mt-1 space-y-0.5">
            {kitLines.map((l) => (
              <li key={l.id} className="flex items-baseline justify-between gap-3 text-[11px] text-text-secondary" data-kit-line={l.id}>
                <span className="min-w-0 truncate">{lang === 'en' ? l.name : l.name_ar || l.name}{l.variant ? ` · ${l.variant}` : ''}</span>
                <span className="shrink-0 tabular-nums" dir="auto">{l.blocked && !l.qty ? s.kitItemOut : `×${l.qty}`}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] leading-snug text-text-secondary">{s.kitFollows}</p>
          {kitBlocked ? <p role="alert" className="mt-0.5 text-[11px] text-text-primary">{kitBlocked}</p> : null}
          <span className="flex flex-wrap gap-x-4">
            {kitBlocked ? action(s.rechoose, onRechoose, 'rechoose-kit') : null}
            {action(s.removeKit, onRemoveKit, 'remove-kit')}
          </span>
        </div>
      ) : null}
    </div>
  );
}
