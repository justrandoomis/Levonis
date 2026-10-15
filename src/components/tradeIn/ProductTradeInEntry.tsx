/**
 * THE PRODUCT PAGE'S ENTRY (spec §10.2): «لديك جهاز قديم؟ استبدله بهذا» — one row, shown only when
 * the signed-in customer has a device they can trade in now AND this product is a listed device a
 * credit can buy (GET /api/trade-in/entry). Anything else — a guest, an older server, a refusal —
 * draws nothing. Its own lazy chunk: the product page carries only the import line.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Repeat } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api } from '../../lib/api';
import { useT } from './useT';

export default function ProductTradeInEntry({ productId }: { productId: string }) {
  const { t } = useT();
  const { dir } = useLanguage();
  const [show, setShow] = useState(false);
  useEffect(() => {
    let alive = true;
    setShow(false);
    api
      .get<{ eligible_units: number; target_ok: boolean }>(`/api/trade-in/entry?product_id=${encodeURIComponent(productId)}`, { mascot: 'silent' })
      .then((d) => alive && setShow(d.eligible_units > 0 && d.target_ok))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [productId]);
  if (!show) return null;
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <div className="pt-2">
      <Link
        to={`/trade-in?target=${encodeURIComponent(productId)}`}
        data-product-trade-in
        className="lv-surface flex min-h-[56px] items-center gap-3 p-3 text-start transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="lv-well flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-gold">
          <Repeat className="h-5 w-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-bold leading-5 text-text-primary">{t('entry.title')}</span>
          <span className="block text-[12px] text-text-secondary">{t('entry.sub')}</span>
        </span>
        <Chevron className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
      </Link>
    </div>
  );
}
