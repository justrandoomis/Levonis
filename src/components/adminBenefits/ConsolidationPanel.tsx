/**
 * «تحويل إلى قاعدة قسم» — THE PER-PRODUCT RULES, OFFERED BACK AS ONE SECTION RULE.
 *
 * The owner states a membership discount on a section — «خصم 10% حتى 100,000
 * لكل وحدة» on printers — but the product editor and the import write one
 * PRODUCT rule per printer, so the store ends up with a list where the owner
 * meant a sentence. The server groups the per-product discount rules by tier,
 * section and identical terms (GET /consolidation), prices every product of
 * the section before and after with the checkout's own selector, and converts
 * a group in ONE versioned, audited batch (POST /consolidation).
 *
 * This panel only shows the server's plan and sends back the exact rule ids it
 * was shown. A group the server refuses (a different section rule already
 * exists, or a per-order limit that one rule would share) is listed with the
 * reason and no button, because "why can I not press this" is an answer too.
 */
import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import * as T from '../adminProducts/theme';
import { api } from '../../lib/api';
import { Badge, Dialog, errMsg, fmtN, useLoc, type NoticeState } from '../adminTaxonomy/shared';
import { CAP_LABEL, fmtValue, phrase, tierName, type BenefitRule, type BenefitSchema } from './shared';

export interface ConsolidationGroup {
  key: string;
  tier: 'prime' | 'pro';
  category_id: string;
  category_name_ar: string;
  category_name_en: string;
  terms: {
    discount_mode: 'percent' | 'fixed' | null;
    percent: number | null;
    fixed_iqd: number | null;
    max_discount_iqd: number | null;
    cap_scope: 'per_unit' | 'per_order' | null;
    max_quantity: number | null;
    min_subtotal_iqd: number | null;
    valid_from: string | null;
    valid_until: string | null;
  };
  rule_ids: string[];
  kept_rule_ids: string[];
  other_products_affected: number;
  mode: 'create' | 'delete_only' | 'blocked';
  reason: 'SECTION_RULE_EXISTS' | 'ORDER_WIDE_LIMIT' | null;
  existing_rule_id: string | null;
}

interface Plan {
  product_rule_count: number;
  groups: ConsolidationGroup[];
}

interface Props {
  /** The rules on screen; a new list means the plan may have moved. */
  rules: BenefitRule[];
  schema: BenefitSchema;
  reload: () => Promise<void>;
  notify: (tone: NoticeState['tone'], text: string) => void;
}

