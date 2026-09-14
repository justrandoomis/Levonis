/**
 * ONE RULE, EVERY FIELD IT HAS — and nothing it does not.
 *
 * A benefit rule is three different shapes wearing one table: a product
 * discount has a percentage and ceilings, a free-delivery rule has a threshold
 * and a list of methods, and a tax exemption has one switch. Showing all of it
 * at once and greying out two thirds would make the owner read the disabled
 * fields to find out which third is theirs — so the fields that do not belong
 * to the chosen benefit type are NOT RENDERED (§6).
 *
 * The one exception is «الحد الأدنى للطلب»: the door stores it whatever the
 * benefit type is, and `selectRule` honours it for all three, so a rule that
 * already carries one keeps the field visible even where the type would hide
 * it. A value that is silently dropped on the next save is worse than a field
 * in an unexpected place.
 *
 * EVERY REFUSAL IS THE SERVER'S OWN SENTENCE. `Dialog` shows what `onSave`
 * throws, and the admin door answers in sentences on purpose — "PLUS has no
 * shopping-benefit entitlement, so a PLUS rule would never apply", "Say whether
 * the ceiling is per unit or per order". Nothing here pre-empts, rewords or
 * swallows them.
 */
import { useMemo, useState } from 'react';
import * as T from '../adminProducts/theme';
import ProductPicker from '../adminProducts/form/ProductPicker';
import { api } from '../../lib/api';
import { Check, Dialog, FieldRow, useLoc, type CatalogNode } from '../adminTaxonomy/shared';
import {
  CAP_LABEL,
  FIELD_LABEL,
  MODE_LABEL,
  SCOPE_LABEL,
  TYPE_LABEL,
  fromLocalInput,
  numOrNull,
  phrase,
  textareaCls,
  tierName,
  toLocalInput,
  unitOf,
  unitWord,
  type BenefitRule,
  type BenefitSchema,
  type BenefitScope,
  type BenefitType,
  type CapScope,
  type DiscountMode,
} from './shared';

interface Form {
  tier: string;
  benefit_type: BenefitType;
  scope: BenefitScope;
  category_id: string;
  sub_category_id: string;
  product_id: string;
  discount_mode: '' | DiscountMode;
  percent: string;
  fixed_iqd: string;
  max_discount_iqd: string;
  cap_scope: '' | CapScope;
  max_quantity: string;
  min_subtotal_iqd: string;
  free_shipping_threshold_iqd: string;
  all_methods: boolean;
  shipping_methods: string[];
  max_shipping_subsidy_iqd: string;
  cod_tax_exempt: boolean;
  enabled: boolean;
  priority: string;
  valid_from: string;
  valid_until: string;
  label: string;
  notes: string;
}

/** Every field of the form whose value is a number typed into a text box. */
type NumberField =
  | 'percent'
  | 'fixed_iqd'
  | 'max_discount_iqd'
  | 'max_quantity'
  | 'min_subtotal_iqd'
  | 'free_shipping_threshold_iqd'
  | 'max_shipping_subsidy_iqd'
  | 'priority';

const str = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));

