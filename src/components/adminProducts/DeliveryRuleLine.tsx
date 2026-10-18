/**
 * «قاعدة التوصيل: …» — the product form's read-only answer to "how is this
 * product's delivery priced?" (owner, 2026-10-18). The fee is set in ONE
 * place, «إدارة التوصيل»; this line asks the server which rule group applies
 * to the product (or, unsaved, to the sections chosen in the form) and links
 * to that rule.
 */
import { useEffect, useState } from 'react';
import { Truck } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

interface Resolved {
  group: { id: string } | null;
  summary: { ar: string; en: string; ckb: string };
}

export default function DeliveryRuleLine(props: { productId: string | null; categoryId: string | null; subCategoryId: string | null }) {
  const { lang, loc } = useLanguage();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams();
    if (props.productId) params.set('product_id', props.productId);
    if (props.categoryId) params.set('category_id', props.categoryId);
    if (props.subCategoryId) params.set('sub_category_id', props.subCategoryId);
    api
      .get<Resolved>(`/api/admin/delivery-policy/resolve?${params.toString()}`)
      .then((r) => {
        if (!live) return;
        setResolved(r);
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [props.productId, props.categoryId, props.subCategoryId]);

  const summary = resolved ? (lang === 'en' ? resolved.summary.en : lang === 'ckb' ? resolved.summary.ckb : resolved.summary.ar) : '';
  const href = `/admin?tab=delivery_pricing${resolved?.group ? `#rule-${encodeURIComponent(resolved.group.id)}` : ''}`;
  return (
    <div className="border-t border-border-subtle pt-3 mb-4 flex flex-wrap items-center gap-2 text-[12px]" data-form="delivery-rule">
      <Truck className="w-4 h-4 text-text-secondary shrink-0" aria-hidden />
      <span className="text-text-primary font-semibold">
        {loc('قاعدة التوصيل', 'Delivery rule', 'یاسای گەیاندن')}:{' '}
        <span className="font-normal" data-delivery-rule-summary>
          {failed ? loc('تعذّر التحميل', 'Could not load', 'بار نەکرا') : resolved ? summary : '…'}
        </span>
      </span>
      <a className="underline text-text-secondary" href={href} data-delivery-rule-link>
        {loc('تعديل في إدارة التوصيل', 'Edit in delivery management', 'دەستکاری لە بەڕێوەبردنی گەیاندن')}
      </a>
    </div>
  );
}