export default function ConsolidationPanel({ rules, schema, reload, notify }: Props) {
  const { loc } = useLoc();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConsolidationGroup | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<Plan>('/api/admin/membership-benefits/consolidation')
      .then((p) => {
        if (live) {
          setPlan(p);
          setErr(null);
        }
      })
      .catch((e) => {
        if (live) setErr(errMsg(e));
      });
    return () => {
      live = false;
    };
  }, [rules]);

  if (err) return <p className="text-[12px] text-[var(--ap-danger)]">{err}</p>;
  if (!plan || plan.product_rule_count === 0) return null;

  const section = (g: ConsolidationGroup) => loc(g.category_name_ar || g.category_id, g.category_name_en || g.category_id);

  /** The offer in words, each number with the server's unit. */
  const offer = (g: ConsolidationGroup): string => {
    const t = g.terms;
    const parts: string[] = [];
    if (t.discount_mode === 'percent' && t.percent !== null) parts.push(fmtValue(schema, 'percent', t.percent, loc));
    if (t.discount_mode === 'fixed' && t.fixed_iqd !== null) parts.push(fmtValue(schema, 'fixed_iqd', t.fixed_iqd, loc));
    if (t.max_discount_iqd !== null) {
      const scope = t.cap_scope ? ` ${phrase(CAP_LABEL[t.cap_scope], loc, t.cap_scope)}` : '';
      parts.push(`${loc('حتى', 'up to')} ${fmtValue(schema, 'max_discount_iqd', t.max_discount_iqd, loc)}${scope}`);
    }
    if (t.max_quantity !== null) parts.push(fmtValue(schema, 'max_quantity', t.max_quantity, loc));
    if (t.min_subtotal_iqd !== null) {
      parts.push(`${loc('من', 'from')} ${fmtValue(schema, 'min_subtotal_iqd', t.min_subtotal_iqd, loc)}`);
    }
    return parts.join(' · ');
  };

  const blockedWhy = (g: ConsolidationGroup): string =>
    g.reason === 'ORDER_WIDE_LIMIT'
      ? loc(
          'الحد لكل طلب أو حد الكمية يُحتسب مرة واحدة لكل قاعدة في الطلب، فدمج هذه القواعد في قاعدة واحدة يغيّر ما يوفّره الطلب.',
          'A per-order ceiling or a quantity limit is spent once per rule in an order, so folding these rules into one would change what an order saves.'
        )
      : loc(
          'للقسم قاعدة مفعّلة لهذه الفئة بقيم مختلفة — عدّلها بدل إنشاء قاعدة ثانية.',
          'The section already has an active rule for this tier with different values — edit it instead of adding a second one.'
        );

  const convert = async (g: ConsolidationGroup) => {
    await api.post('/api/admin/membership-benefits/consolidation', { key: g.key, rule_ids: g.rule_ids });
    await reload();
    setConfirm(null);
    notify(
      'ok',
      g.mode === 'delete_only'
        ? loc(
            `حُذفت ${fmtN(g.rule_ids.length)} قاعدة منتج مكرّرة؛ قاعدة القسم «${section(g)}» تغطيها. الطلبات السابقة لا تتغير.`,
            `${fmtN(g.rule_ids.length)} duplicate product rules deleted; the "${section(g)}" section rule covers them. Orders already placed are unchanged.`
          )
        : loc(
            `حُوّلت ${fmtN(g.rule_ids.length)} قاعدة منتج إلى قاعدة القسم «${section(g)}». الطلبات السابقة لا تتغير.`,
            `${fmtN(g.rule_ids.length)} product rules became the "${section(g)}" section rule. Orders already placed are unchanged.`
          )
    );
  };

  return (
    <section className={`${T.surface} p-4 space-y-3`} data-mb-consolidation>
      <div className="flex flex-wrap items-center gap-2">
        <Layers className="w-4 h-4 text-[var(--ap-text-3)]" aria-hidden />
        <h3 className="text-[13px] font-semibold text-[var(--ap-text-1)]">
          {loc(
            `${fmtN(plan.product_rule_count)} قاعدة خصم مكتوبة لكل منتج على حدة`,
            `${fmtN(plan.product_rule_count)} discount rules written per product`
          )}
        </h3>
      </div>
      <p className="text-[12px] text-[var(--ap-text-3)] max-w-[70ch]">
        {loc(
          'صفحة الاشتراك تذكر الخصم على القسم. القواعد المتطابقة في قسم واحد يمكن أن تصبح قاعدة قسم واحدة بالقيم نفسها، دون تغيير سعر أي منتج مشمول.',
          'The subscription page states a discount on its section. Identical rules in one section can become one section rule with the same values, without changing the price of any product they cover.'
        )}
      </p>

      {plan.groups.length > 0 && (
        <ul className="space-y-2">
          {plan.groups.map((g) => (
            <li
              key={g.key}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[var(--ap-border)] pt-2"
              data-mb-consolidation-group={g.category_id}
            >
              <Badge tone="accent">{tierName(g.tier)}</Badge>
              <span className="text-[13px] font-semibold text-[var(--ap-text-1)]">{section(g)}</span>
              <span className="text-[12.5px] text-[var(--ap-text-2)] tabular-nums">{offer(g)}</span>
              <span className="text-[11.5px] text-[var(--ap-text-3)]">
                {loc(`${fmtN(g.rule_ids.length)} منتج`, `${fmtN(g.rule_ids.length)} products`)}
              </span>
              {g.mode === 'blocked' ? (
                <span className="basis-full text-[11.5px] text-[var(--ap-text-3)]" data-mb-consolidation-blocked={g.reason ?? ''}>
                  {blockedWhy(g)}
                </span>
              ) : (
                <button
                  type="button"
                  className={`${T.btnSecondary} ms-auto`}
                  onClick={() => setConfirm(g)}
                  data-mb-consolidate={g.category_id}
                >
                  {loc('تحويل إلى قاعدة قسم', 'Convert to a section rule')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {confirm && (
        <Dialog
          titleAr="تحويل إلى قاعدة قسم"
          titleEn="Convert to a section rule"
          saveLabel={loc('تحويل', 'Convert')}
          onClose={() => setConfirm(null)}
          onSave={() => convert(confirm)}
          testId="consolidate-benefit-rules"
        >
          <p className="text-[13px] text-[var(--ap-text-1)]">
            {confirm.mode === 'delete_only'
              ? loc(
                  `للقسم «${section(confirm)}» قاعدة ${tierName(confirm.tier)} بالقيم نفسها (${offer(confirm)})، فتُحذف ${fmtN(confirm.rule_ids.length)} قاعدة منتج مكرّرة.`,
                  `The "${section(confirm)}" section already has a ${tierName(confirm.tier)} rule with these values (${offer(confirm)}), so ${fmtN(confirm.rule_ids.length)} duplicate product rules are deleted.`
                )
              : loc(
                  `تُنشأ قاعدة ${tierName(confirm.tier)} واحدة على القسم «${section(confirm)}» (${offer(confirm)}) وتُحذف ${fmtN(confirm.rule_ids.length)} قاعدة منتج.`,
                  `One ${tierName(confirm.tier)} rule is created on the "${section(confirm)}" section (${offer(confirm)}) and ${fmtN(confirm.rule_ids.length)} product rules are deleted.`
                )}
          </p>
          {confirm.other_products_affected > 0 && (
            <Badge tone="warn">
              {loc(
                `ستشمل القاعدة أيضًا ${fmtN(confirm.other_products_affected)} منتجًا آخر في هذا القسم يتغير خصمه.`,
                `The rule also reaches ${fmtN(confirm.other_products_affected)} other products in this section whose discount changes.`
              )}
            </Badge>
          )}
          {confirm.kept_rule_ids.length > 0 && (
            <p className="text-[12px] text-[var(--ap-text-3)]">
              {loc(
                `تبقى ${fmtN(confirm.kept_rule_ids.length)} قاعدة منتج كما هي، لأن حذفها يغيّر سعر منتجها.`,
                `${fmtN(confirm.kept_rule_ids.length)} product rules stay, because deleting them would change their product's price.`
              )}
            </p>
          )}
          <p className="text-[12px] text-[var(--ap-text-3)]">
            {loc(
              'تُكتب كل التغييرات معًا في نسخة إعدادات واحدة وتُسجَّل في سجل التغييرات. الطلبات السابقة لا تتغير.',
              'Every change is written together as one configuration change and recorded in the history. Orders already placed are unchanged.'
            )}
          </p>
        </Dialog>
      )}
    </section>
  );
}
