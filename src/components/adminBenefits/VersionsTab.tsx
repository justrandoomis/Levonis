/**
 * WHO CHANGED WHAT, WHEN, AND WHAT IT WAS BEFORE.
 *
 * Every write to a rule appends a version carrying the actor, the action, and
 * the rule as it stood on both sides. This panel reads them and says the
 * difference in words: «النسبة 10% ← 15%», not two blobs of JSON side by side.
 *
 * THE TWO SIDES ARE NOT THE SAME SHAPE. `before_json` is the stored ROW
 * (`enabled` is 1, the methods are a JSON string) and `after_json` is the
 * written RULE (`enabled` is true, the methods an array) — so both are put
 * through `normalizeVersionRule` first. Without it every single edit would
 * report "enabled: 1 → true" and bury the change the owner actually made.
 */
import { useMemo } from 'react';
import * as T from '../adminProducts/theme';
import { Badge, Empty, useLoc, type CatalogNode } from '../adminTaxonomy/shared';
import {
  CAP_LABEL,
  FIELD_LABEL,
  MODE_LABEL,
  RULE_FIELDS,
  SCOPE_LABEL,
  TYPE_LABEL,
  catalogName,
  fmtDateTime,
  fmtValue,
  normalizeVersionRule,
  phrase,
  tierName,
  unitOf,
  type BenefitSchema,
  type BenefitScope,
  type BenefitType,
  type CapScope,
  type DiscountMode,
  type VersionRow,
} from './shared';

interface Props {
  versions: VersionRow[];
  schema: BenefitSchema;
  catalogs: CatalogNode[];
  productNames: Map<string, string>;
}

type Rule = Record<string, unknown>;

const EMPTY = (v: unknown) => v === null || v === undefined || v === '';

