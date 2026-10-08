/**
 * §19 ON THE STAGES TAB — «تبقى أرقام تسلسلية غير مرتبطة لهذا الطلب.», above
 * the path it blocks (the Gini panel's precedent), naming each unit still
 * missing a serial with a way straight to it. Drawn only while the owner's
 * gate applies to this order (`serials.gate.applies`): with the gate off a
 * missing serial holds nothing, and a red card would say otherwise.
 */
import { ArrowLeft, ArrowRight, ScanLine } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { refusalText } from '../../../lib/refusalStrings';
import { serialStrings } from './strings';
import type { GateMissing, OrderSerials } from './types';

export function missingLabel(m: GateMissing, lang: string): string {
  return `${m.product_name} · ${serialStrings(lang).unit(m.unit_index)}`;
}

/**
 * A missing unit as two quiet lines — the product (isolated, so a Latin name
 * never drags the separator across an Arabic line), then the unit.
 */
export function MissingUnit({ m, lang }: { m: GateMissing; lang: string }) {
  return (
    <span className="min-w-0 break-words">
      <span className="block text-[13px] font-semibold text-text-primary">
        <bdi>{m.product_name}</bdi>
      </span>
      <span className="block text-[12px] text-text-secondary">{serialStrings(lang).unit(m.unit_index)}</span>
    </span>
  );
}

export default function SerialsBlockerCard({
  serials,
  onGoTo,
}: {
  serials: OrderSerials | null | undefined;
  onGoTo: (m: GateMissing) => void;
}) {
  const { lang, dir } = useLanguage();
  const s = serialStrings(lang);
  if (!serials?.installed || !serials.gate?.applies) return null;
  const missing = serials.missing ?? [];
  if (missing.length === 0) return null;
  const Arrow = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as 'ar' | 'en' | 'ckb';
  return (
    <section role="status" className="rounded-2xl border border-warning/35 bg-warning/10 p-3.5" data-serial-blocker>
      <p className="flex items-start gap-2 text-[13.5px] font-bold text-text-primary">
        <ScanLine className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        {refusalText('SERIALS_REQUIRED', l, s.blockerIntro)}
      </p>
      <p className="mt-2 text-[12px] text-text-secondary">{s.blockerIntro}</p>
      <ul className="mt-1 divide-y divide-border-subtle">
        {missing.map((m) => (
          <li key={`${m.order_item_id}:${m.unit_index}`} className="flex items-center justify-between gap-3 py-1.5">
            <MissingUnit m={m} lang={lang} />
            <button
              type="button"
              onClick={() => onGoTo(m)}
              // Every row's button says WHICH unit (UX review #12): «اذهب إلى الوحدة» × n is no answer.
              aria-label={`${s.goToUnit} · ${missingLabel(m, lang)}`}
              className="inline-flex shrink-0 items-center gap-1 min-h-[44px] px-3 rounded-full text-[12.5px] font-semibold text-text-primary hover:bg-surface-selected focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
              data-serial-goto={`${m.order_item_id}:${m.unit_index}`}
            >
              {s.goToUnit}
              <Arrow className="h-3.5 w-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