function formFrom(rule: BenefitRule | null, schema: BenefitSchema, notes: string): Form {
  if (!rule) {
    return {
      tier: schema.tiers[0] ?? 'pro',
      benefit_type: schema.benefit_types[0] ?? 'product_discount',
      scope: schema.scopes[0] ?? 'global',
      category_id: '',
      sub_category_id: '',
      product_id: '',
      discount_mode: '',
      percent: '',
      fixed_iqd: '',
      max_discount_iqd: '',
      cap_scope: '',
      max_quantity: '',
      min_subtotal_iqd: '',
      free_shipping_threshold_iqd: '',
      all_methods: true,
      shipping_methods: [],
      max_shipping_subsidy_iqd: '',
      cod_tax_exempt: false,
      enabled: true,
      priority: '0',
      valid_from: '',
      valid_until: '',
      label: '',
      notes: '',
    };
  }
  return {
    tier: rule.tier,
    benefit_type: rule.benefit_type,
    scope: rule.scope,
    category_id: rule.category_id ?? '',
    sub_category_id: rule.sub_category_id ?? '',
    product_id: rule.product_id ?? '',
    discount_mode: rule.discount_mode ?? '',
    percent: str(rule.percent),
    fixed_iqd: str(rule.fixed_iqd),
    max_discount_iqd: str(rule.max_discount_iqd),
    cap_scope: rule.cap_scope ?? '',
    max_quantity: str(rule.max_quantity),
    min_subtotal_iqd: str(rule.min_subtotal_iqd),
    free_shipping_threshold_iqd: str(rule.free_shipping_threshold_iqd),
    all_methods: rule.shipping_methods === null,
    shipping_methods: rule.shipping_methods ?? [],
    max_shipping_subsidy_iqd: str(rule.max_shipping_subsidy_iqd),
    cod_tax_exempt: rule.cod_tax_exempt === true,
    enabled: rule.enabled,
    priority: String(rule.priority ?? 0),
    valid_from: toLocalInput(rule.valid_from),
    valid_until: toLocalInput(rule.valid_until),
    label: rule.label ?? '',
    notes,
  };
}

interface Props {
  rule: BenefitRule | null;
  schema: BenefitSchema;
  catalogs: CatalogNode[];
  /** Recovered from the version history — see `notesFromVersions`. */
  notes: string;
  notesKnown: boolean;
  onClose: () => void;
  onSaved: (created: boolean, title: string) => Promise<void>;
}