/** Two stored values are the same change-wise when they serialise the same. */
const same = (a: unknown, b: unknown) =>
  EMPTY(a) && EMPTY(b) ? true : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export default function VersionsTab({ versions, schema, catalogs, productNames }: Props) {
  const { loc, lang } = useLoc();

  const methodName = (id: string) => {
    const m = schema.delivery_methods.find((x) => x.id === id);
    return m ? loc(m.title_ar || m.id, m.title_en || m.id) : id;
  };

  /** One stored value, in words — with its unit where the server gives one. */
  const show = (field: string, value: unknown): string => {
    if (EMPTY(value)) {
      if (field === 'shipping_methods') return loc('كل الطرق', 'Every method');
      return '—';
    }
    if (field === 'tier') return tierName(String(value));
    if (field === 'benefit_type') return phrase(TYPE_LABEL[value as BenefitType], loc, String(value));
    if (field === 'scope') return phrase(SCOPE_LABEL[value as BenefitScope], loc, String(value));
    if (field === 'discount_mode') return phrase(MODE_LABEL[value as DiscountMode], loc, String(value));
    if (field === 'cap_scope') return phrase(CAP_LABEL[value as CapScope], loc, String(value));
    if (field === 'enabled') return value ? loc('مفعّلة', 'Active', 'چالاک') : loc('معطّلة', 'Inactive', 'ناچالاک');
    if (field === 'cod_tax_exempt') return value ? loc('معفى', 'Exempt') : loc('غير معفى', 'Not exempt');
    if (field === 'shipping_methods') {
      return Array.isArray(value) ? value.map((m) => methodName(String(m))).join(' · ') : String(value);
    }
    if (field === 'category_id' || field === 'sub_category_id') {
      return catalogName(catalogs, String(value), lang) ?? String(value);
    }
    if (field === 'product_id') return productNames.get(String(value)) ?? String(value);
    if (field === 'valid_from' || field === 'valid_until') return fmtDateTime(String(value));
    if (typeof value === 'number' && unitOf(schema, field)) return fmtValue(schema, field, value, loc);
    return String(value);
  };

  const rows = useMemo(
    () =>
      versions.map((v) => {
        const before = normalizeVersionRule(v.before_json) as Rule | null;
        const after = normalizeVersionRule(v.after_json) as Rule | null;
        const changes = RULE_FIELDS.filter((f) => !same(before?.[f], after?.[f])).map((f) => ({
          field: f as string,
          from: before?.[f] ?? null,
          to: after?.[f] ?? null,
        }));
        return { v, before, after, changes };
      }),
    [versions]
  );

  if (rows.length === 0) {
    return <Empty text={loc('لا توجد تغييرات مسجّلة بعد.', 'No recorded changes yet.')} />;
  }

  const ACTION: Record<string, { ar: string; en: string; tone: 'ok' | 'info' | 'bad' }> = {
    create: { ar: 'إنشاء', en: 'Created', tone: 'ok' },
    update: { ar: 'تعديل', en: 'Updated', tone: 'info' },
    delete: { ar: 'حذف', en: 'Deleted', tone: 'bad' },
    // Migration 0074 opens the history with one row of its own, carrying no
    // rule on either side — the point at which the store had a configuration
    // at all.
    seed: { ar: 'القيم الابتدائية', en: 'Initial values', tone: 'info' },
    // «تحويل إلى قاعدة قسم»: ONE row for the whole conversion. `after_json`
    // is the section rule it created (none when one already existed) and
    // `before_json` the LIST of product rules it deleted.
    consolidate: { ar: 'تحويل إلى قاعدة قسم', en: 'Converted to a section rule', tone: 'info' },
  };

  /** How many product rules a conversion row deleted (its `before_json` is a list). */
  const foldedCount = (raw: string | null): number => {
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  };

  return (
    <div className="space-y-2.5" data-mb-panel="versions">
      <p className="text-[12px] text-[var(--ap-text-3)] max-w-[70ch]">
        {loc(
          'كل تغيير على قاعدة يُسجَّل بصاحبه ووقته وحالته قبل وبعد. الطلبات لا تُعاد حسبتها أبدًا: كل طلب يحمل رقم النسخة التي سُعِّر بها.',
          'Every change to a rule is recorded with who made it, when, and what it was on both sides. No order is ever recalculated: each one carries the configuration version it was priced under.'
        )}
      </p>

      {rows.map(({ v, before, after, changes }) => {
        const action = ACTION[v.action] ?? { ar: v.action, en: v.action, tone: 'info' as const };
        const actor = v.actor_name || v.actor_email || loc('غير معروف', 'Unknown');
        // A creation has no "before" and a deletion has no "after": showing a
        // diff of one side against nothing would print the whole rule as
        // twenty arrows. The rule as it stood is the honest summary.
        const consolidated = v.action === 'consolidate';
        const snapshot = v.action === 'create' || consolidated ? after : v.action === 'delete' ? before : null;
        return (
          <article key={v.id} className={`${T.surface} p-3.5 space-y-2`} data-mb-version={v.id}>
            <header className="flex flex-wrap items-center gap-2">
              <Badge tone={action.tone}>{loc(action.ar, action.en)}</Badge>
              <span className="text-[13px] font-semibold text-[var(--ap-text-1)]">{actor}</span>
              {v.actor_email && v.actor_name && (
                <span className="text-[11.5px] text-[var(--ap-text-3)]" dir="ltr">
                  {v.actor_email}
                </span>
              )}
              <span className="text-[11.5px] text-[var(--ap-text-3)] ms-auto" dir="ltr">
                {fmtDateTime(v.created_at)}
              </span>
            </header>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-[var(--ap-text-3)]" dir="ltr">
              <span>#{v.id}</span>
              {v.rule_id && <span>{v.rule_id}</span>}
            </div>

            {consolidated && (
              <p className="text-[12.5px] text-[var(--ap-text-2)]" data-mb-version-folded>
                {loc(
                  `حُذفت ${foldedCount(v.before_json)} قاعدة منتج${after ? ' وحلّت محلها قاعدة القسم أدناه' : ' تغطيها قاعدة القسم الموجودة'}.`,
                  `${foldedCount(v.before_json)} product rules deleted${after ? ', replaced by the section rule below' : ', covered by the existing section rule'}.`
                )}
              </p>
            )}
            {consolidated && !snapshot ? null : snapshot ? (
              <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                {RULE_FIELDS.filter((f) => !EMPTY(snapshot[f])).map((f) => (
                  <li key={f} className="flex flex-wrap items-baseline gap-x-1.5 text-[12.5px]">
                    <span className="text-[var(--ap-text-3)]">{phrase(FIELD_LABEL[f], loc, f)}</span>
                    <span className="font-semibold text-[var(--ap-text-1)] tabular-nums">{show(f, snapshot[f])}</span>
                  </li>
                ))}
              </ul>
            ) : !before && !after ? (
              <p className="text-[12.5px] text-[var(--ap-text-3)]">
                {loc(
                  'بداية السجل: القواعد الأولى كما ركّبتها الهجرة، وكل رقم فيها قابل للتغيير من هذه الصفحة.',
                  'The start of the record: the first rules as the migration installed them, every number of them editable from this page.'
                )}
              </p>
            ) : changes.length === 0 ? (
              <p className="text-[12.5px] text-[var(--ap-text-3)]">
                {loc('حُفظت بلا تغيير في أي قيمة.', 'Saved with no value changed.')}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {changes.map((c) => (
                  <li key={c.field} className="flex flex-wrap items-baseline gap-x-1.5 text-[12.5px]">
                    <span className="text-[var(--ap-text-3)]">{phrase(FIELD_LABEL[c.field], loc, c.field)}</span>
                    <span className="text-[var(--ap-text-3)] line-through tabular-nums">{show(c.field, c.from)}</span>
                    {/* The arrow follows the reading direction: an RTL page
                        that drew "→" would point the change backwards. */}
                    <span aria-hidden className="text-[var(--ap-text-3)]">
                      {loc('←', '→')}
                    </span>
                    <span className="font-semibold text-[var(--ap-text-1)] tabular-nums">{show(c.field, c.to)}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        );
      })}
    </div>
  );
}
