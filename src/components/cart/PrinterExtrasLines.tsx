/**
 * «خصص طابعتك» phase 2 (0235) on the cart and the checkout: the membership
 * chosen with a printer and the owner's filament kit, drawn UNDER their
 * printer line. Every figure is the server's (`printer_extras.membership.quote`,
 * `item.kit.total_iqd`, the checkout quote's `membership`); nothing is added up
 * here. The kit lines are locked — no quantity or remove of their own: their
 * quantity follows the printer and removing the printer removes them. No icons
 * here: an icon shared by two lazy chunks moves into vendor-icons, which the
 * product page opens with (its gzip budget).
 *
 * Phase 4 (0242; DECISIONS row 355): each kit line says its colour — the one
 * the customer chose, or «لون عشوائي» — and a chosen colour that sold out
 * offers «اجعله لوناً عشوائياً» (PUT extras kitColors {pid:'random'}) or
 * removing the kit. The add-ons bought with the printer are listed under it
 * too, each with its struck before price and its own remove (an add-on line
 * may be removed; a kit line may not). The colour dot is an inline style.
 */
import { tierLabel } from '../subscription/tierMeta';
import { PS_STRINGS, servicesErrorText, type PsLang } from '../product/printerServicesStrings';
import type { CartMembershipQuote, CartMembershipRefusal } from '../../lib/api';

type Text3 = { ar: string; en: string; ckb: string };

/** How a kit or add-on line's colour was decided (the server's `kit_line.color_mode` / `addon_line.color_mode`). */
export type AttachedColourMode = 'fixed' | 'chosen' | 'random';

export interface KitLineView {
  id: string;
  name: string;
  name_ar?: string | null;
  variant?: string | null;
  qty: number;
  /** The door would refuse this line now (stock, route): said on the kit. */
  blocked?: boolean;
  /** Phase 4: the line's product (for «اجعله لوناً عشوائياً»), its colour and how it was decided. */
  productId?: string;
  colorMode?: AttachedColourMode | null;
  colour?: { name: string; hex: string } | null;
}

/** Phase 4: one add-on bought with the printer (the printer line's `addons[]`) and its lines. */
export interface AddonView {
  addon_id: string;
  title: Text3 | null;
  total_iqd: number | null;
  before_iqd?: number | null;
  current: boolean;
  lines: KitLineView[];
}

export interface PrinterExtrasLinesProps {
  lang: PsLang;
  money: (iqd: number) => string;
  /** The membership chosen with THIS printer, as the server quotes it now. */
  membership?: CartMembershipQuote | null;
  /** The printer's kit: its title, the server's total (after the owner's discount) and before it, whether it still matches the owner's kit. */
  kit?: { title: Text3 | null; total_iqd: number | null; before_iqd?: number | null; current: boolean } | null;
  kitLines?: KitLineView[];
  /** Phase 4: the add-ons bought with this printer. */
  addons?: AddonView[];
  onRemoveMembership?: () => void;
  onRemoveKit?: () => void;
  /** Phase 4: a chosen kit colour sold out → let the system pick one in stock. */
  onRandomColour?: (productId: string) => void;
  /** Phase 4: a chosen add-on colour sold out → let the system pick one in stock for that add-on. */
  onRandomAddonColour?: (addonId: string) => void;
  /** Phase 4: removes one add-on. */
  onRemoveAddon?: (addonId: string) => void;
  /** Opens the printer's sheet to choose the kit (or the membership) again. */
  onRechoose?: () => void;
  busy?: boolean;
}