export default function RuleDialog({ rule, schema, catalogs, notes, notesKnown, onClose, onSaved }: Props) {
  const { loc, lang } = useLoc();
  const [form, setForm] = useState<Form>(() => formFrom(rule, schema, notes));
  const initial = useMemo(() => JSON.stringify(formFrom(rule, schema, notes)), [rule, schema, notes]);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const isDiscount = form.benefit_type === 'product_discount';
  const isShipping = form.benefit_type === 'free_shipping';
  const isCod = form.benefit_type === 'cod_tax_exemption';
  // The door writes `min_subtotal_iqd` whatever the type is, so a rule that
  // already carries one keeps the field rather than losing it on save.
  const showMinSubtotal = isDiscount || form.min_subtotal_iqd.trim() !== '';

  const name = (node: CatalogNode) =>
    (lang === 'en' ? node.name_en || node.name_ar : node.name_ar || node.name_en) || node.slug;
  const roots = useMemo(
    () => catalogs.filter((c) => !c.parent_id && (c.active || c.id === form.category_id)),
    [catalogs, form.category_id]
  );
  const children = useMemo(
    () => catalogs.filter((c) => c.parent_id === form.category_id && (c.active || c.id === form.sub_category_id)),
    [catalogs, form.category_id, form.sub_category_id]
  );

  /**
   * The tiers the door offers, plus this rule's own if the schema no longer
   * lists it — a stored `plus` rule would otherwise open with an empty select
   * and look like it had lost its tier. Saving it still refuses, in the door's
   * own words, which is the point.
   */
  const tierOptions = useMemo(
    () => (schema.tiers.includes(form.tier) ? schema.tiers : [...schema.tiers, form.tier]),
    [schema.tiers, form.tier]
  );

  /** A field's label with the unit the SERVER says it is in. */
  const numLabel = (field: string) => {
    const word = unitWord(unitOf(schema, field), loc);
    const base = phrase(FIELD_LABEL[field], loc, field);
    return word ? `${base} (${word})` : base;
  };

  /**
   * THE BOX STATES NO RANGE. Every bound a value has — 1 to 100 for a
   * percentage, the dinar ceiling, the priority window — belongs to the admin
   * door, which already owns them and answers in a sentence when one is
   * broken. Repeating them here would put two authorities on the same number
   * and let the browser refuse a value the server would have accepted, or the
   * other way round, with nothing on screen to say which was right. `min` is
   * the one exception: it only stops a spinner walking a quantity below one.
   */
  const numberInput = (field: NumberField, value: string, min?: number) => (
    <input
      id={`mb-${field}`}
      type="number"
      inputMode="numeric"
      dir="ltr"
      min={min}
      value={value}
      onChange={(e) => set(field, e.target.value)}
      className={`${T.input} w-full`}
      data-mb-field={field}
    />
  );

  const save = async () => {
    const body = {
      tier: form.tier,
      benefit_type: form.benefit_type,
      scope: form.scope,
      category_id: form.category_id || null,
      sub_category_id: form.sub_category_id || null,
      product_id: form.product_id || null,
      discount_mode: form.discount_mode || null,
      percent: numOrNull(form.percent),
      fixed_iqd: numOrNull(form.fixed_iqd),
      max_discount_iqd: numOrNull(form.max_discount_iqd),
      cap_scope: form.cap_scope || null,
      max_quantity: numOrNull(form.max_quantity),
      min_subtotal_iqd: numOrNull(form.min_subtotal_iqd),
      free_shipping_threshold_iqd: numOrNull(form.free_shipping_threshold_iqd),
      // An empty list is refused by the door; "every method" is the ABSENT
      // list, which is what the checkbox above the boxes sends.
      shipping_methods: form.all_methods ? null : form.shipping_methods,
      max_shipping_subsidy_iqd: numOrNull(form.max_shipping_subsidy_iqd),
      cod_tax_exempt: form.cod_tax_exempt,
      enabled: form.enabled,
      priority: numOrNull(form.priority) ?? 0,
      valid_from: fromLocalInput(form.valid_from),
      valid_until: fromLocalInput(form.valid_until),
      label: form.label.trim() || null,
      notes: form.notes.trim() || null,
    };
    if (rule) await api.put(`/api/admin/membership-benefits/${encodeURIComponent(rule.id)}`, body);
    else await api.post('/api/admin/membership-benefits', body);
    const title = form.label.trim() || `${tierName(form.tier)} · ${phrase(TYPE_LABEL[form.benefit_type], loc)}`;
    await onSaved(!rule, title);
  };

  return (
    <Dialog
      titleAr={rule ? 'تعديل قاعدة مزايا' : 'قاعدة مزايا جديدة'}
      titleEn={rule ? 'Edit benefit rule' : 'New benefit rule'}
      onClose={onClose}
      onSave={save}
      wide
      dirty={JSON.stringify(form) !== initial}
      testId="benefit-rule"
    >
      {/* ------------------------------------------------ who, what, where */}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FieldRow id="mb-tier" label={phrase(FIELD_LABEL.tier, loc)} required>
          <select
            id="mb-tier"
            className={`${T.select} w-full px-3`}
            value={form.tier}
            onChange={(e) => set('tier', e.target.value)}
            data-mb-field="tier"
          >
            {tierOptions.map((t) => (
              <option key={t} value={t}>
                {tierName(t)}
              </option>
            ))}
          </select>
        </FieldRow>

        <FieldRow id="mb-type" label={phrase(FIELD_LABEL.benefit_type, loc)} required>
          <select
            id="mb-type"
            className={`${T.select} w-full px-3`}
            value={form.benefit_type}
            onChange={(e) => set('benefit_type', e.target.value as BenefitType)}
            data-mb-field="benefit_type"
          >
            {schema.benefit_types.map((t) => (
              <option key={t} value={t}>
                {phrase(TYPE_LABEL[t], loc, t)}
              </option>
            ))}
          </select>
        </FieldRow>

        <FieldRow
          id="mb-scope"
          label={phrase(FIELD_LABEL.scope, loc)}
          required
          hint={loc(
            'الأكثر تحديدًا يفوز: منتج ثم قسم فرعي ثم قسم رئيسي ثم الكل. قاعدة على قسم تشمل كل ما تحته.',
            'The most specific wins: product, then sub-section, then main section, then everything. A section rule covers its whole branch.'
          )}
        >
          <select
            id="mb-scope"
            className={`${T.select} w-full px-3`}
            value={form.scope}
            onChange={(e) => set('scope', e.target.value as BenefitScope)}
            data-mb-field="scope"
          >
            {schema.scopes.map((s) => (
              <option key={s} value={s}>
                {phrase(SCOPE_LABEL[s], loc, s)}
              </option>
            ))}
          </select>
        </FieldRow>

        {(form.scope === 'category' || form.scope === 'sub_category') && (
          <FieldRow id="mb-category" label={phrase(FIELD_LABEL.category_id, loc)} required>
            <select
              id="mb-category"
              className={`${T.select} w-full px-3`}
              value={form.category_id}
              onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value, sub_category_id: '' }))}
              data-mb-field="category_id"
            >
              <option value="">{loc('— اختر —', '— choose —')}</option>
              {roots.map((c) => (
                <option key={c.id} value={c.id}>
                  {name(c)}
                </option>
              ))}
            </select>
          </FieldRow>
        )}

        {form.scope === 'sub_category' && (
          <FieldRow
            id="mb-sub-category"
            label={phrase(FIELD_LABEL.sub_category_id, loc)}
            required
            hint={form.category_id ? undefined : loc('اختر القسم الرئيسي أولًا', 'Choose the main section first')}
          >
            <select
              id="mb-sub-category"
              className={`${T.select} w-full px-3`}
              value={form.sub_category_id}
              disabled={!form.category_id || children.length === 0}
              onChange={(e) => set('sub_category_id', e.target.value)}
              data-mb-field="sub_category_id"
            >
              <option value="">{loc('— اختر —', '— choose —')}</option>
              {children.map((c) => (
                <option key={c.id} value={c.id}>
                  {name(c)}
                </option>
              ))}
            </select>
          </FieldRow>
        )}

        {form.scope === 'product' && (
          <FieldRow
            id="mb-product"
            label={phrase(FIELD_LABEL.product_id, loc)}
            required
            hint={form.product_id || undefined}
          >
            <ProductPicker
              value={form.product_id}
              excludeComposition={false}
              ariaLabel={loc('اختر منتجًا', 'Choose a product', 'بەرهەمێک هەڵبژێرە')}
              onChange={(id) => set('product_id', id)}
            />
          </FieldRow>
        )}
      </div>

      {/* --------------------------------------------- the money, per type */}
      {isDiscount && (
        <div className="grid gap-3.5 sm:grid-cols-2">
          <FieldRow id="mb-mode" label={phrase(FIELD_LABEL.discount_mode, loc)} required>
            <select
              id="mb-mode"
              className={`${T.select} w-full px-3`}
              value={form.discount_mode}
              onChange={(e) => set('discount_mode', e.target.value as '' | DiscountMode)}
              data-mb-field="discount_mode"
            >
              <option value="">{loc('— اختر —', '— choose —')}</option>
              {schema.discount_modes.map((m) => (
                <option key={m} value={m}>
                  {phrase(MODE_LABEL[m], loc, m)}
                </option>
              ))}
            </select>
          </FieldRow>

          {form.discount_mode === 'percent' && (
            <FieldRow id="mb-percent" label={numLabel('percent')} required>
              {numberInput('percent', form.percent, 1)}
            </FieldRow>
          )}
          {form.discount_mode === 'fixed' && (
            <FieldRow id="mb-fixed_iqd" label={numLabel('fixed_iqd')} required>
              {numberInput('fixed_iqd', form.fixed_iqd, 0)}
            </FieldRow>
          )}

          <FieldRow
            id="mb-max_discount_iqd"
            label={numLabel('max_discount_iqd')}
            hint={loc('اتركه فارغًا لبلا سقف.', 'Leave empty for no ceiling.')}
          >
            {numberInput('max_discount_iqd', form.max_discount_iqd, 0)}
          </FieldRow>

          <FieldRow
            id="mb-cap_scope"
            label={phrase(FIELD_LABEL.cap_scope, loc)}
            hint={loc(
              'سقف لكل وحدة يُحتسب قبل الكمية: طابعتان توفّران ضعف السقف. سقف لكل طلب يُطبّق مرة واحدة على السطر.',
              'A per-unit ceiling counts before quantity: two printers save twice it. A per-order ceiling is applied once, on the line.'
            )}
          >
            <select
              id="mb-cap_scope"
              className={`${T.select} w-full px-3`}
              value={form.cap_scope}
              onChange={(e) => set('cap_scope', e.target.value as '' | CapScope)}
              data-mb-field="cap_scope"
            >
              <option value="">{loc('— بلا سقف —', '— no ceiling —')}</option>
              {schema.cap_scopes.map((c) => (
                <option key={c} value={c}>
                  {phrase(CAP_LABEL[c], loc, c)}
                </option>
              ))}
            </select>
          </FieldRow>

          <FieldRow
            id="mb-max_quantity"
            label={numLabel('max_quantity')}
            hint={loc(
              'الكمية المشمولة بالخصم في الطلب الواحد؛ ما زاد عنها بالسعر العادي.',
              'How many units of the order the discount covers; the rest are at the regular price.'
            )}
          >
            {numberInput('max_quantity', form.max_quantity, 1)}
          </FieldRow>
        </div>
      )}

      {isShipping && (
        <div className="grid gap-3.5 sm:grid-cols-2">
          <FieldRow
            id="mb-free_shipping_threshold_iqd"
            label={numLabel('free_shipping_threshold_iqd')}
            hint={loc(
              'المقارنة «أكثر من» تمامًا، على قيمة البضاعة بعد الخصومات وقبل التوصيل والضريبة.',
              'Compared strictly greater than, against the merchandise after discounts and before delivery and the tax.'
            )}
          >
            {numberInput('free_shipping_threshold_iqd', form.free_shipping_threshold_iqd, 0)}
          </FieldRow>

          <FieldRow
            id="mb-max_shipping_subsidy_iqd"
            label={numLabel('max_shipping_subsidy_iqd')}
            hint={loc(
              'بلا سقف يكون التوصيل مجانيًا. مع سقف أقل من الأجرة يدفع العضو الفرق، ولا يُقال عن التوصيل إنه مجاني.',
              'With no ceiling the delivery is free. With a ceiling below the fee the member pays the difference, and nothing claims the delivery was free.'
            )}
          >
            {numberInput('max_shipping_subsidy_iqd', form.max_shipping_subsidy_iqd, 0)}
          </FieldRow>

          <div className="sm:col-span-2 grid gap-2">
            <Check
              id="mb-all-methods"
              label={loc('كل طرق التوصيل مشمولة', 'Every delivery method is covered')}
              checked={form.all_methods}
              onChange={(v) => set('all_methods', v)}
              hint={loc(
                'أزل العلامة لتحديد الطرق المشمولة بالإعفاء.',
                'Clear it to name the methods the waiver covers.'
              )}
            />
            {!form.all_methods && (
              <div className="grid gap-2 ps-6 sm:grid-cols-2" data-mb-field="shipping_methods">
                {schema.delivery_methods.map((m) => (
                  <Check
                    key={m.id}
                    id={`mb-method-${m.id}`}
                    label={loc(m.title_ar || m.id, m.title_en || m.id)}
                    checked={form.shipping_methods.includes(m.id)}
                    onChange={(v) =>
                      set(
                        'shipping_methods',
                        v ? [...form.shipping_methods, m.id] : form.shipping_methods.filter((x) => x !== m.id)
                      )
                    }
                  />
                ))}
                {schema.delivery_methods.length === 0 && (
                  <p className="text-[11.5px] text-[var(--ap-text-3)]">
                    {loc('لا توجد طرق توصيل مُعرّفة في إعدادات المتجر.', 'No delivery method is configured in the store settings.')}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {isCod && (
        <Check
          id="mb-cod_tax_exempt"
          label={phrase(FIELD_LABEL.cod_tax_exempt, loc)}
          checked={form.cod_tax_exempt}
          onChange={(v) => set('cod_tax_exempt', v)}
          hint={loc(
            'الضريبة تُحتسب كاملة على كل طلب ثم تُعفى هنا؛ بلا علامة تبقى محسوبة ويدفعها العضو.',
            'The tax is calculated in full on every order and waived here; left unchecked it stays calculated and the member pays it.'
          )}
        />
      )}

      {showMinSubtotal && (
        <FieldRow
          id="mb-min_subtotal_iqd"
          label={numLabel('min_subtotal_iqd')}
          hint={loc(
            'لا تُطبّق القاعدة تحت هذا المبلغ، ولا تظهر على صفحة المنتج لأن قيمة الطلب غير معروفة هناك.',
            'The rule does not apply below this amount, and does not show on a product page, where the order value is not yet known.'
          )}
        >
          {numberInput('min_subtotal_iqd', form.min_subtotal_iqd, 0)}
        </FieldRow>
      )}

      {/* ------------------------------------------------- when, and how loud */}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FieldRow
          id="mb-valid_from"
          label={phrase(FIELD_LABEL.valid_from, loc)}
          hint={loc('اتركه فارغًا ليسري فورًا.', 'Leave empty to run from now.')}
        >
          <input
            id="mb-valid_from"
            type="datetime-local"
            dir="ltr"
            value={form.valid_from}
            onChange={(e) => set('valid_from', e.target.value)}
            className={`${T.input} w-full`}
            data-mb-field="valid_from"
          />
        </FieldRow>
        <FieldRow
          id="mb-valid_until"
          label={phrase(FIELD_LABEL.valid_until, loc)}
          hint={loc('اتركه فارغًا ليستمر بلا نهاية.', 'Leave empty to run with no end.')}
        >
          <input
            id="mb-valid_until"
            type="datetime-local"
            dir="ltr"
            value={form.valid_until}
            onChange={(e) => set('valid_until', e.target.value)}
            className={`${T.input} w-full`}
            data-mb-field="valid_until"
          />
        </FieldRow>

        <FieldRow
          id="mb-priority"
          label={phrase(FIELD_LABEL.priority, loc)}
          hint={loc(
            'يفصل بين قاعدتين على المستوى نفسه فقط؛ لا يتجاوز التحديد أبدًا.',
            'Breaks a tie between two rules at the same level only; it never crosses specificity.'
          )}
        >
          {numberInput('priority', form.priority)}
        </FieldRow>

        <FieldRow id="mb-label" label={phrase(FIELD_LABEL.label, loc)}>
          <input
            id="mb-label"
            type="text"
            maxLength={120}
            value={form.label}
            onChange={(e) => set('label', e.target.value)}
            className={`${T.input} w-full`}
            data-mb-field="label"
          />
        </FieldRow>
      </div>

      <Check
        id="mb-enabled"
        label={loc('مفعّلة', 'Active', 'چالاک')}
        checked={form.enabled}
        onChange={(v) => set('enabled', v)}
        hint={loc('القاعدة المعطّلة تبقى محفوظة ولا تُطبّق على أي طلب.', 'A disabled rule stays saved and applies to no order.')}
      />

      <FieldRow
        id="mb-notes"
        label={phrase(FIELD_LABEL.notes, loc)}
        hint={
          rule && !notesKnown
            ? loc(
                'لا يُعيد الخادم الملاحظة مع القاعدة، ولم تُعثر عليها في سجل النسخ المعروض. الحفظ يكتب ما في هذا الصندوق.',
                'The server does not return the note with the rule, and it was not found in the version window shown here. Saving writes whatever is in this box.'
              )
            : loc('لا تظهر لأي عميل.', 'Never shown to a customer.')
        }
      >
        <textarea
          id="mb-notes"
          rows={3}
          maxLength={2000}
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          className={textareaCls}
          data-mb-field="notes"
        />
      </FieldRow>
    </Dialog>
  );
}
