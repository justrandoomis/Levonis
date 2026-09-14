/**
 * EVERY RULE, GROUPED BY TIER AND BY BENEFIT, WITH ITS UNITS.
 *
 * The screen the owner comes to in order to answer one question — "what is a
 * PRO membership worth right now?" — so the rules are laid out the way that
 * question is asked: PREMIUM and PRO, and inside each, the discount, the
 * delivery and the tax. A tier with no rule of a kind says so in a line,
 * because "PRO has no product discount configured" is an ANSWER, and an empty
 * screen is not.
 *
 * NO NUMBER IS PRINTED BARE. «10%», «100,000 د.ع», «2 وحدات» — the unit comes
 * from `schema.units`, never from this file's opinion about which field is a
 * percentage.
 */
import { useMemo, useRef, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api } from '../../lib/api';
import {
  ActiveBadge,
  Actions,
  Badge,
  Dialog,
  SearchBox,
  Table,
  Toolbar,
  cell,
  useLoc,
  type CatalogNode,
  type NoticeState,
} from '../adminTaxonomy/shared';
import RuleDialog from './RuleDialog';
import {
  CAP_LABEL,
  FIELD_LABEL,
  SCOPE_LABEL,
  TYPE_LABEL,
  catalogName,
  fmtDateTime,
  fmtValue,
  phrase,
  ruleTitle,
  tierChip,
  tierName,
  type BenefitRule,
  type BenefitSchema,
  type BenefitType,
} from './shared';

interface Props {
  rules: BenefitRule[];
  schema: BenefitSchema;
  catalogs: CatalogNode[];
  productNames: Map<string, string>;
  notes: Map<string, string>;
  reload: () => Promise<void>;
  notify: (tone: NoticeState['tone'], text: string) => void;
}

/** One printed value of a rule: what it is, and the number with its unit. */
interface ValueLine {
  key: string;
  label: string;
  value: string;
}