/** The cart's phase-4 words (this chunk only; the sheet has its own in printerOfferStrings). */
const WORDS: Record<PsLang, {
  addons: string; randomColour: string; chosenColour: string; colourSoldOut: string; makeRandom: string;
  removeAddon: string; addonFollows: string; addonChanged: string; addonUnavailable: string; priceBefore: string;
}> = {
  ar: {
    addons: 'إضافات بسعر خاص',
    randomColour: 'لون عشوائي',
    chosenColour: 'لون اخترته',
    colourSoldOut: 'نفد اللون الذي اخترته.',
    makeRandom: 'اجعله لوناً عشوائياً',
    removeAddon: 'إزالة الإضافة',
    addonFollows: 'تُغلَّف مع الطابعة، وكميتها تتبعها.',
    addonChanged: 'تغيّرت هذه الإضافة أو سعرها — اختر من جديد أو أزلها.',
    addonUnavailable: 'هذه الإضافة غير متوفرة الآن — أزلها لتكمل الطلب.',
    priceBefore: 'السعر قبل الخصم',
  },
  en: {
    addons: 'Add-ons at a special price',
    randomColour: 'Random colour',
    chosenColour: 'Your colour',
    colourSoldOut: 'The colour you chose is sold out.',
    makeRandom: 'Make it a random colour',
    removeAddon: 'Remove add-on',
    addonFollows: 'Packed with the printer; its quantity follows it.',
    addonChanged: 'This add-on or its price has changed — choose again or remove it.',
    addonUnavailable: 'This add-on is not available right now — remove it to complete the order.',
    priceBefore: 'Price before discount',
  },
  ckb: {
    addons: 'زیادکراوەکان بە نرخی تایبەت',
    randomColour: 'ڕەنگی هەڕەمەکی',
    chosenColour: 'ڕەنگی هەڵبژاردەی خۆت',
    colourSoldOut: 'ئەو ڕەنگەی هەڵتبژارد نەماوە.',
    makeRandom: 'بیکە بە ڕەنگی هەڕەمەکی',
    removeAddon: 'لابردنی زیادکراوەکە',
    addonFollows: 'لەگەڵ پرینتەرەکە دەپێچرێتەوە، و بڕەکەی شوێنی دەکەوێت.',
    addonChanged: 'ئەم زیادکراوە یان نرخەکەی گۆڕاوە — دووبارە هەڵیبژێرە یان لای ببە.',
    addonUnavailable: 'ئەم زیادکراوە ئێستا بەردەست نییە — لای ببە بۆ تەواوکردنی داواکارییەکە.',
    priceBefore: 'نرخ پێش داشکاندن',
  },
};

