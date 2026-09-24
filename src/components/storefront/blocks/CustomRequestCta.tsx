/**
 * CUSTOM REQUEST — «send us your model». A real door to the request board,
 * shown only while this store takes custom requests AND the board is open to
 * the visitor (it is Levo Community, and closes with it — DECISIONS row 110).
 */
import { Hammer } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useStorefrontRuntime } from '../runtime';
import { useStoreTheme } from '../StoreTheme';
import { Column, useText } from '../parts';
import { Paragraphs } from './Text';
import type { BlockProps } from '../types';

export default function CustomRequestCtaBlock({ block, store }: BlockProps<'custom_request_cta'>) {
  const s = block.settings;
  const { loc } = useLanguage();
  const text = useText();
  const rt = useStorefrontRuntime();
  const { accent } = useStoreTheme();
  if (!store.accepts_custom_requests || !rt.communityOpen) return null;
  return (
    <Column>
      <div className="sf-card p-5">
        <div className="flex items-center gap-2.5 mb-1.5">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center ${accent.chip}`}>
            <Hammer className="w-4 h-4" aria-hidden="true" />
          </div>
          <h2 className="sf-title text-white" dir="auto">
            {text(s.title) || loc('عندك تصميم؟ نطبعه لك', 'Have a design? We will print it')}
          </h2>
        </div>
        <Paragraphs
          text={text(s.body) || loc('ارفع ملفك واطلب عرض سعر — المبلغ يبقى محجوزًا حتى تستلم عملك.', 'Upload your file and request a quote — your money stays held until you receive the work.')}
          className="text-zinc-400 text-[12.5px] leading-relaxed"
        />
        <a
          href={rt.requestsHref}
          className={`inline-flex items-center justify-center min-h-[44px] px-5 mt-3.5 rounded-xl font-bold text-[13px] ${accent.btn} active:scale-[0.98] transition-transform`}
        >
          {text(s.label) || loc('اطلب عرض سعر', 'Request a quote', 'داوای نرخ بکە')}
        </a>
      </div>
      {/* OWNER: Sorani to be written by hand. */}
    </Column>
  );
}
