/**
 * THE PREVIEW RUNTIME — the storefront's controls drawn, none of them live.
 *
 * The design panel and the builder (wave 4) render a draft with this: the
 * action row, the ⋯ menu and the service doors look as they will, and do
 * nothing; loaders fetch nothing; links go nowhere. Its own module so the
 * live storefront, which supplies real controls (src/pages/Storefront.tsx),
 * never downloads these.
 */
import { Hammer, Link2, MessageCircle, MessageCircleMore, MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLanguage } from '../../LanguageContext';
import { NO_HOST, type StorefrontRuntime } from './runtime';
import type { AccentClasses } from './theme';

function InertBack() {
  return null;
}

/** The ⋯ button, drawn; it opens nothing in a preview. */
function InertMenu() {
  return (
    <span className="w-[30px] h-[30px] rounded-full border border-white/20 bg-white/5 flex items-center justify-center text-white" aria-hidden="true">
      <MoreHorizontal className="w-4 h-4" strokeWidth={1.75} />
    </span>
  );
}

/** The action row, drawn without a single handler — the preview never acts. */
function InertProfileActions({ accent }: { accent: AccentClasses }) {
  const { loc } = useLanguage();
  return (
    <div dir="rtl" className="flex gap-4">
      <span className={`flex-1 h-[30px] rounded-xl font-semibold text-[13px] flex items-center justify-center gap-1.5 ${accent.btn}`}>
        <MessageCircleMore className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        {loc('تواصل مع المتجر', 'Contact the store', 'پەیوەندی بە فرۆشگا')}
      </span>
      <span className="relative flex-[1.08] min-w-0">
        <span className="w-full h-[30px] rounded-full font-medium text-[13px] flex items-center justify-center gap-1.5 px-9 border border-white/15 text-zinc-200">
          {loc('تابع', 'Follow', 'شوێنکەوتن')}
        </span>
        <span className="absolute left-0 top-0 h-[30px] w-9 flex items-center justify-center text-zinc-300" aria-hidden="true">
          <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} />
        </span>
      </span>
    </div>
  );
}

function InertServiceDoors({ accepts }: { accepts: boolean }) {
  const { loc } = useLanguage();
  return (
    <div className="grid grid-cols-2 gap-2">
      {accepts && (
        <span className="h-10 rounded-xl bg-olive text-white font-bold text-[12px] flex items-center justify-center gap-1.5">
          <Hammer className="w-3.5 h-3.5" aria-hidden="true" />
          {loc('اطلب عرض سعر', 'Request a quote', 'داوای نرخ بکە')}
        </span>
      )}
      <span className={`h-10 rounded-xl border border-white/10 bg-white/[0.03] text-zinc-200 font-bold text-[12px] flex items-center justify-center gap-1.5 ${accepts ? '' : 'col-span-2'}`}>
        <MessageCircle className="w-3.5 h-3.5" aria-hidden="true" />
        {loc('مراسلة المتجر', 'Message the store', 'نامە بۆ فرۆشگا')}
      </span>
    </div>
  );
}

function InertChatButton({ className = '', children }: { className?: string; children?: ReactNode }) {
  return <span className={className}>{children}</span>;
}

function InertInstallCard() {
  return null;
}

/** The runtime a preview renders with: every control drawn, none of them live. */
export function previewRuntime(overrides: Partial<StorefrontRuntime> = {}): StorefrontRuntime {
  return {
    ...NO_HOST,
    communityOpen: true,
    Back: InertBack,
    Menu: InertMenu,
    ProfileActions: InertProfileActions,
    ServiceDoors: InertServiceDoors,
    ChatButton: InertChatButton,
    InstallCard: InertInstallCard,
    ...overrides,
  };
}