/** The letters and digits of a name, lower-cased (spaces, marks and punctuation dropped). */
const bare = (v: string) => v.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** An add-on's title and its product's name say the same thing (one contains the other): the name line is dropped. */
export function nearlySame(title: string, name: string): boolean {
  const a = bare(title);
  const b = bare(name);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

export default function PrinterExtrasLines({ lang, money, membership = null, kit = null, kitLines = [], addons = [], onRemoveMembership, onRemoveKit, onRandomColour, onRandomAddonColour, onRemoveAddon, onRechoose, busy = false }: PrinterExtrasLinesProps) {
  const s = PS_STRINGS[lang];
  const w = WORDS[lang];
  if (!membership && !kit && !kitLines.length && !addons.length) return null;
  // The full sentence (it names the fix: remove it, or choose a higher tier), else the short reason.
  const refused = (code: string) => servicesErrorText(code, lang) || s.memberBlocked[code] || s.unavailable;
  const refusal = membership && !membership.ok ? (membership as CartMembershipRefusal) : null;
  const plan = membership ? (refusal ? refusal.plan ?? null : membership.plan) : null;
  const planId = plan?.id ?? refusal?.plan_id ?? '';
  // A chosen colour that sold out has its own fix on its line; the kit's sentence is for anything else.
  const colourOut = (l: KitLineView) => !!l.blocked && l.colorMode === 'chosen' && !!l.productId;
  const kitBlocked = kit && !kit.current ? servicesErrorText('KIT_CHANGED', lang) : kitLines.some((l) => l.blocked && !colourOut(l)) ? servicesErrorText('KIT_UNAVAILABLE', lang) : '';
  const action = (label: string, onClick: (() => void) | undefined, data: string) =>
    onClick ? (
      <button type="button" disabled={busy} onClick={onClick} className="inline-flex min-h-11 items-center text-[12px] font-semibold text-text-primary underline disabled:opacity-50" data-extras-action={data}>
        {label}
      </button>
    ) : null;
  /** «~~before~~ +after» — before only when the server sent a higher one. */
  const price = (after: number | null, before: number | null | undefined) =>
    after === null ? null : (
      <span className="shrink-0 tabular-nums" dir="auto">
        {before !== null && before !== undefined && before > after ? (
          <span className="me-1.5 text-[11px] font-normal text-text-secondary line-through" aria-label={`${w.priceBefore}: ${money(before)}`}>{money(before)}</span>
        ) : null}
        +{money(after)}
      </span>
    );
  /** One kit or add-on line: its name, its colour (chosen or «لون عشوائي»), its quantity — and a sold-out chosen colour's fix. */
  const line = (l: KitLineView, kind: 'kit' | 'addon', addonId?: string, hideName = false) => {
    const colourWord = l.colorMode === 'random' ? w.randomColour : l.colorMode === 'chosen' ? w.chosenColour : '';
    return (
      <li key={l.id} className="text-[11px] text-text-secondary" data-kit-line={kind === 'kit' ? l.id : undefined} data-addon-line={kind === 'addon' ? l.id : undefined} data-line-colour-mode={l.colorMode || undefined}>
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">{hideName ? (l.variant && !l.colour ? l.variant : '') : `${lang === 'en' ? l.name : l.name_ar || l.name}${l.variant && !l.colour ? ` · ${l.variant}` : ''}`}</span>
          <span className="shrink-0 tabular-nums" dir="auto">{l.blocked && !l.qty ? s.kitItemOut : `×${l.qty}`}</span>
        </span>
        {l.colour || colourWord ? (
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {l.colour ? <span aria-hidden="true" className="inline-block shrink-0 rounded-full border border-border-subtle" style={{ width: 10, height: 10, background: l.colour.hex || 'transparent' }} /> : null}
            {l.colour ? <span dir="auto">{l.colour.name}</span> : null}
            {colourWord ? <span className="rounded-full border border-border-subtle px-2">{colourWord}</span> : null}
          </span>
        ) : null}
        {colourOut(l) ? (
          <span className="block">
            <span role="alert" className="block text-text-primary">{w.colourSoldOut}</span>
            {kind === 'kit' ? action(w.makeRandom, onRandomColour ? () => onRandomColour(l.productId as string) : undefined, 'random-colour') : null}
            {kind === 'addon' && addonId ? action(w.makeRandom, onRandomAddonColour ? () => onRandomAddonColour(addonId) : undefined, 'random-addon-colour') : null}
          </span>
        ) : null}
      </li>
    );
  };
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
            {kit ? price(kit.total_iqd, kit.before_iqd) : null}
          </p>
          <ul className="mt-1 space-y-0.5">
            {kitLines.map((l) => line(l, 'kit'))}
          </ul>
          <p className="mt-1 text-[11px] leading-snug text-text-secondary">{s.kitFollows}</p>
          {kitBlocked ? <p role="alert" className="mt-0.5 text-[11px] text-text-primary">{kitBlocked}</p> : null}
          <span className="flex flex-wrap gap-x-4">
            {kitBlocked ? action(s.rechoose, onRechoose, 'rechoose-kit') : null}
            {action(s.removeKit, onRemoveKit, 'remove-kit')}
          </span>
        </div>
      ) : null}
      {addons.length ? (
        <div className="rounded-xl border border-border-subtle p-2.5" data-extras-addons>
          <p className="text-[12px] font-bold text-text-primary">{w.addons}</p>
          <ul className="mt-1 space-y-2">
            {addons.map((a) => {
              const title = a.title ? a.title[lang] || a.title.ar : a.lines[0] ? (lang === 'en' ? a.lines[0].name : a.lines[0].name_ar || a.lines[0].name) : '';
              const said = !a.current ? w.addonChanged : a.lines.some((l) => l.blocked) ? w.addonUnavailable : '';
              return (
                <li key={a.addon_id} data-extras-addon={a.addon_id} data-extras-addon-current={a.current ? 'true' : 'false'}>
                  <p className="flex items-center justify-between gap-3 text-[12px] font-semibold text-text-primary">
                    <span className="min-w-0 line-clamp-2" dir="auto">{title}</span>
                    {price(a.total_iqd, a.before_iqd)}
                  </p>
                  <ul className="mt-0.5 space-y-0.5">
                    {a.lines.map((l) => line(l, 'addon', a.addon_id, nearlySame(title, lang === 'en' ? l.name : l.name_ar || l.name)))}
                  </ul>
                  {said ? <p role="alert" className="mt-0.5 text-[11px] text-text-primary">{said}</p> : null}
                  {action(w.removeAddon, onRemoveAddon ? () => onRemoveAddon(a.addon_id) : undefined, 'remove-addon')}
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-[11px] leading-snug text-text-secondary">{w.addonFollows}</p>
        </div>
      ) : null}
    </div>
  );
}
