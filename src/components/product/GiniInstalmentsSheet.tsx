/**
 * «تريدها اقساط ؟» — the instalments door, which is not our door.
 *
 * WHAT THIS SHEET IS ALLOWED TO PROMISE. Gini (كي كارد / مصرف الرافدين)
 * finances the product INSIDE its own app; Levonis never lends anything, never
 * holds a limit and never collects an instalment. So the sheet states the one
 * condition the bank actually imposes — «الشروط يكون موظفا على مصرف الرافدين» —
 * and then gets out of the way with a single link to the product in the app.
 * A sheet that talked about monthly amounts or approval odds would be inventing
 * terms on a bank's behalf, which is the same mistake `CheaperElsewhereSheet`
 * refuses to make about price matching.
 *
 * THE CONDITION IS THE OWNER'S TEXT, NOT OURS. It arrives on
 * `/api/settings/public` as `giniPolicy.conditions` because it is a bank rule
 * that can widen without a deploy (worker/lib/settings.ts says the same from
 * the other side). The compiled sentences below are the fallback for a server
 * that predates the setting — never a translation of what the owner wrote,
 * which would drift the moment they edit one language.
 *
 * ONE BUTTON, AND IT IS A REAL LINK. `<a target="_blank">` rather than a
 * scripted `window.open`: the customer gets their browser's own long-press
 * menu, and `rel="noopener noreferrer"` keeps the opened page off our
 * `window.opener` and out of our referrer.
 */
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Overlay';
import { asLang } from '../orders/format';
import { ExternalLink } from 'lucide-react';

/**
 * The link as it may be rendered into an `href`, or '' for "do not offer this".
 *
 * `safeLink` (worker/lib/homeContent.ts) already dropped `javascript:` and
 * `data:` on the way in, and this repeats the test on the way out for the same
 * reason the server does it twice: a row edited around the app must not be able
 * to put a script URL under the customer's finger.
 *
 * It is DELIBERATELY STRICTER than `safeLink`, which also tolerates a single
 * relative path. A relative path here would open our own site in a new tab
 * under a button that says «افتح المنتج في تطبيق جني» — a promise the shop
 * cannot keep, which is exactly the case the caller must render nothing for.
 */
export function giniLinkOf(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^https?:\/\//i.test(value) ? value : '';
}

const STRINGS = {
  ar: {
    title: 'تريدها أقساط؟',
    intro: 'تشتري المنتج وتقسّطه داخل تطبيق جني (كي كارد — مصرف الرافدين)، وإحنا نوصّله لك.',
    conditionLabel: 'الشرط',
    /* Only reached when the server has no `giniPolicy` to send. */
    conditionFallback:
      'خدمة التقسيط عبر تطبيق جني متاحة لموظفي مصرف الرافدين. يتم شراء المنتج وتقسيطه داخل تطبيق جني، ويُدفع سعر التوصيل فقط عند الاستلام.',
    cta: 'افتح المنتج في تطبيق جني',
    close: 'إغلاق',
  },
  en: {
    title: 'Want it in instalments?',
    intro: 'You buy this product and pay for it in instalments inside the Gini app (Qi Card — Rafidain Bank), and we deliver it to you.',
    conditionLabel: 'Condition',
    conditionFallback:
      'Gini instalments are available to Rafidain Bank employees. The product is bought and financed inside the Gini app; only the delivery fee is paid on receipt.',
    cta: 'Open this product in the Gini app',
    close: 'Close',
  },
  ckb: {
    title: 'بە قیست دەتەوێت؟',
    intro: 'بەرهەمەکە لە ناو ئەپی جینی (کیو کارد — بانکی ڕافیدەین) دەکڕیت و قیستی دەکەیت، ئێمەش بۆت دەگەیەنین.',
    conditionLabel: 'مەرج',
    conditionFallback:
      'خزمەتگوزاری قیستی ئەپی جینی بۆ فەرمانبەرانی بانکی ڕافیدەین بەردەستە. بەرهەمەکە لە ناو ئەپی جینی دەکڕدرێت و قیست دەکرێت، تەنها کرێی گەیاندن لە کاتی وەرگرتن دەدرێت.',
    cta: 'کردنەوەی بەرهەمەکە لە ئەپی جینی',
    close: 'داخستن',
  },
} as const;

export default function GiniInstalmentsSheet({
  open,
  url,
  condition,
  onClose,
}: {
  open: boolean;
  /** Already through `giniLinkOf`; the caller renders nothing when it is ''. */
  url: string;
  /** `giniPolicy.conditions` in the viewer's language, or '' for the fallback. */
  condition?: string;
  onClose: () => void;
}) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const conditionText = (condition ?? '').trim() || s.conditionFallback;

  return (
    <Sheet open={open} onClose={onClose} label={s.title} panelClassName="w-full sm:max-w-md" testId="gini-instalments">
      <div className="px-5 pb-6 pt-2">
        <h2 className="text-white font-bold text-[16px]">{s.title}</h2>
        <p className="text-zinc-400 text-[13px] mt-2 leading-relaxed">{s.intro}</p>

        {/*
          The bank's rule, set apart by a quiet rule line rather than a tinted
          card: it is the one thing on this sheet that can disqualify the
          reader, so it must be findable — but a warning block would make an
          ordinary eligibility note read as an error.
        */}
        <div className="mt-4 border-s-2 border-white/15 ps-3">
          <div className="text-[11px] uppercase tracking-widest text-zinc-500">{s.conditionLabel}</div>
          <p className="text-zinc-300 text-[13px] mt-1 leading-relaxed">{conditionText}</p>
        </div>

        <div className="mt-5 space-y-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            data-gini-open
            className="lv-button lv-button-primary press-scale w-full"
          >
            <ExternalLink aria-hidden="true" className="w-4 h-4" strokeWidth={1.5} />
            {s.cta}
          </a>
          <button type="button" onClick={onClose} className="lv-button lv-button-secondary press-scale w-full">
            {s.close}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
