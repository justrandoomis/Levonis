import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Copy, Check, QrCode } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { Overlay } from '../ui/Overlay';
import { qrEncode, qrToSvgPath } from './qr';

/**
 * Profile QR modal — shows the member's REFERRAL LINK as a scannable QR
 * code, generated fully client-side (no network, no npm package).
 *
 * Deliberately limited payload: the referral share link only
 * (`/auth?ref=<code>` — the same link the referral card already displays).
 * Never a session token, email, phone number or any private identifier.
 * When the referral code is unavailable (load failure), the modal shows an
 * honest error state instead of a fabricated code.
 */

const STRINGS = {
  ar: {
    title: 'رمز الدعوة',
    subtitle: 'امسح الرمز لفتح رابط الدعوة الخاص بك — يحتوي على رمز الإحالة فقط، بلا أي بيانات خاصة.',
    unavailable: 'تعذر تحميل رمز الإحالة — لا يمكن إنشاء رمز QR الآن. حاول مرة أخرى لاحقًا.',
    copy: 'نسخ الرابط',
    copied: 'تم النسخ!',
    close: 'إغلاق',
    qrAlt: 'رمز QR لرابط الدعوة',
  },
  en: {
    title: 'Invite QR code',
    subtitle: 'Scan to open your referral link — it contains only your referral code, no private data.',
    unavailable: 'Your referral code could not be loaded — the QR code cannot be generated right now. Please try again later.',
    copy: 'Copy link',
    copied: 'Copied!',
    close: 'Close',
    qrAlt: 'QR code of your referral link',
  },
  ckb: {
    title: 'کۆدی QR بانگهێشت',
    subtitle: 'سکان بکە بۆ کردنەوەی لینکی بانگهێشتەکەت — تەنها کۆدی بانگهێشتەکەت لەخۆدەگرێت، هیچ داتایەکی تایبەت نییە.',
    unavailable: 'کۆدی بانگهێشت بار نەبوو — ئێستا ناتوانرێت کۆدی QR دروست بکرێت. دواتر هەوڵ بدەرەوە.',
    copy: 'کۆپیکردنی لینک',
    copied: 'کۆپی کرا!',
    close: 'داخستن',
    qrAlt: 'کۆدی QR بۆ لینکی بانگهێشت',
  },
};

