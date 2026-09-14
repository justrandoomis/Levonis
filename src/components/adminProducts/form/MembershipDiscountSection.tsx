/**
 * §18 — THE MEMBERSHIP DISCOUNT FOR THIS ONE PRODUCT, set from the product
 * editor.
 *
 * WHY IT IS HERE AND NOT ONLY ON THE BENEFITS SCREEN. An owner deciding what a
 * printer costs decides it in one place: the printer. Making them leave the
 * product, open «مزايا العضوية», create a rule, pick the scope, then find the
 * product again in a picker is how a per-product override gets typed as a
 * SECTION rule by mistake — and a section rule quietly discounts every other
 * product filed under it.
 *
 * THERE IS NO SECOND PERSISTENCE PATH. This panel writes through the SAME
 * admin door as the benefits screen (`/api/admin/membership-benefits`), because
 * every write to `membership_benefit_rules` must append a VERSION and an AUDIT
 * row in one batch (`saveBenefitRule`), and an order must be able to name the
 * configuration version it was priced under. A shortcut that wrote the row from
 * the product save would produce prices nobody could explain afterwards.
 *
 * NOT ONE COMMERCIAL NUMBER IS WRITTEN IN THIS FILE. Every percentage, ceiling
 * and quantity is typed by the owner; the vocabularies (which discount kinds,
 * which ceiling scopes, which tiers) and the UNIT each number is in come from
 * the response's `schema`, so the panel never has to know that `percent` is a
 * percentage and `fixed_iqd` is dinars — see `unitOf`/`unitWord`.
 *
 * PLUS IS NOT OFFERED. `ENTITLEMENT_MINIMUM_TIER` gives PLUS no pricing
 * entitlement, so the admin door refuses a PLUS rule outright: it would save
 * cleanly and then do nothing at every checkout, forever.
 *
 * EVERY REFUSAL IS THE SERVER'S OWN SENTENCE — "Say whether the ceiling is per
 * unit or per order", "Enter the amount in dinars". Nothing here pre-empts,
 * rewords or swallows them.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Save, Trash2 } from 'lucide-react';
import { ApiError, api } from '../../../lib/api';
import { useLanguage } from '../../../LanguageContext';
import {
  CAP_LABEL,
  FIELD_LABEL,
  MODE_LABEL,
  fmtDateTime,
  fmtValue,
  loadBenefits,
  loadVersions,
  notesFromVersions,
  phrase,
  tierChip,
  tierName,
  unitOf,
  unitWord,
  type BenefitRule,
  type BenefitSchema,
  type CapScope,
  type DiscountMode,
  type Loc,
} from '../../adminBenefits/shared';
import { Banner, Field, Grid, Money, Select, btnDanger, btnGhost, btnPrimary } from './formUi';

/** The five values this panel edits. Everything else a rule carries — its
 *  window, its priority, its minimum order, its name and its note — belongs to
 *  the benefits screen and is carried through a save here untouched. */
interface TierForm {
  discount_mode: '' | DiscountMode;
  percent: number | null;
  fixed_iqd: number | null;
  max_discount_iqd: number | null;
  cap_scope: '' | CapScope;
  max_quantity: number | null;
}

const BLANK: TierForm = {
  discount_mode: '',
  percent: null,
  fixed_iqd: null,
  max_discount_iqd: null,
  cap_scope: '',
  max_quantity: null,
};

function formFrom(rule: BenefitRule | null): TierForm {
  if (!rule) return { ...BLANK };
  return {
    discount_mode: rule.discount_mode ?? '',
    percent: rule.percent,
    fixed_iqd: rule.fixed_iqd,
    max_discount_iqd: rule.max_discount_iqd,
    cap_scope: rule.cap_scope ?? '',
    max_quantity: rule.max_quantity,
  };
}

/**
 * THE RULE THAT ACTUALLY APPLIES when a product carries more than one override
 * for the same tier — nothing in the door forbids two. The order is
 * `selectRule`'s own (packages/pricing/src/membershipBenefits.ts): at one scope
 * the higher priority wins, and a stable id comparison is the last resort. The
 * panel edits that one and says so when there are others.
 */
function winnerFor(rules: BenefitRule[], tier: string): BenefitRule | null {
  const mine = rules.filter((r) => r.tier === tier);
  if (mine.length === 0) return null;
  return [...mine].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}

