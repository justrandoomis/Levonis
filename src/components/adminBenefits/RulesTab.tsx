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
import { Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
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
  errMsg,
  useLoc,
  type CatalogNode,
  type NoticeState,
} from '../adminTaxonomy/shared';
import RuleDialog from './RuleDialog';
import ConsolidationPanel from './ConsolidationPanel';
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

/** One suggestion from GET /recommended, as the confirmation lists it. */
interface RecommendedEntry {
  key: string;
  category_name_ar: string;
  category_name_en: string;
  rule: Pick<
    BenefitRule,
    'tier' | 'category_id' | 'discount_mode' | 'percent' | 'fixed_iqd' | 'max_discount_iqd' | 'cap_scope' | 'enabled'
  >;
}

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
  const [seeding, setSeeding] = useState(false);
  const [suggest, setSuggest] = useState<RecommendedEntry[] | null>(null);

  /**
   * «إضافة القيم المقترحة» — the owner's starting section rules (PRO printers
   * 10% up to 100,000 per unit, PREMIUM printers 25,000 per unit, …) against
   * the sections that exist in THIS store. Nothing is written on the click:
   * GET /recommended lists what would be created, a dialog shows each rule
   * (tier, section, figure, live or switched off), and only the confirmed
   * list is POSTed. The server never overwrites a tier and section that
   * already have a rule, and creates every non-printer suggestion switched off.
   */
  const previewRecommended = async () => {
    setSeeding(true);
    try {
      const out = await api.get<{ entries: RecommendedEntry[] }>('/api/admin/membership-benefits/recommended');
      const entries = out.entries ?? [];
      if (entries.length === 0) {
        notify(
          'info',
          loc(
            'لا شيء لإضافته: كل قسم مقترح له قاعدة بالفعل، أو لا يوجد قسم مطابق في المتجر.',
            'Nothing to add: every suggested section already has a rule, or the store has no matching section.'
          )
        );
      } else {
        setSuggest(entries);
      }
    } catch (e) {
      notify('bad', errMsg(e));
    } finally {
      setSeeding(false);
    }
  };

  const addRecommended = async (entries: RecommendedEntry[]) => {
    const out = await api.post<{ created: Array<{ id: string }> }>('/api/admin/membership-benefits/recommended', {
      keys: entries.map((e) => e.key),
    });
    await reload();
    setSuggest(null);
    const created = out.created?.length ?? 0;
    notify(
      created > 0 ? 'ok' : 'info',
      created > 0
        ? loc(`أُضيفت ${created} قاعدة مقترحة.`, `${created} recommended rules added.`)
        : loc(
            'لم يُضف شيء: أُضيفت قاعدة لهذه الأقسام في الأثناء.',
            'Nothing added: these sections were given a rule in the meantime.'
          )
    );
  };

  /** A suggested rule's figure, with the server's units. */
  const suggestedFigure = (rule: RecommendedEntry['rule']): string => {
    const parts: string[] = [];
    if (rule.discount_mode === 'percent' && rule.percent !== null) parts.push(fmtValue(schema, 'percent', rule.percent, loc));
    if (rule.discount_mode === 'fixed' && rule.fixed_iqd !== null) parts.push(fmtValue(schema, 'fixed_iqd', rule.fixed_iqd, loc));
    // A ceiling equal to the fixed amount says nothing the amount did not.
    if (rule.max_discount_iqd !== null && !(rule.discount_mode === 'fixed' && rule.fixed_iqd === rule.max_discount_iqd)) {
      parts.push(`${loc('حتى', 'up to')} ${fmtValue(schema, 'max_discount_iqd', rule.max_discount_iqd, loc)}`);
    }
    if (rule.cap_scope) parts.push(phrase(CAP_LABEL[rule.cap_scope], loc, rule.cap_scope));
    return parts.join(' · ');
  };

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
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={T.btnSecondary}
            onClick={() => void previewRecommended()}
            disabled={seeding}
            data-mb-recommended
          >
            <Sparkles className="w-4 h-4" aria-hidden />
            {loc('إضافة القيم المقترحة', 'Add recommended values')}
          </button>
          <button ref={addRef} type="button" className={T.btnPrimary} onClick={() => setEdit('new')} data-mb-add>
            <Plus className="w-4 h-4" aria-hidden />
            {loc('قاعدة جديدة', 'New rule')}
          </button>
        </div>
      </Toolbar>

      <ConsolidationPanel rules={rules} schema={schema} reload={reload} notify={notify} />

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

      {suggest && (
        <Dialog
          titleAr="إضافة القيم المقترحة"
          titleEn="Add recommended values"
          saveLabel={loc('إضافة', 'Add')}
          onClose={() => setSuggest(null)}
          onSave={() => addRecommended(suggest)}
          testId="add-recommended-benefit-rules"
        >
          <p className="text-[13px] text-[var(--ap-text-1)]">
            {loc('ستُنشأ هذه القواعد على أقسام المتجر:', 'These rules will be created on the store’s sections:')}
          </p>
          <ul className="space-y-1.5" data-mb-recommended-list>
            {suggest.map((e) => (
              <li key={e.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]" data-mb-recommended-entry={e.key}>
                <span className={`${T.badgeBase} ${tierChip(e.rule.tier)}`}>{tierName(e.rule.tier)}</span>
                <span className="font-semibold text-[var(--ap-text-1)]">
                  {loc(e.category_name_ar || e.rule.category_id || '', e.category_name_en || e.rule.category_id || '')}
                </span>
                <span className="tabular-nums text-[var(--ap-text-2)]">{suggestedFigure(e.rule)}</span>
                {e.rule.enabled ? (
                  <Badge tone="warn">{loc('تُطبَّق فورًا', 'Applies immediately')}</Badge>
                ) : (
                  <Badge tone="info">{loc('معطّلة — فعّلها بنفسك', 'Off — turn it on yourself')}</Badge>
                )}
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-[var(--ap-text-3)]">
            {loc(
              'قاعدتا الطابعات هما أرقامك وتُطبَّقان على الطلبات الجديدة فور الإضافة. أي اقتراح آخر يُنشأ معطّلًا ولا يخصم شيئًا حتى تراجعه وتفعّله. كل قاعدة قابلة للتعديل أو الحذف لاحقًا.',
              'The two printer rules are your figures and apply to new orders as soon as they are added. Any other suggestion is created switched off and discounts nothing until you review and enable it. Every rule can be edited or deleted later.'
            )}
          </p>
        </Dialog>
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