export default function QrCodeModal({
  link,
  onClose,
}: {
  /** Referral share link, or null when it could not be loaded. */
  link: string | null;
  onClose: () => void;
}) {
  const { lang } = useLanguage();
  const m = useMotion();
  const s = STRINGS[lang] ?? STRINGS.ar;
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  /* --------------------------------------------------------------- the window

     AN `Overlay`, NOT A `Sheet`. A sheet is the right shape for something you
     answer and push back down with a thumb; this window is a thing you HOLD UP
     TO ANOTHER PHONE. The person is usually not touching it at all while it is
     open — someone else's camera is looking at it — so a panel that tracks a
     finger and can be thrown away by a stray downward swipe would be actively
     wrong here. It stays centred, where a camera pointed at the middle of the
     screen finds it, and it leaves only when it is actually dismissed.

     `solid`. This is the one window in the app that MUST NOT be glass. The QR
     modules have to stay true black on true white or a scanner loses the
     contrast and the code simply does not read; a translucent panel would put
     whatever the profile page is showing behind the quiet zone. So the material
     is opted out of and the panel brings its own ground — the same
     `bg-white dark:bg-[#1a1a1a]` it always had. Everything else about the
     window (the spring arrival, the symmetric exit, the scrim, Escape, the
     reduced-motion cross-fade) is unchanged by that.

     WHAT IT USED TO BE. Its own `fixed inset-0 z-[200]` with a
     `bg-black/70 backdrop-blur-sm` backdrop, mounted when `qrOpen` flipped and
     unmounted when it flipped back: no arrival, and no exit at all — the code
     was on the screen and then it was not. That is the worst case of the
     disappearing-window problem for a QR in particular, because the other
     person is still looking at the screen when it goes.

     A NOTE ON THE CLOSING PATH. Profile.tsx mounts this component behind
     `{qrOpen && …}`, so calling `onClose` immediately would unmount the whole
     subtree and the exit would never get to run. Hence the local `open` flag:
     every dismissal path lowers it, the panel plays its exit, and `onClose`
     fires when the travel is over. The conditions for closing are exactly the
     ones that were there before (the X, the scrim, Escape) — only the moment
     the parent's boolean clears has moved, by the length of the exit. */
  const [open, setOpen] = useState(true);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (open) return;
    // Long enough for the panel's spring to finish travelling, and no longer;
    // under reduced motion the whole thing is a short cross-fade instead.
    const t = window.setTimeout(onClose, m.reduced ? 180 : 380);
    return () => window.clearTimeout(t);
  }, [open, onClose, m.reduced]);

  const qr = useMemo(() => {
    if (!link) return null;
    try {
      const matrix = qrEncode(link);
      return { path: qrToSvgPath(matrix, 4), viewBox: matrix.size + 8 };
    } catch {
      // Payload too long/empty — honest failure, never a truncated code.
      return null;
    }
  }, [link]);

  // The close button takes focus on open, as it always did: it is the only
  // control a keyboard user needs while a code is being scanned, and the
  // primitive's own initial focus (the panel) runs first — a child's effects
  // flush before its parent's — so this still wins.
  // The Escape listener that used to live here is GONE: `Overlay` owns
  // Escape-to-close, and a second listener would have called `onClose` twice.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the visible link below stays selectable */
    }
  };

  return (
    <Overlay
      open={open}
      onClose={close}
      label={s.title}
      placement="center"
      z={200}
      solid
      testId="profile-qr"
      // Geometry and the opaque ground the QR needs; the padding that used to
      // sit on this box has moved inside, where the primitive's rounding and
      // shadow cannot be fought over.
      panelClassName="w-full max-w-xs bg-white dark:bg-[#1a1a1a] text-black dark:text-white"
    >
      <div className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-[15px] flex items-center gap-1.5">
            <QrCode className="w-4 h-4" strokeWidth={2} />
            {s.title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label={s.close}
            className="w-11 h-11 -me-2 flex items-center justify-center rounded-full text-zinc-500 hover:text-black dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {qr && link ? (
          <>
            <div className="bg-white rounded-xl p-3 mx-auto w-fit border border-black/10" role="img" aria-label={s.qrAlt}>
              {/* QR modules must stay dark-on-light in both themes to scan. */}
              <svg
                viewBox={`0 0 ${qr.viewBox} ${qr.viewBox}`}
                className="w-[200px] h-[200px]"
                shapeRendering="crispEdges"
                aria-hidden="true"
              >
                <rect width={qr.viewBox} height={qr.viewBox} fill="#ffffff" />
                <path d={qr.path} fill="#000000" />
              </svg>
            </div>
            <p className="text-[11px] text-zinc-500 text-center mt-3 leading-snug">{s.subtitle}</p>
            <p dir="ltr" className="text-[10px] font-mono text-zinc-600 dark:text-zinc-400 text-center mt-1.5 break-all select-all">
              {link}
            </p>
            <button
              type="button"
              onClick={copyLink}
              className="mt-3 w-full min-h-[44px] flex items-center justify-center gap-1.5 rounded-xl bg-olive text-[#BAA369] text-[13px] font-bold hover:opacity-90 active:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-opacity"
            >
              {copied ? <Check className="w-4 h-4" strokeWidth={3} /> : <Copy className="w-4 h-4" strokeWidth={2} />}
              {copied ? s.copied : s.copy}
            </button>
          </>
        ) : (
          <p className="text-[12px] text-zinc-500 text-center py-8 px-2 leading-relaxed" role="status">
            {s.unavailable}
          </p>
        )}
      </div>
    </Overlay>
  );
}
