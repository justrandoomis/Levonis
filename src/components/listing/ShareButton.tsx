import React, { useEffect, useState } from 'react';
import { Check, Share } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { TopBarButton } from '../catalog/PageTopBar';

/**
 * Share this exact list — filters, sort and search are all in the URL, so the
 * link IS the list. The phone's own share sheet where there is one; otherwise
 * the link is copied and the icon turns into a check for two seconds, said
 * out loud to a screen reader. A refused share (the person closed the sheet)
 * is not an error.
 */
export default function ShareButton({ title }: { title: string }) {
  const { loc } = useLanguage();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const share = async () => {
    const url = window.location.href;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title, url });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      /* no clipboard permission: nothing to report beyond the unchanged icon */
    }
  };

  return (
    <>
      <TopBarButton label={loc('مشاركة هذه القائمة', 'Share this list')} onClick={() => void share()}>
        {copied ? <Check aria-hidden="true" className="size-[18px] text-success" /> : <Share aria-hidden="true" className="size-[18px]" />}
      </TopBarButton>
      <span role="status" className="sr-only">
        {/* OWNER: Sorani to be written by hand (both strings of this file). */}
        {copied ? loc('نُسخ الرابط', 'Link copied') : ''}
      </span>
    </>
  );
}
