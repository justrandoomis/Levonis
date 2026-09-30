/**
 * «معاينة على هاتفي» (docs/MERCHANT_PLATFORM_V2.md storefront B3, P5) — the
 * draft, on the merchant's own phone, from a code on the desk's screen.
 *
 * WHAT THE CODE OPENS. The builder's own address with `?view=preview`: on a
 * phone the builder then opens on its Preview view, which renders the draft
 * from the owner-only reads (`GET /api/merchant/store/layout` and `GET
 * /preview`, both `private, no-store`, both behind `requireStoreOwner`). The
 * JSON route itself is no page a phone can show, and a public address of the
 * draft would be a leak — so the only thing a scanned code can open is the
 * workspace, which asks the phone to sign in as the store's owner first.
 * Customers never see a draft.
 *
 * The encoder is the repository's own (worker/lib/qr.ts through
 * share/shareStoreModel.ts `storeQr`), drawn true black on true white — the
 * one surface here with its own ground, or a camera cannot read it. Loaded
 * lazily when the button is pressed.
 */
import { useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import { Sheet } from '../../ui/Sheet';
import { Button } from '../../ui/Button';
import { storeQr } from '../share/shareStoreModel';
import { useMediaStrings } from './strings';

/** The builder's address, opened on its preview: same host, same path, `?view=preview`. */
export function previewAddress(loc: Pick<Location, 'origin' | 'pathname'>): string {
  return `${loc.origin}${loc.pathname}?view=preview`;
}

export default function PreviewQr({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useMediaStrings();
  const url = useMemo(() => (typeof window === 'undefined' ? '' : previewAddress(window.location)), []);
  const qr = useMemo(() => storeQr(url), [url]);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={t.qr.title}
      detents={['large']}
      panelClassName="sm:max-w-md"
      testId="sd-preview-qr"
      header={
        <div className="px-4 pb-2 pt-1 sm:pt-5">
          <h2 className="text-[15px] font-bold text-text-primary">{t.qr.title}</h2>
        </div>
      }
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t.qr.close}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 px-4 pb-5" data-sd-qr>
        <p className="text-[13px] leading-relaxed text-text-secondary">{t.qr.body}</p>
        {qr ? (
          <div className="flex justify-center">
            <div className="rounded-xl bg-snow p-3" role="img" aria-label={t.qr.alt}>
              <svg viewBox={`0 0 ${qr.viewBox} ${qr.viewBox}`} className="block h-[168px] w-[168px]" shapeRendering="crispEdges" aria-hidden="true" data-sd-qr-code>
                <rect width={qr.viewBox} height={qr.viewBox} fill="white" />
                <path d={qr.path} fill="black" />
              </svg>
            </div>
          </div>
        ) : (
          <p className="text-[12.5px] text-warning" role="status">
            {t.qr.unavailable}
          </p>
        )}
        <div className="space-y-2">
          <p className="break-all rounded-xl border border-border-subtle bg-surface px-3 py-2 text-[12px] text-text-secondary select-all" dir="ltr" data-sd-qr-url>
            {url}
          </p>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" icon={<Copy className="h-4 w-4" aria-hidden="true" />} onClick={() => void copy()}>
              {t.qr.copy}
            </Button>
            <span aria-live="polite" className={`text-[12px] ${copied === 'failed' ? 'text-warning' : 'text-text-muted'}`}>
              {copied === 'ok' ? t.qr.copied : copied === 'failed' ? t.qr.copyFailed : ''}
            </span>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