export default function RulesTab({ rules, schema, catalogs, productNames, notes, reload, notify }: Props) {
  const { loc, lang } = useLoc();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<BenefitRule | null | 'new'>(null);
  const [del, setDel] = useState<BenefitRule | null>(null);
  // The deleted row takes the button the dialog would restore focus to with
  // it, so the "new rule" button is where focus lands instead of the body.
  const addRef = useRef<HTMLButtonElement>(null);

  /** The section, sub-section or product a rule names, in words. */
  const targetOf = (rule: BenefitRule): string | null => {
    if (rule.scope === 'product') return rule.product_id ? productNames.get(rule.product_id) ?? rule.product_id : null;
    if (rule.scope === 'sub_category') return catalogName(catalogs, rule.sub_category_id, lang) ?? rule.sub_category_id;
    if (rule.scope === 'category') return catalogName(catalogs, rule.category_id, lang) ?? rule.category_id;
    return null;
  };

  const methodName = (id: string) => {
    const m = schema.delivery_methods.find((x) => x.id === id);
    return m ? loc(m.title_ar || m.id, m.title_en || m.id) : id;
  };

  /** What this rule is worth, field by field, each with the server's unit. */
  const valuesOf = (rule: BenefitRule): ValueLine[] => {
    const out: ValueLine[] = [];
    const push = (key: string, value: string) =>
      out.push({ key, label: phrase(FIELD_LABEL[key], loc, key), value });

    if (rule.benefit_type === 'product_discount') {
      if (rule.discount_mode === 'percent' && rule.percent !== null) push('percent', fmtValue(schema, 'percent', rule.percent, loc));
      if (rule.discount_mode === 'fixed' && rule.fixed_iqd !== null) push('fixed_iqd', fmtValue(schema, 'fixed_iqd', rule.fixed_iqd, loc));
      if (rule.max_discount_iqd !== null) {
        const cap = rule.cap_scope ? ` · ${phrase(CAP_LABEL[rule.cap_scope], loc, rule.cap_scope)}` : '';
        push('max_discount_iqd', `${fmtValue(schema, 'max_discount_iqd', rule.max_discount_iqd, loc)}${cap}`);
      }
      if (rule.max_quantity !== null) push('max_quantity', fmtValue(schema, 'max_quantity', rule.max_quantity, loc));
    }

    if (rule.benefit_type === 'free_shipping') {
      push(
        'free_shipping_threshold_iqd',
        rule.free_shipping_threshold_iqd === null
          ? loc('أي مبلغ', 'Any amount')
          : fmtValue(schema, 'free_shipping_threshold_iqd', rule.free_shipping_threshold_iqd, loc)
      );
      push(
        'shipping_methods',
        rule.shipping_methods === null
          ? loc('كل الطرق', 'Every method')
          : rule.shipping_methods.map(methodName).join(' · ') || loc('لا شيء', 'None')
      );
      if (rule.max_shipping_subsidy_iqd !== null) {
        push('max_shipping_subsidy_iqd', fmtValue(schema, 'max_shipping_subsidy_iqd', rule.max_shipping_subsidy_iqd, loc));
      }
    }

    if (rule.benefit_type === 'cod_tax_exemption') {
      push('cod_tax_exempt', rule.cod_tax_exempt ? loc('معفى', 'Exempt') : loc('غير معفى', 'Not exempt'));
    }

    // Stored for every benefit type and honoured by the selector for every one
    // of them, so it is printed wherever it is set.
    if (rule.min_subtotal_iqd !== null) {
      push('min_subtotal_iqd', `${loc('من', 'from')} ${fmtValue(schema, 'min_subtotal_iqd', rule.min_subtotal_iqd, loc)}`);
    }
    return out;
  };

  const matches = (rule: BenefitRule): boolean => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return [rule.id, rule.label ?? '', targetOf(rule) ?? '', tierName(rule.tier), phrase(TYPE_LABEL[rule.benefit_type], loc)]
      .join(' ')
      .toLowerCase()
      .includes(s);
  };

  /** Schema order first, then anything stored that the schema no longer
   *  offers — a rule nobody can see is a rule nobody can fix. */
  const tiers = useMemo(() => {
    const out = [...schema.tiers];
    for (const r of rules) if (!out.includes(r.tier)) out.push(r.tier);
    return out;
  }, [schema.tiers, rules]);
  const types = useMemo(() => {
    const out: BenefitType[] = [...schema.benefit_types];
    for (const r of rules) if (!out.includes(r.benefit_type)) out.push(r.benefit_type);
    return out;
  }, [schema.benefit_types, rules]);

  const visible = rules.filter(matches);

  const remove = async (rule: BenefitRule) => {
    await api.delete(`/api/admin/membership-benefits/${encodeURIComponent(rule.id)}`);
    // Reload BEFORE closing: a reload that fails leaves the dialog open with
    // the reason on it, rather than a closed dialog over a stale list.
    await reload();
    setDel(null);
    window.setTimeout(() => addRef.current?.focus(), 0);
    notify(
      'ok',
      loc(
        `حُذفت القاعدة «${ruleTitle(rule, loc, targetOf(rule))}». الطلبات السابقة لا تتغير.`,
        `Rule "${ruleTitle(rule, loc, targetOf(rule))}" deleted. Orders already placed are unchanged.`
      )
    );
  };

  return (
    <div className="space-y-5" data-mb-panel="rules">
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder={loc('بحث في القواعد…', 'Search rules…')} testId="benefits" />
        <div className="ms-auto">
          <button ref={addRef} type="button" className={T.btnPrimary} onClick={() => setEdit('new')} data-mb-add>
            <Plus className="w-4 h-4" aria-hidden />
            {loc('قاعدة جديدة', 'New rule')}
          </button>
        </div>
      </Toolbar>

      {tiers.map((tier) => {
        const mine = visible.filter((r) => r.tier === tier);
        return (
          <section key={tier} className="space-y-3" data-mb-tier={tier}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`${T.badgeBase} ${tierChip(tier)}`}>{tierName(tier)}</span>
              <span className="text-[11.5px] text-[var(--ap-text-3)]">
                {loc(`${mine.length} قاعدة`, `${mine.length} rules`)}
              </span>
            </div>

            {types.map((type) => {
              const group = mine.filter((r) => r.benefit_type === type);
              const typeLabel = phrase(TYPE_LABEL[type], loc, type);
              if (group.length === 0) {
                return (
                  <p
                    key={type}
                    className="text-[12px] text-[var(--ap-text-3)] ps-1"
                    data-mb-group={`${tier}:${type}`}
                  >
                    {typeLabel} — {loc('لا توجد قاعدة مضبوطة', 'no rule configured')}
                  </p>
                );
              }
              return (
                <div key={type} className="space-y-1.5" data-mb-group={`${tier}:${type}`}>
                  <h3 className="text-[12.5px] font-semibold text-[var(--ap-text-2)] ps-1">{typeLabel}</h3>
                  <Table
                    head={[
                      loc('القاعدة', 'Rule'),
                      loc('القيم', 'Values'),
                      phrase(FIELD_LABEL.scope, loc),
                      phrase(FIELD_LABEL.priority, loc),
                      loc('المدة', 'Window'),
                      loc('الحالة', 'State', 'دۆخ'),
                      '',
                    ]}
                    minWidth={880}
                  >
                    {group.map((rule) => {
                      const target = targetOf(rule);
                      const values = valuesOf(rule);
                      return (
                        <tr
                          key={rule.id}
                          className={`${T.tableRow} ${rule.enabled ? '' : 'opacity-60'}`}
                          data-mb-rule={rule.id}
                        >
                          <td className={cell}>
                            <div className="font-semibold text-[var(--ap-text-1)]">{ruleTitle(rule, loc, target)}</div>
                            <div className="font-mono text-[11px] text-[var(--ap-text-3)]" dir="ltr">
                              {rule.id}
                            </div>
                          </td>
                          <td className={cell}>
                            {values.length === 0 ? (
                              <span className="text-[var(--ap-text-3)]">—</span>
                            ) : (
                              <ul className="space-y-0.5">
                                {values.map((v) => (
                                  <li key={v.key} className="flex flex-wrap items-baseline gap-x-1.5">
                                    <span className="text-[11.5px] text-[var(--ap-text-3)]">{v.label}</span>
                                    <span
                                      className="text-[13px] font-semibold text-[var(--ap-text-1)] tabular-nums"
                                      data-mb-value={v.key}
                                    >
                                      {v.value}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                          <td className={cell}>
                            <div>{phrase(SCOPE_LABEL[rule.scope], loc, rule.scope)}</div>
                            {target && <div className="text-[11.5px] text-[var(--ap-text-3)]">{target}</div>}
                          </td>
                          <td className={`${cell} tabular-nums`}>{rule.priority}</td>
                          <td className={`${cell} text-[11.5px] text-[var(--ap-text-3)] whitespace-nowrap`}>
                            {rule.valid_from || rule.valid_until ? (
                              <>
                                <div>
                                  {phrase(FIELD_LABEL.valid_from, loc)} {fmtDateTime(rule.valid_from)}
                                </div>
                                <div>
                                  {phrase(FIELD_LABEL.valid_until, loc)} {fmtDateTime(rule.valid_until)}
                                </div>
                              </>
                            ) : (
                              loc('بلا حدود', 'No window')
                            )}
                          </td>
                          <td className={cell}>
                            <ActiveBadge active={rule.enabled} />
                          </td>
                          <td className={cell}>
                            <Actions>
                              <button
                                type="button"
                                className={T.btnIcon}
                                onClick={() => setEdit(rule)}
                                aria-label={loc('تعديل', 'Edit', 'دەستکاری')}
                                title={loc('تعديل', 'Edit', 'دەستکاری')}
                                data-mb-action="edit"
                              >
                                <Pencil className="w-4 h-4" aria-hidden />
                              </button>
                              <button
                                type="button"
                                className={T.btnIconDanger}
                                onClick={() => setDel(rule)}
                                aria-label={loc('حذف', 'Delete', 'سڕینەوە')}
                                title={loc('حذف', 'Delete', 'سڕینەوە')}
                                data-mb-action="delete"
                              >
                                <Trash2 className="w-4 h-4" aria-hidden />
                              </button>
                            </Actions>
                          </td>
                        </tr>
                      );
                    })}
                  </Table>
                </div>
              );
            })}
          </section>
        );
      })}

      {q.trim() && visible.length === 0 && (
        <p className="text-[13px] text-[var(--ap-text-3)]">{loc('لا نتائج', 'No results', 'هیچ ئەنجامێک نییە')}</p>
      )}

      {edit && (
        <RuleDialog
          rule={edit === 'new' ? null : edit}
          schema={schema}
          catalogs={catalogs}
          notes={edit === 'new' ? '' : notes.get(edit.id) ?? ''}
          notesKnown={edit === 'new' ? true : notes.has(edit.id)}
          onClose={() => setEdit(null)}
          onSaved={async (created, title) => {
            setEdit(null);
            await reload();
            notify(
              'ok',
              created
                ? loc(`أُضيفت القاعدة «${title}».`, `Rule "${title}" added.`)
                : loc(`حُفظت القاعدة «${title}».`, `Rule "${title}" saved.`)
            );
          }}
        />
      )}

      {del && (
        <Dialog
          titleAr="حذف قاعدة مزايا"
          titleEn="Delete benefit rule"
          danger
          saveLabel={loc('حذف', 'Delete', 'سڕینەوە')}
          onClose={() => setDel(null)}
          onSave={() => remove(del)}
          testId="delete-benefit-rule"
        >
          <p className="text-[13px] text-[var(--ap-text-1)]">
            {loc(
              `حذف القاعدة «${ruleTitle(del, loc, targetOf(del))}»؟`,
              `Delete the rule "${ruleTitle(del, loc, targetOf(del))}"?`
            )}
          </p>
          <ul className="space-y-0.5">
            {valuesOf(del).map((v) => (
              <li key={v.key} className="flex flex-wrap items-baseline gap-x-1.5 text-[12.5px]">
                <span className="text-[var(--ap-text-3)]">{v.label}</span>
                <span className="font-semibold text-[var(--ap-text-1)] tabular-nums">{v.value}</span>
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-[var(--ap-text-3)]">
            {loc(
              'الطلبات السابقة لا تتغير — كل طلب يحمل نسخته الخاصة من القواعد. الطلبات الجديدة تُسعَّر بدونها.',
              'Orders already placed are unchanged — each one carries the configuration version it was priced under. New orders are priced without it.'
            )}
          </p>
          {!del.enabled && (
            <Badge tone="warn">{loc('هذه القاعدة معطّلة أصلًا', 'This rule is already disabled')}</Badge>
          )}
        </Dialog>
      )}
    </div>
  );
}