/** The two halves of a bilingual label, so a unit the SERVER named is printed
 *  in the reader's own words on both lines of the form's label. */
const AR: Loc = (ar) => ar;
const EN: Loc = (_ar, en) => en;

export default function MembershipDiscountSection({
  productId,
  typedMemberPrice,
}: {
  /** null on a product that has never been saved: there is nothing to scope to. */
  productId: string | null;
  /**
   * The member prices TYPED on this product, live from the form. A typed
   * `pro_price_iqd` / `prime_price_iqd` is the owner's answer for this exact
   * product and beats every rule (docs/MEMBERSHIP_BENEFITS.md §2), so an
   * override entered beside one would never be reached — which the panel says
   * rather than leaving the owner to discover it at a checkout.
   */
  typedMemberPrice: Record<string, number | null>;
}) {
  const { loc } = useLanguage();
  const [schema, setSchema] = useState<BenefitSchema | null>(null);
  const [rules, setRules] = useState<BenefitRule[]>([]);
  /** Recovered from the version history — `null` while unknown. See below. */
  const [notes, setNotes] = useState<Map<string, string> | null>(null);
  const [forms, setForms] = useState<Record<string, TierForm>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rowOk, setRowOk] = useState<Record<string, string>>({});

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setLoadError('');
      try {
        const payload = await loadBenefits();
        const next = payload.schema ?? null;
        setSchema(next);
        // The whole configuration comes back; this panel is about ONE product's
        // own overrides, so everything else is filtered out here rather than
        // asked for — the door has no per-product read. It is read even for an
        // unsaved product, because the DISABLED panel still shows the real
        // tiers, discount kinds and units rather than a guess at them.
        const mine = productId
          ? (payload.rules ?? []).filter(
              (r) => r.scope === 'product' && r.product_id === productId && r.benefit_type === 'product_discount'
            )
          : [];
        setRules(mine);
        setForms(Object.fromEntries((next?.tiers ?? []).map((t) => [t, formFrom(winnerFor(mine, t))])));
        /**
         * THE NOTE THIS PANEL CANNOT SEE. `GET /api/admin/membership-benefits`
         * drops `notes`, and a PUT replaces the whole row — so saving from here
         * with nothing in hand would erase a note the owner typed on the
         * benefits screen. It is recovered from the most recent version that
         * WROTE the rule, exactly as the benefits editor does; a rule whose last
         * write is older than that window stays unknown and the row says so.
         */
        if (mine.length > 0) {
          try {
            const history = await loadVersions();
            setNotes(notesFromVersions(history.versions ?? []));
          } catch {
            setNotes(null);
          }
        } else {
          setNotes(new Map());
        }
      } catch (e) {
        // Both languages in one literal: a `loc` closure would be new on every
        // render and this callback with it, and the effect below would reload
        // the panel forever.
        setLoadError(
          e instanceof ApiError ? e.message : 'تعذّر تحميل قواعد المزايا / could not load the benefit rules'
        );
      } finally {
        setLoading(false);
      }
    },
    [productId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const set = (tier: string, patch: Partial<TierForm>) => {
    setForms((prev) => ({ ...prev, [tier]: { ...(prev[tier] ?? BLANK), ...patch } }));
    setRowOk((prev) => ({ ...prev, [tier]: '' }));
  };

  const save = async (tier: string) => {
    const f = forms[tier] ?? BLANK;
    const rule = winnerFor(rules, tier);
    setBusy(tier);
    setRowError((prev) => ({ ...prev, [tier]: '' }));
    setRowOk((prev) => ({ ...prev, [tier]: '' }));
    try {
      const body = {
        tier,
        benefit_type: 'product_discount',
        scope: 'product',
        product_id: productId,
        category_id: null,
        sub_category_id: null,
        discount_mode: f.discount_mode || null,
        // Only the chosen kind's value is sent. Leaving a percentage behind
        // after switching to a fixed amount would hand the door a number it
        // must validate and then discard, and could be refused for a field the
        // owner is no longer using.
        percent: f.discount_mode === 'percent' ? f.percent : null,
        fixed_iqd: f.discount_mode === 'fixed' ? f.fixed_iqd : null,
        max_discount_iqd: f.max_discount_iqd,
        cap_scope: f.cap_scope || null,
        max_quantity: f.max_quantity,
        // CARRIED, NEVER EDITED HERE. A PUT replaces the whole row, so every
        // field this panel does not show is sent back as it stands — otherwise
        // a compact editor would quietly clear a window, a priority or a
        // minimum order somebody set on the benefits screen.
        min_subtotal_iqd: rule?.min_subtotal_iqd ?? null,
        enabled: rule ? rule.enabled : true,
        priority: rule?.priority ?? 0,
        valid_from: rule?.valid_from ?? null,
        valid_until: rule?.valid_until ?? null,
        label: rule?.label ?? null,
        notes: rule ? notes?.get(rule.id) || null : null,
      };
      if (rule) await api.put(`/api/admin/membership-benefits/${encodeURIComponent(rule.id)}`, body);
      else await api.post('/api/admin/membership-benefits', body);
      setRowOk((prev) => ({
        ...prev,
        [tier]: loc('حُفظ التجاوز، ودُوِّنت نسخة جديدة من الإعدادات.', 'Saved, and a new configuration version was recorded.'),
      }));
      await load(true);
    } catch (e) {
      // VERBATIM. The door answers in sentences on purpose.
      setRowError((prev) => ({
        ...prev,
        [tier]: e instanceof ApiError ? e.message : loc('تعذّر الحفظ', 'Could not save'),
      }));
    } finally {
      setBusy('');
    }
  };

  const clear = async (tier: string) => {
    const rule = winnerFor(rules, tier);
    if (!rule) return;
    const ok = window.confirm(
      loc('إزالة تجاوز خصم العضوية لهذا المنتج؟', 'Remove the membership discount override for this product?')
    );
    if (!ok) return;
    setBusy(tier);
    setRowError((prev) => ({ ...prev, [tier]: '' }));
    setRowOk((prev) => ({ ...prev, [tier]: '' }));
    try {
      await api.delete(`/api/admin/membership-benefits/${encodeURIComponent(rule.id)}`);
      setRowOk((prev) => ({
        ...prev,
        [tier]: loc('أُزيل التجاوز. تسري الآن قاعدة القسم أو المتجر.', 'Override removed. The section or store-wide rule now applies.'),
      }));
      await load(true);
    } catch (e) {
      setRowError((prev) => ({
        ...prev,
        [tier]: e instanceof ApiError ? e.message : loc('تعذّر الحذف', 'Could not remove'),
      }));
    } finally {
      setBusy('');
    }
  };

  /** A field's label in both languages, each carrying the unit the SERVER
   *  publishes for it — never a unit this file decided. */
  const label = (field: string) => {
    const unit = unitOf(schema, field);
    const ar = phrase(FIELD_LABEL[field], AR, field);
    const en = phrase(FIELD_LABEL[field], EN, field);
    const unitAr = unitWord(unit, AR);
    const unitEn = unitWord(unit, EN);
    return { ar: unitAr ? `${ar} (${unitAr})` : ar, en: unitEn ? `${en} (${unitEn})` : en };
  };

  const header = (
    <div className="min-w-0">
      <h4 className="text-[13px] font-bold text-zinc-300 mb-1 truncate">
        خصم العضوية لهذا المنتج{' '}
        <span className="text-[11px] font-medium text-zinc-500">Membership discount for this product</span>
      </h4>
      <p className="text-[11px] leading-snug text-zinc-500 mb-2.5">
        {loc(
          'ما يُضبط هنا يسبق قاعدة القسم وقاعدة المتجر: المنتج أولًا، ثم القسم الفرعي، ثم القسم الرئيسي، ثم كل المنتجات — وقاعدة واحدة فقط تسري على كل سطر، فلا تُجمع اثنتان.',
          'What is set here beats the section and the store-wide rule: product first, then sub-section, then main section, then every product — and exactly one rule applies per line, never two added together.'
        )}
      </p>
    </div>
  );

  if (loading) {
    return (
      <div className="mt-4 pt-3 border-t border-zinc-800/70 min-w-0" data-form="membership-discount">
        {header}
        <div className="flex items-center justify-center gap-2 py-5 text-[13px] text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          {loc('جارِ التحميل…', 'Loading…')}
        </div>
      </div>
    );
  }

  const tiers = (schema?.tiers ?? []).filter((t) => t !== 'plus');
  const locked = !productId;

  return (
    <div className="mt-4 pt-3 border-t border-zinc-800/70 min-w-0" data-form="membership-discount">
      {header}

      {locked && (
        <Banner kind="warn">
          {loc(
            'احفظ المنتج أولًا — التجاوز يُنسب إلى منتج، ولا وجود له قبل الحفظ.',
            'Save the product first — an override is scoped to a product, and there is none before the first save.'
          )}
        </Banner>
      )}

      {loadError && (
        <Banner kind="error">
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0">{loadError}</span>
            <button type="button" className={`${btnGhost} h-8 px-2.5 text-[12px]`} onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5" /> {loc('إعادة المحاولة', 'Retry')}
            </button>
          </span>
        </Banner>
      )}

      <div className="space-y-2 min-w-0">
        {tiers.map((tier) => {
          const rule = winnerFor(rules, tier);
          const f = forms[tier] ?? BLANK;
          const dirty = JSON.stringify(f) !== JSON.stringify(formFrom(rule));
          const others = rules.filter((r) => r.tier === tier).length - (rule ? 1 : 0);
          const typed = typedMemberPrice[tier] ?? null;
          const noteUnknown = !!rule && (notes === null || !notes.has(rule.id));
          const fid = (field: string) => `mbd-${tier}-${field}`;
          const working = busy === tier;

          return (
            <div
              key={tier}
              data-mb-tier={tier}
              className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-800/20 p-2.5"
            >
              <div className="flex items-center gap-2 mb-2 min-w-0">
                <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-black ${tierChip(tier)}`}>
                  {tierName(tier)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">
                  {rule
                    ? loc('تجاوز مضبوط لهذا المنتج', 'An override is set on this product')
                    : loc('بلا تجاوز — تسري قاعدة القسم أو المتجر', 'No override — the section or store-wide rule applies')}
                </span>
                {rule && (
                  <button
                    type="button"
                    data-mb-action="clear"
                    className={`${btnDanger} h-8 px-2.5 text-[12px]`}
                    disabled={working || locked}
                    onClick={() => void clear(tier)}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> {loc('إزالة', 'Clear')}
                  </button>
                )}
              </div>

              {typed !== null && (
                <Banner kind="warn">
                  {loc(
                    'لهذا المنتج سعر عضوية مكتوب في الأعلى، والسعر المكتوب يسبق أي قاعدة — لن يُقرأ هذا التجاوز حتى يُفرَّغ ذلك الحقل.',
                    'A member price is typed for this product above, and a typed price beats every rule — this override is not reached until that field is cleared.'
                  )}
                </Banner>
              )}
              {rule && !rule.enabled && (
                <Banner kind="warn">
                  {loc(
                    'هذه القاعدة موقوفة من شاشة المزايا، فلا تُطبَّق الآن مهما كانت قيمها.',
                    'This rule is switched off on the benefits screen, so none of its values apply right now.'
                  )}
                </Banner>
              )}
              {rule && (rule.valid_from || rule.valid_until) && (
                <Banner kind="warn">
                  {loc('تسري ضمن نافذة زمنية فقط', 'It applies only inside a time window')}:{' '}
                  {/* The two instants are a LEFT-TO-RIGHT pair. Left in the RTL
                      run, the arrow lands between the wrong two dates. */}
                  <span dir="ltr" className="inline-block">
                    {fmtDateTime(rule.valid_from)} → {fmtDateTime(rule.valid_until)}
                  </span>
                </Banner>
              )}
              {rule && rule.min_subtotal_iqd !== null && (
                <Banner kind="warn">
                  {loc('مشروطة بحد أدنى للطلب', 'Conditional on a minimum order')}:{' '}
                  {fmtValue(schema, 'min_subtotal_iqd', rule.min_subtotal_iqd, loc)}
                </Banner>
              )}
              {others > 0 && (
                <Banner kind="warn">
                  {loc(
                    'لهذا المنتج أكثر من تجاوز لهذه العضوية. المعروض هنا هو الذي يسبق غيره؛ البقية تُدار من شاشة المزايا.',
                    'This product carries more than one override for this membership. The one shown here is the one that wins; the rest are managed on the benefits screen.'
                  )}
                </Banner>
              )}
              {rule && f.discount_mode === '' && (
                <Banner kind="warn">
                  {loc(
                    'إفراغ نوع الخصم لا يحذف القاعدة — استخدم «إزالة» لرفع التجاوز عن هذا المنتج.',
                    'Emptying the discount kind does not delete the rule — use “Clear” to lift the override off this product.'
                  )}
                </Banner>
              )}
              {noteUnknown && (
                <Banner kind="warn">
                  {loc(
                    'تعذّرت قراءة ملاحظة هذه القاعدة، والحفظ من هنا سيمسحها — عدّلها من شاشة المزايا إن كانت تهمّك.',
                    'This rule’s note could not be read, and saving from here would clear it — edit it on the benefits screen if it matters.'
                  )}
                </Banner>
              )}

              <Grid cols={3}>
                <Field ar={label('discount_mode').ar} en={label('discount_mode').en} htmlFor={fid('discount_mode')}>
                  <Select
                    id={fid('discount_mode')}
                    value={f.discount_mode}
                    disabled={locked || working}
                    onChange={(e) => set(tier, { discount_mode: e.target.value as '' | DiscountMode })}
                  >
                    <option value="">{loc('بلا تجاوز', 'No override')}</option>
                    {(schema?.discount_modes ?? []).map((m) => (
                      <option key={m} value={m}>
                        {phrase(MODE_LABEL[m], loc, m)}
                      </option>
                    ))}
                  </Select>
                </Field>

                {f.discount_mode === 'percent' && (
                  <Field ar={label('percent').ar} en={label('percent').en} htmlFor={fid('percent')}>
                    <Money
                      id={fid('percent')}
                      value={f.percent}
                      disabled={locked || working}
                      placeholder={loc('مطلوب', 'required')}
                      onChange={(v) => set(tier, { percent: v })}
                    />
                  </Field>
                )}
                {f.discount_mode === 'fixed' && (
                  <Field ar={label('fixed_iqd').ar} en={label('fixed_iqd').en} htmlFor={fid('fixed_iqd')}>
                    <Money
                      id={fid('fixed_iqd')}
                      value={f.fixed_iqd}
                      disabled={locked || working}
                      placeholder={loc('مطلوب', 'required')}
                      onChange={(v) => set(tier, { fixed_iqd: v })}
                    />
                  </Field>
                )}

                <Field
                  ar={label('max_discount_iqd').ar}
                  en={label('max_discount_iqd').en}
                  htmlFor={fid('max_discount_iqd')}
                  hint={loc('اتركه فارغًا: بلا سقف', 'Empty: no ceiling')}
                >
                  <Money
                    id={fid('max_discount_iqd')}
                    value={f.max_discount_iqd}
                    disabled={locked || working}
                    placeholder={loc('بلا سقف', 'no ceiling')}
                    onChange={(v) => set(tier, { max_discount_iqd: v })}
                  />
                </Field>

                <Field ar={label('cap_scope').ar} en={label('cap_scope').en} htmlFor={fid('cap_scope')}>
                  <Select
                    id={fid('cap_scope')}
                    value={f.cap_scope}
                    disabled={locked || working}
                    onChange={(e) => set(tier, { cap_scope: e.target.value as '' | CapScope })}
                  >
                    <option value="">{loc('بلا سقف', 'No ceiling')}</option>
                    {(schema?.cap_scopes ?? []).map((cs) => (
                      <option key={cs} value={cs}>
                        {phrase(CAP_LABEL[cs], loc, cs)}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  ar={label('max_quantity').ar}
                  en={label('max_quantity').en}
                  htmlFor={fid('max_quantity')}
                  hint={loc('اتركه فارغًا: كل الكمية', 'Empty: every unit')}
                >
                  <Money
                    id={fid('max_quantity')}
                    value={f.max_quantity}
                    disabled={locked || working}
                    placeholder={loc('كل الكمية', 'every unit')}
                    onChange={(v) => set(tier, { max_quantity: v })}
                  />
                </Field>
              </Grid>

              {rowError[tier] && <div className="mt-2"><Banner kind="error">{rowError[tier]}</Banner></div>}
              {rowOk[tier] && <div className="mt-2"><Banner kind="ok">{rowOk[tier]}</Banner></div>}

              <div className="mt-2 flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  data-mb-action="save"
                  className={`${btnPrimary} h-9`}
                  disabled={locked || working || !dirty}
                  onClick={() => void save(tier)}
                >
                  {working ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {rule ? loc('حفظ التجاوز', 'Save override') : loc('ضبط التجاوز', 'Set override')}
                </button>
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">
                  {dirty
                    ? loc('تغييرات غير محفوظة — يُحفظ هنا مستقلًا عن المنتج', 'Unsaved — this saves on its own, not with the product')
                    : loc('يُحفظ هنا مستقلًا عن المنتج', 'This saves on its own, not with the product')}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
