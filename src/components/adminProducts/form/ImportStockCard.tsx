/**
 * «إعداد المخزون للمنتج المستورد» — THE STOCK SETUP OF A PRODUCT THE CATALOGUE
 * IMPORT CREATED (Bambu import spec §B.10; DECISIONS row 241; owner decision
 * L-16). Shown in section ٣ only while the product's decision is
 * `not_configured`.
 *
 * WHY IT IS ASKED. An empty stock means "untracked, no limit" in this shop, so
 * an imported product priced as it stands would sell every combination without
 * a limit, for goods that may not be on a shelf. Its price cannot be published
 * (409 IMPORT_STOCK_NOT_CONFIGURED) until someone who edits stock chooses one
 * of the two answers:
 *   - «تتبّع الكمية»: every combination sells only the quantity in its stock —
 *     the server refuses (IMPORT_STOCK_TRACKED_EMPTY) while any of them has no
 *     number saved;
 *   - «بلا تتبّع (حسب الطلب)»: sold to order, no quantity limit.
 *
 * One choice, then one confirm (agency: nothing is written by tapping a row).
 * The rows are the finder's radio rows (one tabbable row, arrows move,
 * Space/Enter chooses), so the card brings no new control. Every sentence is
 * in ar / en / ckb; the refusal sentences are the contract's own
 * (packages/contracts/src/costRefusals.ts), read by code.
 */
import { useId, useState } from 'react';
import { Boxes, Infinity as Unlimited } from 'lucide-react';
import { api, ApiError } from '../../../lib/api';
import { contractRefusal, refusalLang, refusalText } from '../../../lib/refusalStrings';
import { useLanguage } from '../../../LanguageContext';
import { Button } from '../../ui/Button';
import ChoiceRows from '../../finder/ChoiceRows';
import type { ImportStockState } from '../types';

type Tri = { ar: string; en: string; ckb: string };

/** The card's own words (the title and the two choices are the spec's, §B.10). */
export const IMPORT_STOCK_STRINGS = {
  title: { ar: 'إعداد المخزون للمنتج المستورد', en: 'Stock setup for an imported product', ckb: 'ڕێکخستنی کۆگا بۆ بەرهەمی هاوردەکراو' },
  tracked: { ar: 'تتبّع الكمية', en: 'Track quantity', ckb: 'بەدواداچوونی بڕ' },
  untracked: { ar: 'بلا تتبّع (حسب الطلب)', en: 'Untracked (to order)', ckb: 'بێ بەدواداچوون (بەپێی داواکاری)' },
  trackedHint: {
    ar: 'تُباع كل تركيبة بالكمية المسجّلة في مخزونها فقط. سجّل الكميات واحفظ المنتج قبل الاعتماد.',
    en: 'Each combination sells only the quantity in its stock. Enter the quantities and save the product before you confirm.',
    ckb: 'هەر تێکەڵەیەک تەنها بە بڕی ناو کۆگاکەی دەفرۆشرێت. پێش پەسەندکردن بڕەکان بنووسە و بەرهەمەکە پاشەکەوت بکە.',
  },
  untrackedHint: {
    ar: 'يُباع حسب الطلب بلا حدّ للكمية، ولا يُتتبّع له مخزون.',
    en: 'Sold to order with no quantity limit; no stock is tracked.',
    ckb: 'بەپێی داواکاری دەفرۆشرێت بەبێ سنووری بڕ، و هیچ کۆگایەکی بۆ بەدواداچوون ناکرێت.',
  },
  confirm: { ar: 'اعتمد طريقة المخزون', en: 'Confirm the stock mode', ckb: 'شێوازی کۆگا پەسەند بکە' },
  saveFirst: {
    ar: 'احفظ تعديلاتك أولاً، ثم اعتمد طريقة المخزون.',
    en: 'Save your changes first, then confirm the stock mode.',
    ckb: 'سەرەتا گۆڕانکارییەکانت پاشەکەوت بکە، پاشان شێوازی کۆگا پەسەند بکە.',
  },
  done: {
    ar: 'اعتُمدت طريقة المخزون. يمكنك الآن نشر سعر المنتج.',
    en: "The stock mode is set. You can now publish the product's price.",
    ckb: 'شێوازی کۆگا دیاری کرا. ئێستا دەتوانیت نرخی بەرهەمەکە بڵاو بکەیتەوە.',
  },
  /** The save bar's way to the card, in place of «نشر» while the decision is missing. */
  open: { ar: 'إعداد المخزون', en: 'Stock setup', ckb: 'ڕێکخستنی کۆگا' },
} as const satisfies Record<string, Tri>;

export type ImportStockLang = 'ar' | 'en' | 'ckb';
export const importStockText = (key: keyof typeof IMPORT_STOCK_STRINGS, lang: ImportStockLang): string => IMPORT_STOCK_STRINGS[key][lang];

/** Is this product's price publish refused for its missing stock decision? */
export const importStockMissing = (s: ImportStockState | null | undefined): boolean => s?.decision === 'not_configured';

export default function ImportStockCard({
  productId,
  dirty,
  onDecided,
}: {
  productId: string;
  /** The form holds unsaved edits: «تتبّع الكمية» is judged on the SAVED stock, so the confirm waits. */
  dirty: boolean;
  onDecided: (next: ImportStockState) => void;
}) {
  const { lang } = useLanguage();
  const l: ImportStockLang = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
  const t = (key: keyof typeof IMPORT_STOCK_STRINGS) => importStockText(key, l);
  const titleId = useId();
  const [choice, setChoice] = useState<'tracked' | 'untracked' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const confirm = async () => {
    if (!choice || dirty) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.put<{ import_stock: ImportStockState }>(`/api/admin/products/${encodeURIComponent(productId)}/import-stock-decision`, {
        decision: choice,
      });
      onDecided(r.import_stock);
    } catch (e) {
      setError(contractRefusal(e, refusalLang(lang), e instanceof ApiError ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="lv-alert lv-alert-warning mb-3 space-y-3 px-3 py-3 text-[12px] leading-relaxed text-text-primary"
      data-import-stock="not_configured"
      aria-labelledby={titleId}
    >
      <div className="space-y-1">
        <h3 id={titleId} className="text-[13px] font-bold">
          {t('title')}
        </h3>
        <p className="text-text-secondary">{refusalText('IMPORT_STOCK_NOT_CONFIGURED', l)}</p>
      </div>
      <ChoiceRows
        labelledBy={titleId}
        mode="single"
        selected={choice ? [choice] : []}
        onChoose={(v) => {
          setChoice(v);
          setError('');
        }}
        options={[
          { value: 'tracked', title: t('tracked'), sub: t('trackedHint'), Icon: Boxes },
          { value: 'untracked', title: t('untracked'), sub: t('untrackedHint'), Icon: Unlimited },
        ]}
      />
      {dirty ? <p className="text-text-secondary" data-import-stock-save-first>{t('saveFirst')}</p> : null}
      {error ? (
        <p className="text-red-400" role="alert" data-import-stock-error>
          {error}
        </p>
      ) : null}
      <Button size="sm" variant="primary" disabled={!choice || dirty} loading={busy} onClick={confirm} data-import-stock-action="confirm">
        {t('confirm')}
      </Button>
    </section>
  );
}
